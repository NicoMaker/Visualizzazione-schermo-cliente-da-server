const { WebSocketServer } = require("ws");
const config = require("./config");
const auth = require("./auth");

const crypto = require("crypto");

const GRACE_MS = 20_000;
const MAX_MSG_PER_SEC = 200;
const AGENT_CODE_TTL_MS = 5 * 60 * 1000; // validità del codice per il programma di controllo
const CONTROL_REQUEST_TTL_MS = 30 * 1000; // il cliente ha 30 s per rispondere alla richiesta
const AGENT_PAIR_TIMEOUT_MS = 10 * 1000;
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // niente O/0/I/1/L

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
let hostWs = null;

const selfSigned = config.HTTPS && !(config.CERT_FILE && config.KEY_FILE);

function newAgentCode() {
  let out = "";
  for (let i = 0; i < 8; i++)
    out += CODE_ALPHABET[crypto.randomInt(0, CODE_ALPHABET.length)];
  return out;
}

const agentSocket = (session) =>
  session && isOpen(session.agent) ? session.agent : null;

const isOpen = (ws) => !!ws && ws.readyState === ws.OPEN;
const send = (ws, obj) => {
  if (isOpen(ws)) ws.send(JSON.stringify(obj));
};
const safeClose = (ws, code, reason) => {
  try {
    ws.close(code, String(reason || "").slice(0, 60));
  } catch {
    /* già chiuso */
  }
};

function clientSocket(session) {
  if (!session) return null;
  for (const ws of session.sockets) if (isOpen(ws)) return ws;
  return null;
}

function controlState(s) {
  return {
    agent: !!agentSocket(s),
    agentScreen: s && s.agentScreen ? s.agentScreen : null,
    surface: (s && s.surface) || null,
    control: (s && s.control) || "off",
  };
}

function pushHost() {
  const s = auth.activeSession();
  send(hostWs, {
    type: "peer",
    connected: !!clientSocket(s),
    sharing: !!(s && s.sharing),
    ...controlState(s),
  });
}

function pushClient() {
  const s = auth.activeSession();
  send(clientSocket(s), {
    type: "peer",
    hostPresent: isOpen(hostWs),
    ...controlState(s),
  });
}

/** Spegne il controllo remoto (in ogni caso) e avvisa tutti. */
function stopControl(session, reason) {
  if (!session) return;
  clearTimeout(session.controlTimer);
  const was = session.control || "off";
  session.control = "off";
  if (was === "off") return;
  send(agentSocket(session), { type: "control", active: false, reason });
  send(hostWs, { type: "control-ended", reason: reason || "" });
  send(clientSocket(session), { type: "control-ended", reason: reason || "" });
  pushHost();
  pushClient();
}

/** Controlla e normalizza un evento di input del host (mai fidarsi del contenuto). */
const num = (v, min, max) =>
  typeof v === "number" && Number.isFinite(v)
    ? Math.min(max, Math.max(min, v))
    : null;

function cleanInput(ev) {
  if (!ev || typeof ev !== "object") return null;
  switch (ev.k) {
    case "move": {
      const x = num(ev.x, 0, 1);
      const y = num(ev.y, 0, 1);
      return x === null || y === null ? null : { k: "move", x, y };
    }
    case "down":
    case "up": {
      const x = num(ev.x, 0, 1);
      const y = num(ev.y, 0, 1);
      const b = [0, 1, 2].includes(ev.b) ? ev.b : null;
      return x === null || y === null || b === null
        ? null
        : { k: ev.k, x, y, b };
    }
    case "wheel": {
      const dx = num(ev.dx, -2000, 2000);
      const dy = num(ev.dy, -2000, 2000);
      return dx === null || dy === null ? null : { k: "wheel", dx, dy };
    }
    case "key": {
      if (typeof ev.code !== "string" || ev.code.length > 24) return null;
      if (typeof ev.key !== "string" || ev.key.length > 24) return null;
      return { k: "key", d: !!ev.d, code: ev.code, key: ev.key };
    }
    default:
      return null;
  }
}

function limiter(ws) {
  let windowStart = Date.now();
  let count = 0;
  ws.allow = () => {
    const now = Date.now();
    if (now - windowStart > 1000) {
      windowStart = now;
      count = 0;
    }
    return ++count <= MAX_MSG_PER_SEC;
  };
}

function parse(raw, isBinary) {
  if (isBinary) return null;
  try {
    const msg = JSON.parse(raw.toString());
    return msg && typeof msg.type === "string" ? msg : null;
  } catch {
    return null;
  }
}

const validSignal = (msg) =>
  typeof msg.pc === "string" &&
  /^[A-Za-z0-9_-]{1,40}$/.test(msg.pc) &&
  msg.data &&
  typeof msg.data === "object";

