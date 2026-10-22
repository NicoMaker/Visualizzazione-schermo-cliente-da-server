const path = require("path");

const ROOT = path.join(__dirname, "..");
require("dotenv").config({ path: path.join(ROOT, ".env") });

const num = (value, fallback, min, max) => {
  if (value === undefined || String(value).trim() === "") return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
};

const bool = (value, fallback) => {
  if (value === undefined || value === "") return fallback;
  return String(value).trim().toLowerCase() === "true";
};

const list = (value) =>
  String(value || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const token = (process.env.ACCESS_TOKEN || "").trim();
const PORT = Math.round(num(process.env.PORT, 3002, 1, 65535));
const HTTPS = bool(process.env.HTTPS, true);

function buildIceServers() {
  const servers = [];
  const stun = list(
    process.env.STUN_URLS === undefined
      ? "stun:stun.l.google.com:19302"
      : process.env.STUN_URLS,
  );
  if (stun.length) servers.push({ urls: stun });
  const turn = list(process.env.TURN_URLS);
  if (turn.length) {
    servers.push({
      urls: turn,
      username: (process.env.TURN_USER || "").trim(),
      credential: (process.env.TURN_PASS || "").trim(),
    });
  }
  return servers;
}

module.exports = {
  ROOT,
  DATA_DIR: path.join(__dirname, "data"),
  TRASH_DIR: path.join(__dirname, "trash"),
  HTML_DIR: path.join(ROOT, "frontend", "html"),
  CSS_DIR: path.join(ROOT, "frontend", "css"),
  JS_DIR: path.join(ROOT, "frontend", "js"),

  PORT,
  HTTPS,
  CERT_FILE: (process.env.CERT_FILE || "").trim(),
  KEY_FILE: (process.env.KEY_FILE || "").trim(),
  LOCAL_HTTP_PORT: HTTPS
    ? Math.round(num(process.env.LOCAL_HTTP_PORT, PORT + 1, 0, 65535))
    : 0,

  // Chi può aprire il pannello host: "lan" = questo PC + tutti i dispositivi della stessa rete,
  // "local" = solo questo PC. HOST_ALLOWED_IPS = IP extra (anche prefissi tipo 100.64.)
  HOST_ACCESS: (process.env.HOST_ACCESS || "lan").trim().toLowerCase() === "local" ? "local" : "lan",
  HOST_ALLOWED_IPS: list(
    process.env.HOST_ALLOWED_IPS === undefined
      ? "176.206.119.186"
      : process.env.HOST_ALLOWED_IPS,
  ),

  // Password del pannello host: se impostata, il pannello si apre da QUALSIASI PC/telefono
  // (anche da internet) dopo aver inserito la password. Minimo 8 caratteri.
  HOST_PASSWORD: (process.env.HOST_PASSWORD || "").trim().length >= 8
    ? (process.env.HOST_PASSWORD || "").trim()
    : "",

  ACCESS_TOKEN: /^[A-Za-z0-9_-]{16,64}$/.test(token) ? token : "",
  PUBLIC_URL: (process.env.PUBLIC_URL || "").trim().replace(/\/+$/, ""),

  OTP_TTL_SECONDS: Math.round(num(process.env.OTP_TTL_SECONDS, 90, 15, 3600)),
  SESSION_IDLE_MINUTES: Math.round(
    num(process.env.SESSION_IDLE_MINUTES, 30, 1, 1440),
  ),

  MAX_FPS: Math.round(num(process.env.MAX_FPS, 15, 1, 60)),
  MAX_BITRATE_KBPS: Math.round(
    num(process.env.MAX_BITRATE_KBPS, 3000, 200, 20000),
  ),
  ICE_SERVERS: buildIceServers(),

  COOKIE_SECURE: bool(process.env.COOKIE_SECURE, false),
  TZ: process.env.TZ || "Europe/Rome",
};