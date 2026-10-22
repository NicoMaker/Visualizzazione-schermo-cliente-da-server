const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const os = require("os");
const EventEmitter = require("events");
const config = require("./config");

const events = new EventEmitter();
const COOKIE_NAME = "rd_session";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

function localIPv4() {
  const nets = os.networkInterfaces();
  for (const list of Object.values(nets)) {
    for (const net of list || []) {
      if (net.family === "IPv4" && !net.internal) return net.address;
    }
  }
  return null;
}

// Indirizzi di rete privata (casa/ufficio): 10.x, 172.16-31.x, 192.168.x, 169.254.x, IPv6 locali
function isPrivateAddress(addr) {
  if (/^10\./.test(addr)) return true;
  if (/^192\.168\./.test(addr)) return true;
  if (/^169\.254\./.test(addr)) return true;
  const m = /^172\.(\d{1,3})\./.exec(addr);
  if (m && Number(m[1]) >= 16 && Number(m[1]) <= 31) return true;
  const a = addr.toLowerCase();
  if (a.startsWith("fe80:") || a.startsWith("fc") || a.startsWith("fd"))
    return true;
  return false;
}

// Se la richiesta passa da un proxy/tunnel (cloudflared, ngrok, nginx...) NON è locale
const PROXY_HEADERS = [
  "x-forwarded-for",
  "forwarded",
  "x-real-ip",
  "cf-connecting-ip",
];

function matchesAllowed(addr) {
  return config.HOST_ALLOWED_IPS.some((rule) =>
    rule.endsWith(".") || rule.endsWith(":")
      ? addr.startsWith(rule)
      : addr === rule,
  );
}

function isLocalRequest(req) {
  const raw = (req.socket && req.socket.remoteAddress) || "";
  const addr = raw.replace(/^::ffff:/, "");
  if (PROXY_HEADERS.some((h) => req.headers[h])) return false;
  if (LOOPBACK.has(raw) || LOOPBACK.has(addr)) return true;
  const lip = localIPv4();
  if (lip && addr === lip) return true;
  // Altri PC / telefoni della stessa rete (Wi-Fi/LAN)
  if (config.HOST_ACCESS === "lan" && isPrivateAddress(addr)) return true;
  // IP espliciti autorizzati nel .env (HOST_ALLOWED_IPS)
  if (matchesAllowed(addr)) return true;
  return false;
}

// ---------- Accesso al pannello host con password (da qualsiasi PC) ----------
const HOST_COOKIE = "rd_host";
const HOST_SESSION_MS = 12 * 60 * 60 * 1000;
const hostSessions = new Map(); // id -> scadenza

const sha = (v) => crypto.createHash("sha256").update(String(v)).digest();
const hostLoginEnabled = () => !!config.HOST_PASSWORD;

function checkHostPassword(candidate) {
  if (!config.HOST_PASSWORD || typeof candidate !== "string") return false;
  return crypto.timingSafeEqual(sha(candidate), sha(config.HOST_PASSWORD));
}

function createHostSession() {
  const id = crypto.randomBytes(32).toString("hex");
  hostSessions.set(id, Date.now() + HOST_SESSION_MS);
  return id;
}

function hostSessionValid(id) {
  const exp = id && hostSessions.get(id);
  if (!exp) return false;
  if (Date.now() > exp) {
    hostSessions.delete(id);
    return false;
  }
  return true;
}

const endHostSession = (id) => hostSessions.delete(id);

// Pannello host autorizzato: PC locale/rete/IP autorizzati OPPURE password inserita
function isHostRequest(req) {
  if (isLocalRequest(req)) return true;
  return hostSessionValid(parseCookies(req.headers.cookie)[HOST_COOKIE]);
}

function clientIp(req) {
  return ((req.socket && req.socket.remoteAddress) || "").replace(
    /^::ffff:/,
    "",
  );
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
  if (config.ACCESS_TOKEN) return accessToken;
  accessToken = crypto.randomBytes(24).toString("hex");
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
  fs.writeFileSync(
    TOKEN_FILE,
    JSON.stringify(
      { token: accessToken, createdAt: new Date().toISOString() },
      null,
      2,
    ),
    { mode: 0o600 },
  );
  return accessToken;
}

const getToken = () => accessToken;
const checkToken = (candidate) =>
  typeof candidate === "string" &&
  accessToken !== null &&
  safeEqual(candidate, accessToken);

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
    newOtp();
    return true;
  }
  wrongForCurrentCode += 1;
  if (wrongForCurrentCode >= 5) newOtp();
  return false;
}

const MAX_FAILS = 5;
const LOCK_MS = 5 * 60 * 1000;
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const attempts = new Map();

function lockedFor(ip) {
  const a = attempts.get(ip);
  if (a && a.lockedUntil > Date.now())
    return Math.ceil((a.lockedUntil - Date.now()) / 1000);
  return 0;
}

function registerFail(ip) {
  const now = Date.now();
  let a = attempts.get(ip);
  if (!a || now - a.first > FAIL_WINDOW_MS)
    a = { count: 0, first: now, lockedUntil: 0 };
  a.count += 1;
  if (a.count >= MAX_FAILS) {
    a.lockedUntil = now + LOCK_MS;
    a.count = 0;
    a.first = now;
  }
  attempts.set(ip, a);
}

const clearFails = (ip) => attempts.delete(ip);

const sessions = new Map();
const idleMs = () => config.SESSION_IDLE_MINUTES * 60 * 1000;

function createSession(ip, userAgent) {
  for (const id of [...sessions.keys()])
    endSession(id, "sostituita da una nuova connessione");
  const session = {
    id: crypto.randomBytes(32).toString("hex"),
    ip,
    userAgent: String(userAgent || "").slice(0, 200),
    createdAt: Date.now(),
    lastSeen: Date.now(),
    sharing: false,
    sockets: new Set(),
    graceTimer: null,
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
  isHostRequest,
  HOST_COOKIE,
  hostSessionValid,
  hostLoginEnabled,
  checkHostPassword,
  createHostSession,
  endHostSession,
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
