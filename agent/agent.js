#!/usr/bin/env node
/*
 * Desktop Remoto — programma di controllo (lato CLIENTE).
 *
 * Lo avvii TU, sul TUO computer, solo se vuoi che il tecnico possa usare mouse e tastiera.
 *  - non si installa, non parte da solo, non resta in esecuzione dopo la chiusura;
 *  - il tecnico può muovere il mouse / scrivere SOLO dopo che tu premi «Consenti» nella pagina web;
 *  - per fermarlo subito: premi Q + Invio, oppure Ctrl+C, oppure chiudi questa finestra,
 *    oppure premi «Revoca controllo» nella pagina web.
 *
 * Uso:   node agent.js --url https://INDIRIZZO:3000 --code CODICE [--insecure]
 *        (senza opzioni te li chiede lui)
 */
"use strict";

const path = require("path");
const readline = require("readline");
const WebSocket = require("ws");

/*
 * Indirizzo del server preimpostato quando questo file viene compilato in
 * agent.exe dal tecnico (vedi agent/build-win.js). Nel sorgente normale
 * resta vuoto: in tal caso il programma lo chiede, come sempre.
 */
const BUILT_IN_SERVER_URL = "__DESKTOP_REMOTO_SERVER_URL__".startsWith("__")
  ? ""
  : "__DESKTOP_REMOTO_SERVER_URL__";
const BUILT_IN_INSECURE = "__DESKTOP_REMOTO_INSECURE__" === "true";

/*
 * Carica @nut-tree-fork/nut-js.
 * - In sviluppo (node agent.js): require normale da node_modules.
 * - Impacchettato con pkg (agent.exe): la libreria NON sta dentro l'eseguibile
 *   (un modulo nativo non può girare da un "disco virtuale"), ma nella
 *   cartella node_modules che build-win.js mette accanto all'exe. La
 *   richiediamo quindi da un percorso costruito a runtime, così pkg non
 *   prova a comprimerla dentro lo snapshot.
 */
function loadNut() {
  if (process.pkg) {
    const base = path.join(path.dirname(process.execPath), "node_modules");
    const mod = path.join(base, "@nut-tree-fork", "nut-js");
    return require(mod);
  }
  return require("@nut-tree-fork/nut-js");
}

/* ------------------------------------------------------------------ */
/* Argomenti                                                          */
/* ------------------------------------------------------------------ */
const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf("--" + name);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name) => args.includes("--" + name);

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q) => new Promise((res) => rl.question(q, (a) => res(a.trim())));

const log = (...a) => console.log(new Date().toLocaleTimeString("it-IT"), ...a);

/* ------------------------------------------------------------------ */
/* Mappa tasti: KeyboardEvent.code → nut.js Key                       */
/* ------------------------------------------------------------------ */
function buildKeyMap(Key) {
  const m = {
    Enter: Key.Return, NumpadEnter: Key.Enter, Escape: Key.Escape, Backspace: Key.Backspace,
    Tab: Key.Tab, Space: Key.Space, Delete: Key.Delete, Insert: Key.Insert,
    Home: Key.Home, End: Key.End, PageUp: Key.PageUp, PageDown: Key.PageDown,
    ArrowLeft: Key.Left, ArrowRight: Key.Right, ArrowUp: Key.Up, ArrowDown: Key.Down,
    ShiftLeft: Key.LeftShift, ShiftRight: Key.RightShift,
    ControlLeft: Key.LeftControl, ControlRight: Key.RightControl,
    AltLeft: Key.LeftAlt, AltRight: Key.RightAlt,
    MetaLeft: Key.LeftSuper, MetaRight: Key.RightSuper,
    CapsLock: Key.CapsLock, ContextMenu: Key.Menu,
    Minus: Key.Minus, Equal: Key.Equal, BracketLeft: Key.LeftBracket, BracketRight: Key.RightBracket,
    Semicolon: Key.Semicolon, Quote: Key.Quote, Comma: Key.Comma, Period: Key.Period,
    Slash: Key.Slash, Backslash: Key.Backslash, Backquote: Key.Grave,
  };
  for (let i = 1; i <= 12; i++) m["F" + i] = Key["F" + i];
  for (let c = 65; c <= 90; c++) {
    const L = String.fromCharCode(c);
    m["Key" + L] = Key[L];
  }
  for (let d = 0; d <= 9; d++) {
    m["Digit" + d] = Key["Num" + d];
    m["Numpad" + d] = Key["NumPad" + d];
  }
  return m;
}

/* ------------------------------------------------------------------ */
/* Esecuzione degli input                                             */
/* ------------------------------------------------------------------ */
let nut = null;
let keyMap = null;
let screenSize = { w: 0, h: 0 };