function onClient(ws, session) {
  limiter(ws);
  ws.session = session;
  ws.isAlive = true;

  clearTimeout(session.graceTimer);
  if (session.sockets.size) {
    session.sharing = false;
    session.surface = null;
    stopControl(session, "pagina riaperta");
    for (const old of session.sockets)
      safeClose(old, 4002, "aperta in un'altra scheda");
    session.sockets.clear();
  }
  session.sockets.add(ws);
  if (session.control === undefined) session.control = "off";

  send(ws, {
    type: "hello",
    selfSigned,
    ice: config.ICE_SERVERS,
    maxFps: config.MAX_FPS,
    maxBitrate: config.MAX_BITRATE_KBPS * 1000,
    hostPresent: isOpen(hostWs),
  });
  pushHost();

  ws.on("message", (raw, isBinary) => {
    if (!ws.allow()) return;
    const msg = parse(raw, isBinary);
    if (!msg) return;
    auth.touch(session.id);

    switch (msg.type) {
      case "sharing":
        session.sharing = !!msg.active;
        session.surface = ["monitor", "window", "browser"].includes(msg.surface)
          ? msg.surface
          : null;
        if (!session.sharing)
          stopControl(session, "il cliente ha smesso di condividere");
        pushHost();
        pushClient();
        break;
      case "agent-code": {
        // il cliente chiede un codice da scrivere nel programma di controllo
        session.agentCode = {
          code: newAgentCode(),
          expiresAt: Date.now() + AGENT_CODE_TTL_MS,
        };
        send(ws, {
          type: "agent-code",
          code: session.agentCode.code,
          ttl: AGENT_CODE_TTL_MS / 1000,
        });
        break;
      }
      case "control-answer":
        if (session.control !== "requested") break;
        clearTimeout(session.controlTimer);
        if (!msg.allow) {
          session.control = "off";
          send(hostWs, { type: "control-ended", reason: "il cliente ha rifiutato" });
        } else if (
          !agentSocket(session) ||
          !session.sharing ||
          session.surface !== "monitor"
        ) {
          session.control = "off";
          send(hostWs, {
            type: "control-ended",
            reason: "condizioni non più valide (programma o schermo intero mancante)",
          });
        } else {
          session.control = "on";
          send(agentSocket(session), { type: "control", active: true });
        }
        pushHost();
        pushClient();
        break;
      case "control-stop":
        stopControl(session, "il cliente ha revocato il controllo");
        break;
      case "signal":
        if (validSignal(msg))
          send(hostWs, { type: "signal", pc: msg.pc, data: msg.data });
        break;
      default:
    }
  });

  const cleanup = () => {
    if (!session.sockets.delete(ws)) return;
    stopControl(session, "il cliente ha lasciato la pagina");
    pushHost();
    if (session.sockets.size === 0) {
      clearTimeout(session.graceTimer);
      session.graceTimer = setTimeout(() => {
        if (session.sockets.size === 0)
          auth.endSession(session.id, "il cliente ha lasciato la pagina");
      }, GRACE_MS);
    }
  };
  ws.on("close", cleanup);
  ws.on("error", cleanup);
}

function onHost(ws) {
  limiter(ws);
  ws.isAlive = true;

  if (hostWs && hostWs !== ws)
    safeClose(hostWs, 4002, "aperto in un'altra scheda");
  hostWs = ws;

  send(ws, { type: "hello", ice: config.ICE_SERVERS });
  pushHost();
  pushClient();

  ws.on("message", (raw, isBinary) => {
    if (!ws.allow()) return;
    const msg = parse(raw, isBinary);
    if (!msg) return;
    const session = auth.activeSession();

    switch (msg.type) {
      case "signal":
        if (validSignal(msg))
          send(clientSocket(session), {
            type: "signal",
            pc: msg.pc,
            data: msg.data,
          });
        break;

      case "control-request": {
        const fail = (reason) => send(ws, { type: "control-ended", reason });
        if (!clientSocket(session)) return fail("nessun cliente collegato");
        if (!session.sharing) return fail("il cliente non sta condividendo");
        if (session.surface !== "monitor")
          return fail("il cliente non condivide l'intero schermo");
        if (!agentSocket(session))
          return fail("il programma di controllo non è collegato");
        if (session.control !== "off") return;
        session.control = "requested";
        clearTimeout(session.controlTimer);
        session.controlTimer = setTimeout(() => {
          if (session.control === "requested")
            stopControl(session, "il cliente non ha risposto");
        }, CONTROL_REQUEST_TTL_MS);
        send(clientSocket(session), { type: "control-request" });
        pushHost();
        pushClient();
        break;
      }

      case "control-stop":
        stopControl(session, "il tecnico ha terminato il controllo");
        break;

      case "input": {
        if (!session || session.control !== "on") return;
        const ev = cleanInput(msg.ev);
        if (ev) {
          auth.touch(session.id);
          send(agentSocket(session), { type: "input", ev });
        }
        break;
      }
      default:
    }
  });

  const cleanup = () => {
    if (hostWs === ws) {
      hostWs = null;
      stopControl(auth.activeSession(), "il tecnico si è scollegato");
      pushClient();
    }
  };
  ws.on("close", cleanup);
  ws.on("error", cleanup);
}

