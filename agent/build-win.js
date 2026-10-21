#!/usr/bin/env node
/*
 * Crea il pacchetto Windows del programma di controllo per il cliente:
 *   agent/dist/agente-windows.zip
 * Dentro c'è:
 *   - Avvia.bat      → il cliente apre SOLO questo, con doppio clic
 *   - agent.exe      → eseguibile Node.js impacchettato (nessun Node richiesto sul PC del cliente)
 *   - node_modules/  → solo la libreria nativa per muovere mouse/tastiera (non può stare dentro l'exe)
 *
 * Uso (lo esegue il TECNICO una volta, non il cliente):
 *   cd agent
 *   npm install
 *   node build-win.js [URL_PUBBLICO_DEL_SERVER] [--insecure]
 *
 * Se non passi l'URL, l'exe prodotto chiederà comunque l'indirizzo al cliente
 * (stesso comportamento di oggi, nulla si rompe). Passalo per far sì che il
 * cliente debba scrivere SOLO il codice di controllo.
 *
 * --insecure: da passare solo se il server usa il certificato autofirmato
 * creato in automatico (HTTPS=true senza CERT_FILE/KEY_FILE). Con un
 * certificato vero o un tunnel che termina l'HTTPS non serve.
 */
"use strict";

const fs = require("fs");
const path = require("path");
const os = require("os");
const { execFileSync } = require("child_process");

const AGENT_DIR = __dirname;
const DIST_DIR = path.join(AGENT_DIR, "dist");
const STAGE_DIR = path.join(DIST_DIR, "_staging");

const args = process.argv.slice(2);
const insecure = args.includes("--insecure");
const serverUrl = args.find((a) => !a.startsWith("--")) || "";

function log(...a) {
  console.log(...a);
}

function rimraf(p) {
  fs.rmSync(p, { recursive: true, force: true });
}

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

