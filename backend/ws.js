const { WebSocketServer } = require("ws");
const config = require("./config");
const auth = require("./auth");

const GRACE_MS = 20_000;
const MAX_MSG_PER_SEC = 200;

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
let hostWs = null;

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

function pushHost() {
  const s = auth.activeSession();
  send(hostWs, {
    type: "peer",
    connected: !!clientSocket(s),
    sharing: !!(s && s.sharing),
  });
}

function pushClient() {
  const s = auth.activeSession();
  send(clientSocket(s), { type: "peer", hostPresent: isOpen(hostWs) });
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
    for (const old of session.sockets)
      safeClose(old, 4002, "aperta in un'altra scheda");
    session.sockets.clear();
  }
  session.sockets.add(ws);

  send(ws, {
    type: "hello",
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
        pushHost();
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
    if (!msg || msg.type !== "signal" || !validSignal(msg)) return;
    const target = clientSocket(auth.activeSession());
    send(target, { type: "signal", pc: msg.pc, data: msg.data });
  });

  const cleanup = () => {
    if (hostWs === ws) {
      hostWs = null;
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

    if (pathname === "/ws/host") {
      if (!auth.isHostRequest(req)) return reject(404, "Not Found");
      return wss.handleUpgrade(req, socket, head, (ws) => onHost(ws));
    }

    return reject(404, "Not Found");
  });
}

auth.events.on("end", ({ session, reason }) => {
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