/** Programma di controllo sul PC del cliente: si associa alla sessione con il codice che il cliente ha chiesto. */
function onAgent(ws, req) {
  limiter(ws);
  ws.isAlive = true;
  const ip = auth.clientIp(req);
  let paired = null;

  const pairTimer = setTimeout(() => {
    if (!paired) safeClose(ws, 4003, "nessun codice");
  }, AGENT_PAIR_TIMEOUT_MS);

  ws.on("message", (raw, isBinary) => {
    if (!ws.allow()) return;
    const msg = parse(raw, isBinary);
    if (!msg) return;

    if (!paired) {
      if (msg.type !== "pair") return;
      if (auth.lockedFor(ip)) return safeClose(ws, 4004, "troppi tentativi");
      const session = auth.activeSession();
      const ac = session && session.agentCode;
      const code = typeof msg.code === "string" ? msg.code.trim().toUpperCase() : "";
      if (!ac || Date.now() > ac.expiresAt || !auth.safeEqual(code, ac.code)) {
        auth.registerFail(ip);
        send(ws, { type: "pair-error", reason: "codice errato o scaduto" });
        return safeClose(ws, 4005, "codice errato");
      }
      auth.clearFails(ip);
      session.agentCode = null; // monouso
      if (session.agent && session.agent !== ws)
        safeClose(session.agent, 4002, "sostituito");
      session.agent = ws;
      session.agentScreen =
        Number.isInteger(msg.w) && Number.isInteger(msg.h) && msg.w > 0 && msg.h > 0
          ? { w: msg.w, h: msg.h }
          : null;
      paired = session;
      clearTimeout(pairTimer);
      send(ws, { type: "paired" });
      pushHost();
      pushClient();
      return;
    }

    auth.touch(paired.id);
    if (msg.type === "stop") stopControl(paired, "il cliente ha fermato il programma");
  });

  const cleanup = () => {
    clearTimeout(pairTimer);
    if (paired && paired.agent === ws) {
      paired.agent = null;
      paired.agentScreen = null;
      stopControl(paired, "il programma di controllo si è chiuso");
      pushHost();
      pushClient();
    }
  };
  ws.on("close", cleanup);
  ws.on("error", cleanup);
}

function attachWebSocket(server) {
  server.on("upgrade", (req, socket, head) => {
    const reject = (code, text) => {
      socket.write(`HTTP/1.1 ${code} ${text}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };

    let pathname;
    try {
      pathname = new URL(req.url, "http://localhost").pathname;
    } catch {
      return reject(400, "Bad Request");
    }

    const origin = req.headers.origin;
    if (origin) {
      try {
        if (new URL(origin).host !== req.headers.host)
          return reject(403, "Forbidden");
      } catch {
        return reject(403, "Forbidden");
      }
    }

    if (pathname === "/ws/share") {
      const sid = auth.parseCookies(req.headers.cookie)[auth.COOKIE_NAME];
      const session = auth.getSession(sid);
      if (!session) return reject(401, "Unauthorized");
      return wss.handleUpgrade(req, socket, head, (ws) =>
        onClient(ws, session),
      );
    }

    if (pathname === "/ws/agent") {
      return wss.handleUpgrade(req, socket, head, (ws) => onAgent(ws, req));
    }

    if (pathname === "/ws/host") {
      if (!auth.isLocalRequest(req)) return reject(404, "Not Found");
      return wss.handleUpgrade(req, socket, head, (ws) => onHost(ws));
    }

    return reject(404, "Not Found");
  });
}

auth.events.on("end", ({ session, reason }) => {
  clearTimeout(session.controlTimer);
  session.control = "off";
  if (session.agent) safeClose(session.agent, 4001, reason);
  session.agent = null;
  for (const ws of session.sockets) safeClose(ws, 4001, reason);
  session.sockets.clear();
  pushHost();
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 20_000).unref();

wss.on("connection", (ws) => {
  ws.on("pong", () => {
    ws.isAlive = true;
    if (ws.session) auth.touch(ws.session.id);
  });
});

module.exports = { attachWebSocket };