function main() {
  if (!fs.existsSync(path.join(AGENT_DIR, "node_modules", "@nut-tree-fork"))) {
    console.error(
      "❌ Mancano le dipendenze. Esegui prima, dentro la cartella agent/:\n   npm install\n   npm install --save-dev @yao-pkg/pkg",
    );
    process.exit(1);
  }

  rimraf(DIST_DIR);
  fs.mkdirSync(STAGE_DIR, { recursive: true });

  // 1) Copia agent.js inserendo l'indirizzo del server (se passato).
  log("• Preparo agent.js con l'indirizzo preimpostato" + (serverUrl ? ` (${serverUrl})` : " (nessuno: lo chiederà al cliente)"));
  let src = fs.readFileSync(path.join(AGENT_DIR, "agent.js"), "utf8");
  src = src.replace(
    '"__DESKTOP_REMOTO_SERVER_URL__"',
    JSON.stringify(serverUrl),
  );
  src = src.replace(
    '"__DESKTOP_REMOTO_INSECURE__"',
    JSON.stringify(insecure ? "true" : "false"),
  );
  // Scritto FUORI dalla cartella che verrà zippata: serve solo a pkg per
  // compilare, non deve finire nel pacchetto per il cliente.
  const SRC_TMP_DIR = path.join(DIST_DIR, "_src-tmp");
  fs.mkdirSync(SRC_TMP_DIR, { recursive: true });
  const builtAgentPath = path.join(SRC_TMP_DIR, "agent.build.js");
  fs.writeFileSync(builtAgentPath, src);

  // 2) Compila con pkg (Node.js 18, Windows x64) in un unico .exe.
  //    Le dipendenze pure JS (ws) finiscono dentro l'exe; la libreria nativa
  //    (@nut-tree-fork/*) resta FUORI e viene copiata accanto all'exe al
  //    passo successivo: un modulo nativo non può girare da dentro un exe
  //    impacchettato, deve stare su disco vero.
  log("• Compilo agent.exe con pkg (Windows x64)…");
  const pkgBin = path.join(AGENT_DIR, "node_modules", ".bin", process.platform === "win32" ? "pkg.cmd" : "pkg");
  execFileSync(
    pkgBin,
    [
      builtAgentPath,
      "--targets", "node22-win-x64",
      "--output", path.join(STAGE_DIR, "agent.exe"),
    ],
    { stdio: "inherit", cwd: AGENT_DIR },
  );

  // 3) Copia SOLO i pacchetti nativi necessari (non tutto node_modules: ws
  //    sta già dentro l'exe, qui serve solo chi parla con mouse/tastiera).
  log("• Copio la libreria nativa (mouse/tastiera) accanto all'exe…");
  const needed = [
    "@nut-tree-fork",
    "bindings",
    "file-uri-to-path",
  ];
  const nmOut = path.join(STAGE_DIR, "node_modules");
  fs.mkdirSync(nmOut, { recursive: true });
  for (const pkgName of needed) {
    const from = path.join(AGENT_DIR, "node_modules", pkgName);
    if (!fs.existsSync(from)) {
      console.error(`❌ Manca node_modules/${pkgName}. Esegui "npm install" in agent/ e riprova.`);
      process.exit(1);
    }
    copyDir(from, path.join(nmOut, pkgName));
  }
  // Non serve portarsi dietro i moduli nativi per macOS/Linux dentro il pacchetto Windows.
  for (const other of ["libnut-darwin", "libnut-linux"]) {
    rimraf(path.join(nmOut, "@nut-tree-fork", other));
  }

  // 4) Avvia.bat: quello che il cliente apre col doppio clic.
  const bat = [
    "@echo off",
    "title Desktop Remoto - programma del tecnico",
    "cd /d %~dp0",
    "agent.exe",
    "pause",
    "",
  ].join("\r\n");
  fs.writeFileSync(path.join(STAGE_DIR, "Avvia.bat"), bat);

  // 5) Leggimi minimo dentro lo zip.
  const readme = [
    "DESKTOP REMOTO - programma del tecnico",
    "",
    "Cosa fa: permette al tecnico di muovere il mouse e scrivere sul TUO PC,",
    "ma SOLO dopo che tu scrivi il codice che ti ha dato il tecnico e SOLO",
    "dopo che tu premi \"Consenti\" nella pagina web.",
    "",
    "Come si usa:",
    "  1. Apri il file Avvia.bat con un doppio clic.",
    "  2. Se Windows mostra un avviso \"editore sconosciuto\", scegli",
    "     \"Ulteriori informazioni\" poi \"Esegui comunque\" (succede perche'",
    "     il programma non e' firmato da Microsoft, non perche' sia pericoloso:",
    "     chiedi conferma al tecnico se non sei sicuro).",
    "  3. Scrivi il codice mostrato nella pagina web e premi Invio.",
    "  4. Torna alla pagina web: quando il tecnico chiede il controllo,",
    "     comparira' una richiesta da APPROVARE tu.",
    "",
    "Per fermare subito: premi Q poi Invio in questa finestra, oppure chiudila,",
    "oppure premi \"Revoca controllo\" nella pagina web.",
    "",
    "Non installa nulla sul PC e non resta attivo dopo che chiudi la finestra.",
    "",
  ].join("\r\n");
  fs.writeFileSync(path.join(STAGE_DIR, "LEGGIMI.txt"), readme);

  // 6) Zip finale.
  const zipPath = path.join(DIST_DIR, "agente-windows.zip");
  log("• Creo " + path.relative(AGENT_DIR, zipPath));
  try {
    execFileSync("zip", ["-r", "-X", zipPath, "."], { cwd: STAGE_DIR, stdio: "inherit" });
  } catch (err) {
    console.error(
      "❌ Comando \"zip\" non trovato o fallito. Installa zip (es. \"apt install zip\") oppure" +
        " comprimi a mano la cartella " + STAGE_DIR,
    );
    throw err;
  }

  rimraf(STAGE_DIR);
  rimraf(SRC_TMP_DIR);
  const sizeMb = (fs.statSync(zipPath).size / (1024 * 1024)).toFixed(1);
  log(`\n✅ Fatto: ${zipPath} (${sizeMb} MB)`);
  log("   Mettilo in agent/dist/agente-windows.zip: il server lo serve da lì in automatico.");
}

main();
