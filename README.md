# 🖥️ Desktop Remoto (Node.js) — assistenza remota dal browser

**Il cliente apre un link, scrive un codice e condivide il SUO schermo; tu (l'host) lo vedi in diretta.**
Il PC su cui gira il server non viene mai mostrato a nessuno.

- **Backend**: Node.js + Express + WebSocket (`backend/`)
- **Frontend**: HTML + CSS + JavaScript puri (`frontend/`)
- Video in **WebRTC** direttamente dal browser del cliente al tuo (nessun programma da installare al cliente)
- Il cliente **sceglie cosa condividere** (schermo intero, finestra o scheda) e può interrompere quando vuole
- Di base solo **visualizzazione**. Il **controllo remoto** (mouse e tastiera) è **facoltativo**: richiede un piccolo programma (`agent/`) che il cliente avvia lui stesso e un consenso esplicito (vedi sotto)

---

## Come funziona

```
Il TUO PC (host, gira il server)                    PC del CLIENTE
┌─────────────────────────────────┐                ┌──────────────────────────────────┐
│ npm start                       │                │ 1. apre il link che gli mandi    │
│ apri il pannello host:          │   ◄─────────   │ 2. scrive il codice a 6 cifre    │
│   http://localhost:3001/host    │   video dello  │ 3. "Scegli cosa condividere"     │
│ → vedi lo schermo del cliente   │   schermo      │ 4. il browser chiede il permesso │
└─────────────────────────────────┘                └──────────────────────────────────┘
```

1. Sul tuo PC avvia il server (`npm start` nella cartella `backend`).
2. Apri il **pannello host** (indirizzo stampato in console). Lì trovi **link** e **codice OTP**.
3. Mandi il link al cliente e gli detti il codice.
4. Il cliente apre il link, scrive il codice, preme **Scegli cosa condividere** e conferma nel browser.
5. Nel tuo pannello compare il suo schermo in diretta (con tasto schermo intero e statistiche).

> Il collegamento funziona **solo con il consenso del cliente**: deve inserire il codice, scegliere lui cosa
> condividere e il browser mostra sempre un indicatore di condivisione attiva. Usa il programma solo con
> persone che sanno cosa stai guardando.

---

## Installazione

Requisiti: **Node.js 18 o superiore**. Nessun permesso speciale, nessuna libreria nativa.

```bash
cd backend
npm install
cp .env.example ../.env     # opzionale: senza .env usa i valori di default
npm start
```

Esempio di output:

```
🚀 Server avviato con successo!
🛡️  PANNELLO HOST (apri questo sul tuo PC, qui vedrai lo schermo del cliente):
   http://localhost:3001/host

🔗 Link da dare al cliente:
   Internet:    https://203.0.113.10:3000/c/<token-segreto>
   Rete locale: https://192.168.1.20:3000/c/<token-segreto>

🔑 Codice OTP attuale: 482913  (cambia ogni 90s)
```

---

## ⚠️ HTTPS: perché serve

Il browser del cliente **blocca la condivisione dello schermo su pagine `http://`** (tranne `localhost`).
Per questo il server parte di default in **HTTPS** con un certificato **autofirmato** creato da solo
(`backend/data/cert.pem`):

- Al cliente il browser mostra un avviso la prima volta: deve scegliere **Avanzate → Procedi** e poi continuare normalmente.
- Il **pannello host** invece si apre in HTTP sulla porta locale `PORT+1` (`http://localhost:3001/host`), senza avvisi.
  Questa porta è raggiungibile solo da questo PC.

Per **non far vedere nessun avviso** al cliente hai due strade:

1. **Tunnel HTTPS** (la più semplice, niente porte da aprire sul router): es. `cloudflared tunnel --url https://localhost:3000 --no-tls-verify`
   oppure ngrok. Poi imposta `PUBLIC_URL=https://indirizzo-del-tunnel` nel `.env` (e se il tunnel termina l'HTTPS per conto tuo puoi anche mettere `HTTPS=false`, `COOKIE_SECURE=true`).
2. **Certificato vero**: dominio + Let's Encrypt (o reverse proxy Caddy/Nginx), poi `CERT_FILE` / `KEY_FILE` o `PUBLIC_URL`.

### Raggiungere il server da internet

- Stessa rete (ufficio/casa): usa il link "Rete locale".
- Da fuori: inoltra la porta `3000` sul router verso il tuo PC **oppure** usa un tunnel (consigliato).
- Il video va direttamente da browser a browser (WebRTC). Con reti molto restrittive può servire un server TURN: imposta `TURN_URLS`, `TURN_USER`, `TURN_PASS`.

---

## Configurazione (`.env`)

| Variabile                             | Default       | Significato                                                                                              |
| ------------------------------------- | ------------- | -------------------------------------------------------------------------------------------------------- |
| `PORT`                                | `3000`        | Porta del server (quella del cliente)                                                                    |
| `HTTPS`                               | `true`        | HTTPS con certificato autofirmato automatico                                                             |
| `CERT_FILE` / `KEY_FILE`              | _(vuoto)_     | Tuo certificato (niente avviso per il cliente)                                                           |
| `LOCAL_HTTP_PORT`                     | `PORT+1`      | Porta HTTP solo-locale per il pannello host (`0` = disattiva)                                            |
| `ACCESS_TOKEN`                        | _(vuoto)_     | Link fisso (16-64 caratteri `A-Z a-z 0-9 - _`). Vuoto = generato e salvato in `backend/data/access.json` |
| `PUBLIC_URL`                          | _(vuoto)_     | Indirizzo pubblico (dominio/tunnel) da usare nel link                                                    |
| `OTP_TTL_SECONDS`                     | `90`          | Durata del codice OTP                                                                                    |
| `SESSION_IDLE_MINUTES`                | `30`          | Minuti di inattività prima che la sessione scada                                                         |
| `MAX_FPS`                             | `15`          | Frame al secondo massimi (1-60)                                                                          |
| `MAX_BITRATE_KBPS`                    | `3000`        | Bitrate massimo del video                                                                                |
| `STUN_URLS`                           | Google STUN   | Server STUN (separati da virgola)                                                                        |
| `TURN_URLS`, `TURN_USER`, `TURN_PASS` | _(vuoto)_     | Server TURN opzionale                                                                                    |
| `COOKIE_SECURE`                       | `false`       | `true` se usi un proxy HTTPS (con HTTPS integrato è automatico)                                          |
| `TZ`                                  | `Europe/Rome` | Fuso orario del cron di pulizia                                                                          |

---

## 🖱️ Controllo remoto (facoltativo)

Un sito web non può muovere il mouse di un altro PC, quindi per il controllo serve un piccolo programma
**da avviare sul PC del cliente** (cartella `agent/`, Node.js + libreria `@nut-tree-fork/nut-js`).
Il controllo parte **solo se il cliente fa tutti questi passaggi**:

1. condivide **l'intero schermo** (non una finestra o una scheda);
2. nella pagina web preme **«Voglio dare il controllo al tecnico»**: compare un **codice di 8 caratteri** (monouso, valido 5 minuti);
3. **scarica e avvia il programma** sul proprio PC (due modi, vedi sotto), poi scrive il codice quando richiesto;
4. il tecnico preme **«Richiedi controllo»** nel pannello host → al cliente compare la richiesta e deve premere **«Consenti»**.

### Windows: un unico file, niente da installare

Se hai generato il pacchetto Windows (vedi sotto), la pagina del cliente mostra un pulsante
**«Scarica il programma (.zip)»** al posto delle istruzioni Node.js. Per il cliente il percorso diventa:
scarica lo zip → estrae la cartella → doppio clic su `Avvia.bat` → scrive il codice. Niente Node.js,
niente `npm install`, niente riga di comando da copiare. Resta un **doppio clic in più** rispetto a un
singolo link (serve perché un sito web non può eseguire programmi da solo, per sicurezza del browser),
ma non richiede competenze tecniche.

Per generarlo (lo fai **tu, una volta sola**, non il cliente):

```bash
cd agent
npm install
node build-win.js https://TUO-INDIRIZZO-PUBBLICO:3000 --insecure   # --insecure solo col certificato autofirmato
```

Questo crea `agent/dist/agente-windows.zip`: il server lo serve automaticamente appena il file esiste
(se manca, la pagina del cliente torna a mostrare solo le istruzioni Node.js qui sotto, senza errori).
Passare l'indirizzo come argomento serve solo a **precompilarlo** nell'eseguibile, così il cliente deve
scrivere solo il codice; se non lo passi, l'exe funziona lo stesso ma chiede anche l'indirizzo, come il
programma Node.js.

> Nota tecnica: l'eseguibile è generato con [`pkg`](https://github.com/yao-pkg/pkg) e include tutto
> Node.js; la libreria che muove mouse e tastiera è nativa (non JavaScript) e per questo non può stare
> dentro un singolo .exe compresso — è nella cartella `node_modules/` accanto a lui dentro lo zip. Non è
> stato testato su Windows reale in questo ambiente di sviluppo (solo build e verifica del formato del
> file): prima di darlo a un cliente, prova tu stesso il pacchetto su un PC Windows.

### Mac, Linux, o se preferisci il metodo manuale

3bis. scarica `agent.js` + `package.json` dalla pagina, esegue `npm install` e avvia
   `node agent.js --url https://INDIRIZZO:3000 --code CODICE` (con certificato autofirmato serve anche `--insecure`; la pagina mostra già il comando giusto).

Mentre il controllo è attivo:

- la pagina del cliente mostra un riquadro rosso **«Il tecnico sta controllando il tuo computer»** con il pulsante **«Revoca il controllo ora»**;
- il programma stampa **«CONTROLLO REMOTO ATTIVO»**; si ferma con **Q + Invio**, **Ctrl+C** o chiudendo la finestra;
- il controllo si spegne da solo se il cliente smette di condividere, chiude la pagina, il tecnico si scollega o il programma si chiude;
- il programma **non si installa, non parte da solo e non resta attivo** dopo la chiusura.

Lato tecnico: nel pannello live compare il pulsante **Richiedi controllo**. A controllo attivo muovi/clicca sul video e,
cliccando sull'area del video, anche la tastiera viene inviata (rotella inclusa).

Note e limiti:

- Il mouse viene mappato sullo **schermo principale** del cliente: se condivide un secondo monitor il pulsante resta disattivo (le proporzioni non coincidono).
- Il server inoltra solo comandi validi (movimento, click, rotella, tasti) e solo a controllo attivo; qualsiasi altro messaggio viene scartato.
- Tentativi errati del codice sono limitati come per l'OTP (5 errori → blocco 5 minuti).
- **macOS**: il Terminale va abilitato in *Impostazioni → Privacy e sicurezza → Accessibilità*. **Linux**: funziona su sessioni X11; su Wayland il controllo può essere bloccato dal sistema.
- Usa questa funzione solo con clienti che sanno cosa stai facendo e hanno dato il permesso.

---

## Sicurezza

- **Due fattori**: serve il link segreto (48 caratteri casuali) _e_ il codice OTP.
- **OTP monouso**: dopo l'uso ne viene generato subito un altro; scade dopo `OTP_TTL_SECONDS` e cambia dopo 5 tentativi errati.
- **Anti brute-force**: 5 errori dallo stesso IP → blocco di 5 minuti.
- **Un cliente alla volta**: un nuovo accesso chiude il precedente.
- **Pannello host solo da questo PC**: da internet (o dietro proxy/tunnel) restituisce 404.
- Cookie `HttpOnly` + `SameSite=Strict` (+ `Secure` in HTTPS), controllo `Origin` su POST e WebSocket, header di sicurezza (CSP, `X-Frame-Options`…).
- Il **cliente decide cosa condividere** e può fermare la condivisione in qualsiasi momento; tu puoi **disconnetterlo** dal pannello.
- Il link si può **rigenerare** dal pannello host (il vecchio smette subito di funzionare).
- Il video passa direttamente tra i due browser (cifrato da WebRTC), non dal server.

Se usi un reverse proxy sullo stesso PC, deve inviare l'header `X-Forwarded-For`: così le richieste non vengono scambiate per locali.

---

## Cestino automatico

Ogni sessione chiusa viene registrata come piccolo file JSON in `backend/trash/` (IP, orari, motivo).
Un cron (`node-cron`) **svuota il cestino ogni notte alle 00:00**, quindi non resta nessuna cronologia.

---

## Struttura del progetto

```
.
├── .env.example
├── agent/            programma facoltativo per il controllo remoto (PC del cliente)
│   ├── agent.js
│   ├── package.json
│   ├── build-win.js  genera agent/dist/agente-windows.zip (lo esegui tu una volta)
│   └── dist/         pacchetto Windows generato (non versionato)
├── backend/
│   ├── package.json
│   ├── server.js     avvio, rotte HTTP/HTTPS, cron, log
│   ├── config.js     lettura del file .env
│   ├── tls.js        certificato HTTPS autofirmato
│   ├── auth.js       link segreto, OTP, sessioni, anti brute-force
│   ├── ws.js         signaling WebRTC + controllo remoto (cliente ⇄ host ⇄ agent)
│   ├── trash.js      cestino sessioni
│   ├── network.js    IP locale e pubblico
│   ├── data/         link e certificato salvati
│   └── trash/        cestino
└── frontend/
    ├── html/         index · login · share (cliente) · host · 404 · 429 · 500
    ├── css/style.css
    └── js/           index.js · login.js · share.js (cliente) · host.js
```

---

## Problemi comuni

- **Il cliente non vede il pulsante / dice "solo connessioni sicure"**: ha aperto un link `http://`. Dagli quello `https://` (vedi sezione HTTPS).
- **Avviso del browser sul link**: è il certificato autofirmato; vedi sezione HTTPS per eliminarlo.
- **Il cliente è su telefono/tablet**: i browser mobili di solito non permettono di condividere lo schermo. Serve un computer.
- **Schermo nero o "collegamento in corso" che non finisce**: rete molto restrittiva → configura un server TURN. Controlla anche che il cliente abbia scelto una finestra/schermo.
- **Se il cliente condivide una singola finestra** vedrai solo quella: se la minimizza, il video si ferma.
- **Stream lento**: abbassa `MAX_FPS` o `MAX_BITRATE_KBPS`.
- **Porta già in uso**: cambia `PORT` (e `LOCAL_HTTP_PORT`) nel file `.env`.
- **Ho perso il link o il codice**: sono nel pannello host e nella console all'avvio.
