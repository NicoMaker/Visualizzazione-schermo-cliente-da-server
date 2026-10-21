const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const EventEmitter = require("events");
const config = require("./config");

const events = new EventEmitter();
const COOKIE_NAME = "rd_session";

/* ------------------------------------------------------------------ */
/* Utilità                                                            */
/* ------------------------------------------------------------------ */
const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * True solo se la richiesta arriva davvero dal PC del server.
 * Se c'è un reverse proxy davanti (header X-Forwarded-*) NON è considerata locale.
 */
function isLocalRequest(req) {
  const addr = req.socket && req.socket.remoteAddress;
  const proxied =
    req.headers["x-forwarded-for"] ||
    req.headers["forwarded"] ||
    req.headers["x-real-ip"] ||
    req.headers["cf-connecting-ip"] ||
    req.headers["true-client-ip"];
  return LOOPBACK.has(addr) && !proxied;
}

function clientIp(req) {
  return ((req.socket && req.socket.remoteAddress) || "").replace(/^::ffff:/, "");
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

function parseCookies(header = "") {
  const out = {};
  for (const part of String(header).split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* Link di accesso (token segreto nell'URL)                           */
/* ------------------------------------------------------------------ */
const TOKEN_FILE = path.join(config.DATA_DIR, "access.json");
let accessToken = null;

function loadToken() {
  if (config.ACCESS_TOKEN) {
    accessToken = config.ACCESS_TOKEN;
    return accessToken;
  }
  try {
    const saved = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
    if (/^[a-f0-9]{48}$/.test(saved.token)) {
      accessToken = saved.token;
      return accessToken;
    }
  } catch {
    /* primo avvio: lo genero */
  }
  return regenerateToken();
}

function regenerateToken() {
  if (config.ACCESS_TOKEN) return accessToken; // fisso da .env
  accessToken = crypto.randomBytes(24).toString("hex");
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
  fs.writeFileSync(
    TOKEN_FILE,
    JSON.stringify({ token: accessToken, createdAt: new Date().toISOString() }, null, 2),
    { mode: 0o600 },
  );
  return accessToken;
}

const getToken = () => accessToken;
const checkToken = (candidate) =>
  typeof candidate === "string" && accessToken !== null && safeEqual(candidate, accessToken);

/* ------------------------------------------------------------------ */
/* OTP: 6 cifre, monouso, a scadenza                                  */
/* ------------------------------------------------------------------ */
let otp = null;
let wrongForCurrentCode = 0;

function newOtp() {
  otp = {
    code: String(crypto.randomInt(0, 1_000_000)).padStart(6, "0"),
    expiresAt: Date.now() + config.OTP_TTL_SECONDS * 1000,
  };
  wrongForCurrentCode = 0;
  events.emit("otp", otp);
  return otp;
}

function currentOtp() {
  if (!otp || Date.now() >= otp.expiresAt) newOtp();
  return otp;
}

function verifyOtp(input) {
  const o = currentOtp();
  if (safeEqual(input, o.code)) {
    newOtp(); // monouso: dopo l'uso se ne genera subito un altro
    return true;
  }
  wrongForCurrentCode += 1;
  if (wrongForCurrentCode >= 5) newOtp(); // troppi tentativi sullo stesso codice
  return false;
}

/* ------------------------------------------------------------------ */
/* Blocco anti brute-force per IP                                     */
/* ------------------------------------------------------------------ */
const MAX_FAILS = 5;
const LOCK_MS = 5 * 60 * 1000;
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const attempts = new Map();

function lockedFor(ip) {
  const a = attempts.get(ip);
  if (a && a.lockedUntil > Date.now()) return Math.ceil((a.lockedUntil - Date.now()) / 1000);
  return 0;
}

function registerFail(ip) {
  const now = Date.now();
  let a = attempts.get(ip);
  if (!a || now - a.first > FAIL_WINDOW_MS) a = { count: 0, first: now, lockedUntil: 0 };
  a.count += 1;
  if (a.count >= MAX_FAILS) {
    a.lockedUntil = now + LOCK_MS;
    a.count = 0;
    a.first = now;
  }
  attempts.set(ip, a);
}

const clearFails = (ip) => attempts.delete(ip);

/* ------------------------------------------------------------------ */
/* Sessioni (una sola connessione attiva alla volta)                  */
/* ------------------------------------------------------------------ */
const sessions = new Map();
const idleMs = () => config.SESSION_IDLE_MINUTES * 60 * 1000;

function createSession(ip, userAgent) {
  for (const id of [...sessions.keys()]) endSession(id, "sostituita da una nuova connessione");
  const session = {
    id: crypto.randomBytes(32).toString("hex"),
    ip,
    userAgent: String(userAgent || "").slice(0, 200),
    createdAt: Date.now(),
    lastSeen: Date.now(),
    sharing: false, // il cliente sta condividendo lo schermo
    sockets: new Set(), // canali di signaling del cliente
    graceTimer: null, // chiusura differita se il cliente esce dalla pagina
  };
  sessions.set(session.id, session);
  events.emit("start", session);
  return session;
}

function getSession(id) {
  if (!id) return null;
  const s = sessions.get(id);
  if (!s) return null;
  if (Date.now() - s.lastSeen > idleMs()) {
    endSession(id, "scaduta per inattività");
    return null;
  }
  return s;
}

function touch(id) {
  const s = sessions.get(id);
  if (s) s.lastSeen = Date.now();
}

function endSession(id, reason = "terminata") {
  const s = sessions.get(id);
  if (!s) return;
  sessions.delete(id);
  clearTimeout(s.graceTimer);
  events.emit("end", { session: s, reason });
}

function activeSession() {
  for (const id of [...sessions.keys()]) {
    const s = getSession(id);
    if (s) return s;
  }
  return null;
}

setInterval(() => {
  for (const id of [...sessions.keys()]) getSession(id);
}, 15_000).unref();

module.exports = {
  events,
  COOKIE_NAME,
  isLocalRequest,
  clientIp,
  safeEqual,
  parseCookies,
  loadToken,
  regenerateToken,
  getToken,
  checkToken,
  currentOtp,
  newOtp,
  verifyOtp,
  lockedFor,
  registerFail,
  clearFails,
  createSession,
  getSession,
  touch,
  endSession,
  activeSession,
};
