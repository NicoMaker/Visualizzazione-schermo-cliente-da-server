const http = require("http");
const https = require("https");
const path = require("path");
const fs = require("fs");
const express = require("express");
const cron = require("node-cron");

const config = require("./config");
const auth = require("./auth");
const trash = require("./trash");
const tls = require("./tls");
const { attachWebSocket } = require("./ws");
const { getLocalIP, getPublicIP } = require("./network");

const { PORT } = config;
const app = express();

const net = { publicIP: "non disponibile", localIP: "127.0.0.1" };
const scheme = config.HTTPS ? "https" : "http";

app.disable("x-powered-by");

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=(), display-capture=(self)",
  );
  res.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; img-src 'self' data: blob:; media-src 'self' blob:; style-src 'self'; script-src 'self'; connect-src 'self' ws: wss:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  );
  if (!req.path.startsWith("/static/"))
    res.setHeader("Cache-Control", "no-store");
  next();
});

app.use(express.json({ limit: "4kb" }));
app.use("/static/css", express.static(config.CSS_DIR));
app.use("/static/js", express.static(config.JS_DIR));

function page(res, name, status = 200) {
  res
    .status(status)
    .sendFile(path.join(config.HTML_DIR, name), { cacheControl: false });
}

function sameOrigin(req, res, next) {
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host)
        return res.status(403).json({ ok: false });
    } catch {
      return res.status(403).json({ ok: false });
    }
  }
  if (
    !String(req.headers["content-type"] || "").startsWith("application/json")
  ) {
    return res.status(415).json({ ok: false });
  }
  next();
}

function requireLocal(req, res, next) {
  if (!auth.isLocalRequest(req)) return notFound(req, res);
  next();
}

function notFound(req, res) {
  page(res, "404.html", 404);
}

function cookieFlags(req) {
  const flags = ["Path=/", "HttpOnly", "SameSite=Strict"];
  if (config.COOKIE_SECURE || (req.socket && req.socket.encrypted))
    flags.push("Secure");
  return flags;
}

function setSessionCookie(req, res, id) {
  res.setHeader(
    "Set-Cookie",
    [`${auth.COOKIE_NAME}=${id}`, ...cookieFlags(req)].join("; "),
  );
}

function clearSessionCookie(req, res) {
  res.setHeader(
    "Set-Cookie",
    [`${auth.COOKIE_NAME}=`, ...cookieFlags(req), "Max-Age=0"].join("; "),
  );
}

const sessionFrom = (req) =>
  auth.getSession(auth.parseCookies(req.headers.cookie)[auth.COOKIE_NAME]);

function buildLinks() {
  const t = auth.getToken();
  const base = config.PUBLIC_URL;
  const localUrl = `${scheme}://${net.localIP}:${PORT}/c/${t}`;
  const localhostUrl = `${scheme}://localhost:${PORT}/c/${t}`;
  return {
    public: base
      ? `${base}/c/${t}`
      : net.publicIP !== "non disponibile"
        ? `${scheme}://${net.publicIP}:${PORT}/c/${t}`
        : localUrl,
    local: localUrl,
    localhost: localhostUrl,
  };
}

app.get("/", (req, res) => {
  page(res, "index.html");
});

/* Programma di controllo remoto (facoltativo): scaricabile solo dal cliente già autenticato. */
const AGENT_DIR = path.join(__dirname, "..", "agent");
const AGENT_FILES = new Set(["agent.js", "package.json"]);

/*
 * Pacchetto Windows pronto all'uso (agent.exe + libreria nativa in uno zip),
 * generato una volta dal tecnico con `node agent/build-win.js` (vedi README).
 * Se il file non esiste, il pannello mostra solo le istruzioni Node.js.
 * Queste due route hanno un percorso fisso e DEVONO stare prima di
 * "/agent/:file" qui sotto, altrimenti Express le farebbe matchare lì
 * (con :file = "windows-available" / "windows.zip") e restituirebbe sempre 404.
 */
const AGENT_WIN_ZIP = path.join(AGENT_DIR, "dist", "agente-windows.zip");
app.get("/agent/windows-available", (req, res) => {
  if (!sessionFrom(req)) return notFound(req, res);
  res.json({ available: fs.existsSync(AGENT_WIN_ZIP) });
});
app.get("/agent/windows.zip", (req, res) => {
  if (!sessionFrom(req) || !fs.existsSync(AGENT_WIN_ZIP)) return notFound(req, res);
  res.download(AGENT_WIN_ZIP, "DesktopRemoto-Windows.zip");
});