const pressedKeys = new Set(); // code
const pressedButtons = new Set(); // 0,1,2
const mods = { ctrl: false, alt: false, meta: false };
const typed = new Set(); // code dei tasti «scritti» (non premuti)

function buttonOf(b) {
  const { Button } = nut;
  return b === 0 ? Button.LEFT : b === 1 ? Button.MIDDLE : Button.RIGHT;
}

async function moveTo(x, y) {
  const px = Math.round(Math.min(1, Math.max(0, x)) * (screenSize.w - 1));
  const py = Math.round(Math.min(1, Math.max(0, y)) * (screenSize.h - 1));
  await nut.mouse.setPosition(new nut.Point(px, py));
}

async function execute(ev) {
  const { mouse, keyboard } = nut;
  switch (ev.k) {
    case "move":
      return moveTo(ev.x, ev.y);
    case "down":
      await moveTo(ev.x, ev.y);
      pressedButtons.add(ev.b);
      return mouse.pressButton(buttonOf(ev.b));
    case "up":
      await moveTo(ev.x, ev.y);
      pressedButtons.delete(ev.b);
      return mouse.releaseButton(buttonOf(ev.b));
    case "wheel": {
      const steps = (v) => Math.min(30, Math.max(1, Math.round(Math.abs(v) / 40)));
      if (ev.dy > 0) await mouse.scrollDown(steps(ev.dy));
      else if (ev.dy < 0) await mouse.scrollUp(steps(ev.dy));
      if (ev.dx > 0) await mouse.scrollRight(steps(ev.dx));
      else if (ev.dx < 0) await mouse.scrollLeft(steps(ev.dx));
      return;
    }
    case "key":
      return executeKey(ev, keyboard);
    default:
  }
}

async function executeKey(ev, keyboard) {
  const { code, key, d } = ev;

  if (code === "ControlLeft" || code === "ControlRight") mods.ctrl = d;
  if (code === "AltLeft" || code === "AltRight") mods.alt = d;
  if (code === "MetaLeft" || code === "MetaRight") mods.meta = d;

  const printable = key.length === 1 && !mods.ctrl && !mods.alt && !mods.meta;
  if (printable) {
    // carattere normale: lo scrivo così com'è (funziona anche con layout di tastiera diversi)
    if (d) {
      typed.add(code);
      await keyboard.type(key);
    } else {
      typed.delete(code);
    }
    return;
  }

  const k = keyMap[code];
  if (k === undefined) return;
  if (d) {
    pressedKeys.add(code);
    await keyboard.pressKey(k);
  } else {
    pressedKeys.delete(code);
    await keyboard.releaseKey(k);
  }
}

async function releaseAll() {
  try {
    for (const b of [...pressedButtons]) await nut.mouse.releaseButton(buttonOf(b));
    for (const c of [...pressedKeys]) {
      if (keyMap[c] !== undefined) await nut.keyboard.releaseKey(keyMap[c]);
    }
  } catch {
    /* niente da rilasciare */
  }
  pressedButtons.clear();
  pressedKeys.clear();
  typed.clear();
  mods.ctrl = mods.alt = mods.meta = false;
}

/* Coda: gli eventi vengono eseguiti in ordine; i movimenti in eccesso vengono scartati. */
let queue = [];
let running = false;
async function pump() {
  if (running) return;
  running = true;
  while (queue.length) {
    const ev = queue.shift();
    // se il prossimo è un altro «move», salto questo (il mouse arriva comunque all'ultimo punto)
    if (ev.k === "move" && queue.length && queue[0].k === "move") continue;
    try {
      await execute(ev);
    } catch (err) {
      log("⚠️  errore su un comando:", err && err.message ? err.message : err);
    }
  }
  running = false;
}

