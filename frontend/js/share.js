/* Lato CLIENTE: sceglie cosa condividere e lo invia all'host in WebRTC. */
(() => {
  const $ = (id) => document.getElementById(id);
  const els = {
    icon: $("icon"),
    title: $("title"),
    lead: $("lead"),
    notes: $("notes"),
    line: $("statusLine"),
    dot: $("statusDot"),
    text: $("statusText"),
    msg: $("msg"),
    start: $("startBtn"),
    stop: $("stopBtn"),
    home: $("homeLink"),
  };

  let ws = null;
  let retries = 0;
  let leaving = false;
  let ended = false; // sessione chiusa: niente più riconnessioni

  let cfg = { ice: [], maxFps: 15, maxBitrate: 3_000_000 };
  let hostPresent = false;
  let stream = null;
  let pc = null;
  let pcId = null;
  let pendingIce = [];
  let redialTimer = null;
  let redials = 0;

  /* ------------------------------------------------------------ */
  /* Interfaccia                                                  */
  /* ------------------------------------------------------------ */
  function status(text, state) {
    els.line.hidden = false;
    els.text.textContent = text;
    els.dot.className = "dot" + (state ? " " + state : "");
  }

  function message(text, type = "error") {
    els.msg.textContent = text;
    els.msg.className = "msg " + type;
    els.msg.hidden = !text;
  }

  function renderSharing() {
    const live = !!stream;
    els.start.hidden = live;
    els.stop.hidden = !live;
    els.notes.hidden = live;
    els.icon.dataset.state = live ? "live" : "";
    els.title.textContent = live
      ? "Stai condividendo lo schermo"
      : "Condividi il tuo schermo";
    els.lead.innerHTML = live
      ? "Il tecnico vede <strong>solo</strong> ciò che hai scelto di condividere. Non può controllare il tuo computer."
      : "Il tecnico potrà <strong>vedere</strong> il tuo schermo. Non potrà muovere il mouse né usare la tastiera.";

    if (!live) {
      status(
        hostPresent ? "Collegato al tecnico" : "Codice accettato",
        hostPresent ? "on" : "",
      );
    } else if (pc && pc.connectionState === "connected") {
      status("Il tecnico sta guardando il tuo schermo", "on");
    } else if (!hostPresent) {
      status("Condivisione pronta, in attesa che il tecnico si colleghi…", "");
    } else {
      status("Collegamento con il tecnico in corso…", "");
    }
  }

  function finish(title, text) {
    ended = true;
    stopStream();
    closePc();
    els.icon.dataset.state = "locked";
    els.title.textContent = title;
    els.lead.textContent = text;
    els.notes.hidden = true;
    els.line.hidden = true;
    els.start.hidden = true;
    els.stop.hidden = true;
    els.home.hidden = false;
    message("");
  }

  /* ------------------------------------------------------------ */
  /* WebSocket (signaling)                                        */
  /* ------------------------------------------------------------ */
  const send = (obj) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };

  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws/share`);

    ws.onopen = () => {
      retries = 0;
      if (stream) send({ type: "sharing", active: true }); // dopo una riconnessione
    };

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      onMessage(msg);
    };

    ws.onclose = (ev) => {
      if (leaving || ended) return;
      if (ev.code === 4001) {
        return finish(
          "Sessione terminata",
          `${ev.reason ? "Motivo: " + ev.reason + ". " : ""}La condivisione è stata chiusa.`,
        );
      }
      if (ev.code === 4002) {
        return finish(
          "Pagina aperta altrove",
          "Hai aperto questa pagina in un'altra scheda: usa quella.",
        );
      }
      if (retries >= 8) {
        return finish(
          "Connessione persa",
          "Non riesco più a raggiungere il server. Riapri il link e inserisci un nuovo codice.",
        );
      }
      retries += 1;
      if (!stream) status("Riconnessione…", "");
      setTimeout(connect, Math.min(1000 * retries, 5000));
    };
  }

  function onMessage(msg) {
    switch (msg.type) {
      case "hello":
        cfg = {
          ice: msg.ice || [],
          maxFps: msg.maxFps || cfg.maxFps,
          maxBitrate: msg.maxBitrate || cfg.maxBitrate,
        };
        setHostPresent(!!msg.hostPresent);
        break;
      case "peer":
        setHostPresent(!!msg.hostPresent);
        break;
      case "signal":
        handleSignal(msg).catch(() => {});
        break;
      default:
    }
  }

  function setHostPresent(value) {
    const changed = value !== hostPresent;
    hostPresent = value;
    if (!hostPresent) {
      closePc();
    } else if (stream && (changed || !pc)) {
      redials = 0;
      negotiate();
    }
    renderSharing();
  }

  /* ------------------------------------------------------------ */
  /* WebRTC                                                       */
  /* ------------------------------------------------------------ */
  function closePc() {
    clearTimeout(redialTimer);
    if (pc) {
      pc.onicecandidate = null;
      pc.onconnectionstatechange = null;
      try {
        pc.close();
      } catch {
        /* già chiusa */
      }
    }
    pc = null;
    pcId = null;
    pendingIce = [];
  }

  async function negotiate() {
    if (!stream || !hostPresent) return;
    closePc();

    const id = Math.random().toString(36).slice(2, 12);
    const conn = new RTCPeerConnection({ iceServers: cfg.ice });
    pc = conn;
    pcId = id;

    for (const track of stream.getTracks()) conn.addTrack(track, stream);

    conn.onicecandidate = (e) => {
      if (e.candidate && pcId === id)
        send({ type: "signal", pc: id, data: { candidate: e.candidate } });
    };

    conn.onconnectionstatechange = () => {
      if (pc !== conn) return;
      renderSharing();
      if (
        conn.connectionState === "failed" ||
        conn.connectionState === "disconnected"
      ) {
        scheduleRedial(conn.connectionState === "failed" ? 500 : 4000);
      } else if (conn.connectionState === "connected") {
        redials = 0;
        clearTimeout(redialTimer);
      }
    };

    try {
      await conn.setLocalDescription(await conn.createOffer());
      if (pc !== conn) return;
      send({ type: "signal", pc: id, data: { sdp: conn.localDescription } });
      limitBitrate(conn);
    } catch {
      if (pc === conn) scheduleRedial(1500);
    }
  }

  async function limitBitrate(conn) {
    try {
      const sender = conn
        .getSenders()
        .find((s) => s.track && s.track.kind === "video");
      if (!sender) return;
      const params = sender.getParameters();
      if (!params.encodings || !params.encodings.length)
        params.encodings = [{}];
      params.encodings[0].maxBitrate = cfg.maxBitrate;
      params.encodings[0].maxFramerate = cfg.maxFps;
      params.degradationPreference = "maintain-resolution"; // il testo resta leggibile
      await sender.setParameters(params);
    } catch {
      /* non tutti i browser supportano tutti i parametri */
    }
  }

  function scheduleRedial(delay) {
    clearTimeout(redialTimer);
    if (!stream || !hostPresent || redials >= 5) return;
    redialTimer = setTimeout(() => {
      if (!stream || !hostPresent) return;
      if (pc && pc.connectionState === "connected") return;
      redials += 1;
      negotiate();
    }, delay);
  }

  async function handleSignal(msg) {
    if (!pc || msg.pc !== pcId) return;
    const conn = pc;
    const data = msg.data || {};

    if (data.sdp) {
      await conn.setRemoteDescription(data.sdp);
      for (const c of pendingIce) await conn.addIceCandidate(c).catch(() => {});
      pendingIce = [];
    } else if (data.candidate) {
      if (conn.remoteDescription)
        await conn.addIceCandidate(data.candidate).catch(() => {});
      else pendingIce.push(data.candidate);
    }
  }

  /* ------------------------------------------------------------ */
  /* Condivisione dello schermo                                   */
  /* ------------------------------------------------------------ */
  function stopStream() {
    if (stream) {
      for (const t of stream.getTracks()) {
        t.onended = null;
        t.stop();
      }
    }
    stream = null;
  }

  async function startShare() {
    message("");
    els.start.disabled = true;
    try {
      // Chiedo sempre l'INTERO SCHERMO: il browser mostra la scelta già
      // posizionata su "Schermo intero", al cliente basta confermare con "Condividi".
      const opts = {
        video: {
          frameRate: { ideal: cfg.maxFps, max: cfg.maxFps },
          displaySurface: "monitor",
        },
        audio: false,
        monitorTypeSurfaces: "include",
        selfBrowserSurface: "exclude",
        surfaceSwitching: "exclude",
        systemAudio: "exclude",
      };
      try {
        stream = await navigator.mediaDevices.getDisplayMedia(opts);
      } catch (e) {
        // browser che non accetta le opzioni extra: riprovo con quelle base
        if (
          e &&
          (e.name === "TypeError" || e.name === "OverconstrainedError")
        ) {
          stream = await navigator.mediaDevices.getDisplayMedia({
            video: { frameRate: { ideal: cfg.maxFps, max: cfg.maxFps } },
            audio: false,
          });
        } else {
          throw e;
        }
      }
    } catch (err) {
      stream = null;
      els.start.disabled = false;
      if (err && err.name === "NotAllowedError") {
        message(
          'Condivisione annullata. Premi di nuovo il pulsante e poi "Condividi".',
        );
      } else {
        message(
          "Non riesco ad avviare la condivisione: " +
            (err && err.message ? err.message : "errore sconosciuto"),
        );
      }
      return;
    }
    els.start.disabled = false;

    const [track] = stream.getVideoTracks();
    if ("contentHint" in track) track.contentHint = "detail"; // privilegia la nitidezza del testo
    track.onended = () => stopSharingOnly(); // il cliente ha premuto "Interrompi" nel browser

    send({ type: "sharing", active: true });
    renderSharing();
    if (hostPresent) {
      redials = 0;
      negotiate();
    }
  }

  /** Smette di condividere ma resta collegato: può ripartire con il pulsante. */
  function stopSharingOnly() {
    stopStream();
    closePc();
    send({ type: "sharing", active: false });
    message("Hai interrotto la condivisione. Se vuoi, puoi riavviarla.", "ok");
    renderSharing();
  }

  async function leave() {
    leaving = true;
    ended = true;
    stopStream();
    closePc();
    try {
      await fetch("/api/logout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: "{}",
      });
    } catch {
      /* esco comunque */
    }
    if (ws) ws.close();
    finish(
      "Condivisione terminata",
      "Il tecnico non vede più il tuo schermo. Puoi chiudere questa pagina.",
    );
  }

  /* ------------------------------------------------------------ */
  /* Avvio                                                        */
  /* ------------------------------------------------------------ */
  els.start.addEventListener("click", startShare);
  els.stop.addEventListener("click", leave);
  window.addEventListener("beforeunload", () => {
    leaving = true;
  });

  if (!(navigator.mediaDevices && navigator.mediaDevices.getDisplayMedia)) {
    els.start.hidden = true;
    els.notes.hidden = true;
    message(
      window.isSecureContext
        ? "Questo dispositivo o browser non permette di condividere lo schermo. Usa un computer con Chrome, Edge, Firefox o Safari aggiornati (da telefono di solito non è disponibile)."
        : "Il browser consente di condividere lo schermo solo su connessioni sicure (HTTPS). Chiedi al tecnico un link che inizi con https://.",
    );
  }

  renderSharing();
  connect();
})();