app.get("/agent/:file", (req, res) => {
  if (!sessionFrom(req) || !AGENT_FILES.has(req.params.file))
    return notFound(req, res);
  res.download(path.join(AGENT_DIR, req.params.file), req.params.file);
});

app.get("/c/:token", (req, res) => {
  const ip = auth.clientIp(req);
  if (auth.lockedFor(ip)) return page(res, "429.html", 429);
  if (!auth.checkToken(req.params.token)) {
    auth.registerFail(ip);
    return notFound(req, res);
  }
  if (sessionFrom(req)) return res.redirect("/share");
  page(res, "login.html");
});

app.post("/api/login", sameOrigin, (req, res) => {
  const ip = auth.clientIp(req);
  const wait = auth.lockedFor(ip);
  if (wait) {
    return res.status(429).json({
      ok: false,
      error: `Troppi tentativi. Riprova tra ${wait} secondi.`,
      retryAfter: wait,
    });
  }

  const { token, otp } = req.body || {};
  if (!auth.checkToken(token)) {
    auth.registerFail(ip);
    return res.status(404).json({ ok: false, error: "Link non valido." });
  }
  if (typeof otp !== "string" || !/^\d{6}$/.test(otp)) {
    return res
      .status(400)
      .json({ ok: false, error: "Inserisci le 6 cifre del codice." });
  }
  if (!auth.verifyOtp(otp)) {
    auth.registerFail(ip);
    const locked = auth.lockedFor(ip);
    return res.status(401).json({
      ok: false,
      error: locked
        ? `Troppi tentativi. Riprova tra ${locked} secondi.`
        : "Codice errato o scaduto.",
      retryAfter: locked || undefined,
    });
  }

  auth.clearFails(ip);
  const session = auth.createSession(ip, req.headers["user-agent"]);
  setSessionCookie(req, res, session.id);
  res.json({ ok: true, redirect: "/share" });
});

app.get("/share", (req, res) => {
  const session = sessionFrom(req);
  if (!session) return res.redirect("/");
  auth.touch(session.id);
  page(res, "share.html");
});

app.post("/api/logout", sameOrigin, (req, res) => {
  const session = sessionFrom(req);
  if (session)
    auth.endSession(session.id, "il cliente ha interrotto la condivisione");
  clearSessionCookie(req, res);
  res.json({ ok: true });
});

app.get("/host", requireLocal, (req, res) => {
  page(res, "host.html");
});

app.get("/api/host/state", requireLocal, (req, res) => {
  const o = auth.currentOtp();
  const s = auth.activeSession();
  res.json({
    otp: {
      code: o.code,
      remaining: Math.max(0, Math.ceil((o.expiresAt - Date.now()) / 1000)),
      ttl: config.OTP_TTL_SECONDS,
    },
    links: buildLinks(),
    tokenFixed: !!config.ACCESS_TOKEN,
    selfSigned: config.HTTPS && !(config.CERT_FILE && config.KEY_FILE),
    session: s
      ? {
          ip: s.ip,
          browser: s.userAgent,
          since: s.createdAt,
          lastSeen: s.lastSeen,
          sharing: s.sharing,
        }
      : null,
  });
});

app.post("/api/host/disconnect", requireLocal, sameOrigin, (req, res) => {
  const s = auth.activeSession();
  if (s) auth.endSession(s.id, "disconnesso dall'host");
  res.json({ ok: true });
});

app.post("/api/host/otp", requireLocal, sameOrigin, (req, res) => {
  auth.newOtp();
  res.json({ ok: true });
});

app.post("/api/host/link", requireLocal, sameOrigin, (req, res) => {
  if (config.ACCESS_TOKEN) {
    return res.status(409).json({
      ok: false,
      error: "Il link è fisso (ACCESS_TOKEN nel file .env).",
    });
  }
  auth.regenerateToken();
  res.json({ ok: true });
});

app.use(notFound);
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err && err.type === "entity.parse.failed") {
    return res.status(400).json({ ok: false, error: "Richiesta non valida." });
  }
  console.error("⚠️  Errore:", err && err.message);
  page(res, "500.html", 500);
});

auth.events.on("start", (s) => {
  console.log(`🔓 Un cliente si è collegato da ${s.ip}`);
});
auth.events.on("end", ({ session, reason }) => {
  trash.archiveSession(session, reason);
  console.log(`🔒 Sessione di ${session.ip} chiusa (${reason})`);
});