/* ------------------------------------------------------------------ */
/* Collegamento                                                       */
/* ------------------------------------------------------------------ */
async function main() {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Desktop Remoto — controllo remoto (programma del cliente)   ║
╚══════════════════════════════════════════════════════════════╝
 Questo programma permette al tecnico di usare il mouse e la tastiera
 di QUESTO computer, ma SOLO dopo che premi «Consenti» nella pagina web.

 Per fermarlo in qualsiasi momento:  Q + Invio   oppure   Ctrl+C
`);

  try {
    nut = loadNut();
  } catch (err) {
    console.error(
      "❌ Manca la libreria per muovere mouse e tastiera. Esegui prima:  npm install\n   (" +
        (err && err.message ? err.message : err) +
        ")",
    );
    process.exit(1);
  }
  nut.mouse.config.autoDelayMs = 0;
  nut.keyboard.config.autoDelayMs = 0;
  keyMap = buildKeyMap(nut.Key);

  try {
    screenSize = { w: await nut.screen.width(), h: await nut.screen.height() };
  } catch (err) {
    console.error(
      "❌ Non riesco a leggere le dimensioni dello schermo (sistema senza ambiente grafico o permessi mancanti).\n   " +
        (err && err.message ? err.message : err),
    );
    process.exit(1);
  }
  if (process.platform === "darwin")
    console.log(
      " ℹ️  macOS: se il mouse non si muove, abilita il Terminale in\n    Impostazioni → Privacy e sicurezza → Accessibilità (e Registrazione schermo).\n",
    );

  let base =
    opt("url") ||
    BUILT_IN_SERVER_URL ||
    (await ask("Indirizzo del server (es. https://192.168.1.20:3000): "));
  if (BUILT_IN_SERVER_URL && !opt("url")) log("Server: " + BUILT_IN_SERVER_URL + " (preimpostato)");
  const code = (opt("code") || (await ask("Codice di controllo mostrato nella pagina web: "))).toUpperCase();
  if (!/^https?:\/\//i.test(base)) base = "https://" + base;

  let wsUrl;
  try {
    const u = new URL(base);
    u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
    u.pathname = "/ws/agent";
    u.search = "";
    u.hash = "";
    wsUrl = u.toString();
  } catch {
    console.error("❌ Indirizzo non valido.");
    process.exit(1);
  }

  const insecure = flag("insecure") || BUILT_IN_INSECURE;
  if (insecure)
    console.log(" ⚠️  --insecure: il certificato del server NON viene verificato (usalo solo con un server di cui ti fidi).\n");

  const ws = new WebSocket(wsUrl, { rejectUnauthorized: !insecure, handshakeTimeout: 10_000 });
  let active = false;
  let paired = false;

  const shutdown = (why, exitCode = 0) => {
    active = false;
    queue = [];
    releaseAll().finally(() => {
      if (why) log(why);
      try {
        ws.close();
      } catch {
        /* già chiuso */
      }
      setTimeout(() => process.exit(exitCode), 150);
    });
  };

  ws.on("open", () => {
    ws.send(JSON.stringify({ type: "pair", code, w: screenSize.w, h: screenSize.h }));
  });

  ws.on("message", (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    switch (msg.type) {
      case "paired":
        paired = true;
        log("✅ Collegato. Torna alla pagina web: il tecnico potrà chiederti il controllo.");
        log("   (finché non premi «Consenti» il tecnico NON può fare nulla)");
        break;
      case "pair-error":
        console.error("❌ " + (msg.reason || "codice non valido") + ". Chiedi un nuovo codice nella pagina web.");
        break;
      case "control":
        active = !!msg.active;
        if (active) {
          log("🔴 CONTROLLO REMOTO ATTIVO — il tecnico sta usando mouse e tastiera.");
          log("   Per fermarlo: Q + Invio, Ctrl+C, oppure «Revoca controllo» nella pagina web.");
        } else {
          queue = [];
          releaseAll();
          log("🟢 Controllo remoto terminato" + (msg.reason ? " (" + msg.reason + ")" : "") + ".");
        }
        break;
      case "input":
        if (!active) return;
        queue.push(msg.ev);
        if (queue.length > 500) queue.splice(0, queue.length - 500);
        pump();
        break;
      default:
    }
  });

  ws.on("close", (code2, reason) => {
    shutdown(
      paired
        ? "Collegamento chiuso" + (reason && reason.length ? ": " + reason : "") + ". Programma terminato."
        : "Collegamento non riuscito" + (reason && reason.length ? ": " + reason : "") + ".",
      paired ? 0 : 1,
    );
  });

  ws.on("error", (err) => {
    const m = err && err.message ? err.message : String(err);
    console.error("❌ Errore di collegamento: " + m);
    if (/self[- ]signed|certificate|CERT/i.test(m))
      console.error("   Il server usa un certificato autofirmato: riesegui con  --insecure  se ti fidi del tecnico.");
  });

  rl.on("line", (line) => {
    if (line.trim().toLowerCase() === "q") {
      try {
        ws.send(JSON.stringify({ type: "stop" }));
      } catch {
        /* già chiuso */
      }
      shutdown("Fermato da te. Il tecnico non ha più alcun controllo.");
    }
  });
  rl.on("SIGINT", () => shutdown("Fermato da te (Ctrl+C). Il tecnico non ha più alcun controllo."));
  process.on("SIGINT", () => shutdown("Fermato da te (Ctrl+C). Il tecnico non ha più alcun controllo."));
  process.on("SIGTERM", () => shutdown("Programma terminato."));
}

main();
