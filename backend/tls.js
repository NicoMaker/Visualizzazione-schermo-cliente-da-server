const fs = require("fs");
const path = require("path");
const selfsigned = require("selfsigned");
const config = require("./config");

const CERT = path.join(config.DATA_DIR, "cert.pem");
const KEY = path.join(config.DATA_DIR, "key.pem");
const META = path.join(config.DATA_DIR, "cert-names.json");

/**
 * Il browser permette di condividere lo schermo (getDisplayMedia) solo in contesto sicuro:
 * HTTPS oppure localhost. Senza un certificato vero ne genero uno autofirmato (il cliente
 * dovrà confermare l'avviso del browser una volta). Con CERT_FILE/KEY_FILE usi il tuo.
 */
async function loadCredentials(names) {
  if (config.CERT_FILE && config.KEY_FILE) {
    return {
      cert: fs.readFileSync(config.CERT_FILE),
      key: fs.readFileSync(config.KEY_FILE),
      selfSigned: false,
    };
  }

  const wanted = [...new Set(names)].sort();
  try {
    const saved = JSON.parse(fs.readFileSync(META, "utf8"));
    const sameNames = JSON.stringify(saved.names) === JSON.stringify(wanted);
    const fresh = Date.now() < Date.parse(saved.expires || 0) - 7 * 86400_000;
    if (sameNames && fresh) {
      return { cert: fs.readFileSync(CERT), key: fs.readFileSync(KEY), selfSigned: true };
    }
  } catch {
    /* primo avvio o file mancanti: genero */
  }

  const altNames = wanted.map((n) =>
    /^\d{1,3}(\.\d{1,3}){3}$/.test(n) ? { type: 7, ip: n } : { type: 2, value: n },
  );
  const days = 825;
  const pems = await selfsigned.generate([{ name: "commonName", value: "Desktop Remoto" }], {
    days,
    keySize: 2048,
    algorithm: "sha256",
    extensions: [{ name: "subjectAltName", altNames }],
  });

  fs.mkdirSync(config.DATA_DIR, { recursive: true });
  fs.writeFileSync(CERT, pems.cert, { mode: 0o600 });
  fs.writeFileSync(KEY, pems.private, { mode: 0o600 });
  fs.writeFileSync(
    META,
    JSON.stringify({ names: wanted, expires: new Date(Date.now() + days * 86400_000).toISOString() }),
  );
  return { cert: pems.cert, key: pems.private, selfSigned: true };
}

module.exports = { loadCredentials };
