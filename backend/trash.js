const fs = require("fs");
const path = require("path");
const config = require("./config");

/**
 * Cestino: ogni sessione terminata viene registrata qui come piccolo file JSON
 * (senza dati sensibili) e svuotata automaticamente ogni notte alle 00:00.
 */
function ensureDir() {
  fs.mkdirSync(config.TRASH_DIR, { recursive: true });
  fs.mkdirSync(config.DATA_DIR, { recursive: true });
}

function archiveSession(session, reason) {
  try {
    ensureDir();
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const record = {
      ip: session.ip,
      browser: session.userAgent,
      inizio: new Date(session.createdAt).toISOString(),
      fine: new Date().toISOString(),
      motivo: reason,
    };
    fs.writeFileSync(
      path.join(
        config.TRASH_DIR,
        `sessione-${stamp}-${session.id.slice(0, 8)}.json`,
      ),
      JSON.stringify(record, null, 2),
    );
  } catch (err) {
    console.error("⚠️  Impossibile scrivere nel cestino:", err.message);
  }
}

function purge() {
  let removed = 0;
  try {
    for (const name of fs.readdirSync(config.TRASH_DIR)) {
      if (name === ".gitkeep") continue;
      fs.rmSync(path.join(config.TRASH_DIR, name), {
        recursive: true,
        force: true,
      });
      removed += 1;
    }
  } catch (err) {
    console.error("⚠️  Errore svuotamento cestino:", err.message);
  }
  return removed;
}

module.exports = { ensureDir, archiveSession, purge };