function listen(server, port, host) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
}

async function start() {
  trash.ensureDir();
  auth.loadToken();
  net.localIP = getLocalIP();
  net.publicIP = await getPublicIP();

  let main;
  let selfSigned = false;
  if (config.HTTPS) {
    const names = ["localhost", "127.0.0.1", net.localIP];
    if (net.publicIP !== "non disponibile") names.push(net.publicIP);
    if (config.PUBLIC_URL) {
      try {
        names.push(new URL(config.PUBLIC_URL).hostname);
      } catch {
        /* PUBLIC_URL non valido: ignorato */
      }
    }
    const creds = await tls.loadCredentials(names);
    selfSigned = creds.selfSigned;
    main = https.createServer({ key: creds.key, cert: creds.cert }, app);
  } else {
    main = http.createServer(app);
  }
  attachWebSocket(main);

  let local = null;
  if (config.HTTPS && config.LOCAL_HTTP_PORT) {
    local = http.createServer(app);
    attachWebSocket(local);
  }

  cron.schedule(
    "0 0 * * *",
    () => {
      const n = trash.purge();
      console.log(`🗑️  Cestino svuotato (${n} elementi eliminati)`);
    },
    { timezone: config.TZ },
  );

  try {
    await listen(main, PORT, "0.0.0.0");
    if (local) await listen(local, config.LOCAL_HTTP_PORT, "0.0.0.0");
  } catch (err) {
    if (err.code === "EADDRINUSE") {
      console.error(
        `❌ La porta ${err.port || PORT} è già in uso. Cambia PORT (o LOCAL_HTTP_PORT) nel file .env`,
      );
    } else {
      console.error("❌ Errore server:", err.message);
    }
    process.exit(1);
  }

  const hostUrls = local
    ? [
        `http://localhost:${config.LOCAL_HTTP_PORT}/host`,
        `http://${net.localIP}:${config.LOCAL_HTTP_PORT}/host`,
      ]
    : [
        `${scheme}://localhost:${PORT}/host`,
        `${scheme}://${net.localIP}:${PORT}/host`,
      ];
  const links = buildLinks();

  console.log(`\n🚀 Server avviato con successo!`);
  console.log(`🌐 IP Pubblico: ${scheme}://${net.publicIP}:${PORT}`);
  console.log(`🏠 IP Locale:   ${scheme}://${net.localIP}:${PORT}`);
  console.log(`\n--------------------------------------`);
  console.log(
    `⏰ Cron cestino attivo: eliminazione automatica ogni notte alle 00:00`,
  );
  console.log(`--------------------------------------`);
  console.log(
    `\n🛡️  PANNELLO HOST (apri questo sul tuo PC, qui vedrai lo schermo del cliente):`,
  );
  for (const u of hostUrls) console.log(`   ${u}`);
  console.log(`\n🔗 Link da dare al cliente:`);
  if (links.public) console.log(`   Internet:    ${links.public}`);
  console.log(`   Rete locale: ${links.local}`);
  console.log(`   Localhost:   ${links.localhost}`);
  console.log(
    `\n🔑 Codice OTP attuale: ${auth.currentOtp().code}  (cambia ogni ${config.OTP_TTL_SECONDS}s, lo trovi anche nel pannello host)`,
  );
  if (selfSigned) {
    console.log(
      `\n🔒 HTTPS con certificato autofirmato: al cliente il browser mostrerà un avviso,`,
    );
    console.log(
      `   deve scegliere "Avanzate → Procedi" (serve per poter condividere lo schermo).`,
    );
  }
  if (!config.HTTPS) {
    console.log(
      `\n⚠️  HTTPS disattivato: il cliente potrà condividere lo schermo solo se arriva da un indirizzo HTTPS`,
    );
    console.log(`   (reverse proxy/tunnel con PUBLIC_URL) o da localhost.`);
  }
  console.log(`\n⚠️  Condividi il link solo con chi si deve collegare.\n`);

  const servers = [main, local].filter(Boolean);
  const shutdown = () => {
    console.log("\n👋 Arresto del server…");
    for (const s of servers) s.close();
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

process.on("unhandledRejection", (err) => {
  console.error(
    "⚠️  Errore non gestito:",
    err && err.message ? err.message : err,
  );
});

start();
