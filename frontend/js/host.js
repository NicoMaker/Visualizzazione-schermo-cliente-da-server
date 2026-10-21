/* Lato HOST: mostra codice/link e, quando il cliente condivide, il suo schermo (WebRTC). */
(() => {
  const $ = (id) => document.getElementById(id);
  const els = {
    body: $("body"),
    setup: $("setup"),
    live: $("live"),
    video: $("remote"),
    stage: $("stage"),
    liveInfo: $("liveInfo"),
    liveStats: $("liveStats"),
    liveKick: $("liveKick"),
    fsBtn: $("fsBtn"),
    badge: $("stateBadge"),
    otpCode: $("otpCode"),
    otpBar: $("otpBar"),
    otpTimer: $("otpTimer"),
    otpNew: $("otpNew"),
    links: $("links"),
    linkNote: $("linkNote"),
    linkNew: $("linkNew"),
    certNote: $("certNote"),
    sessionEmpty: $("sessionEmpty"),
    sessionBox: $("sessionBox"),
    sState: $("sState"),
    sIp: $("sIp"),
    sBrowser: $("sBrowser"),
    sSince: $("sSince"),
    kickBtn: $("kickBtn"),
  };

  let state = null; // ultimo stato dal server
  let renderedLinks = "";
  let showingLive = false;

  const post = (url, body) =>
    fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(body || {}),
    }).then((r) => r.json().catch(() => ({})));

  /* ------------------------------------------------------------ */
  /* Stato (HTTP, ogni secondo): OTP, link, dati del cliente       */
  /* ------------------------------------------------------------ */
  function renderLinks(links) {
    const entries = [
      ["Da internet", links.public],
      ["Rete locale (stesso Wi-Fi/ufficio)", links.local],
      ["Prova su questo PC", links.localhost],
    ].filter(([, url]) => url);

    const signature = JSON.stringify(entries);
    if (signature === renderedLinks) return;
    renderedLinks = signature;

    els.links.textContent = "";
    for (const [label, url] of entries) {
      const item = document.createElement("div");
      item.className = "link-item";

      const text = document.createElement("div");
      const small = document.createElement("small");
      small.textContent = label;
      const code = document.createElement("code");
      code.textContent = url;
      text.append(small, code);

      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "btn ghost";
      copy.textContent = "Copia";
      copy.addEventListener("click", async () => {
        try {
          await navigator.clipboard.writeText(url);
          copy.textContent = "Copiato ✓";
        } catch {
          const range = document.createRange();
          range.selectNodeContents(code);
          const sel = getSelection();
          sel.removeAllRanges();
          sel.addRange(range);
          copy.textContent = "Selezionato";
        }
        setTimeout(() => (copy.textContent = "Copia"), 1500);
      });

      item.append(text, copy);
      els.links.append(item);
    }
  }

  function describe(s) {
    if (!s) return "Nessuno è collegato.";
    if (peer.connected === false)
      return "Il cliente ha lasciato la pagina (può ricaricarla)";
    if (!s.sharing)
      return "Ha inserito il codice, in attesa che scelga cosa condividere";
    return rtc.live
      ? "Sta condividendo lo schermo"
      : "Sta condividendo, collegamento in corso…";
  }

  function render(next) {
    state = next;

    els.otpCode.textContent = state.otp.code;
    els.otpTimer.textContent = "Scade tra " + state.otp.remaining + " s";
    els.otpBar.style.width =
      Math.round((state.otp.remaining / state.otp.ttl) * 100) + "%";
    els.otpBar.classList.toggle("low", state.otp.remaining <= 15);

    renderLinks(state.links);
    els.linkNew.disabled = state.tokenFixed;
    els.linkNote.textContent = state.tokenFixed
      ? "Link fisso impostato nel file .env"
      : "Il link resta valido finché non lo rigeneri.";
    els.certNote.hidden = !state.selfSigned;

    const s = state.session;
    els.badge.textContent = !s
      ? "In attesa"
      : rtc.live
        ? "● Schermo in diretta"
        : "● Cliente collegato";
    els.badge.classList.toggle("live", !!s);
    els.sessionEmpty.hidden = !!s;
    els.sessionBox.hidden = !s;
    if (s) {
      els.sState.textContent = describe(s);
      els.sIp.textContent = s.ip;
      els.sBrowser.textContent = s.browser || "—";
      els.sSince.textContent = new Date(s.since).toLocaleTimeString("it-IT");
      els.liveInfo.textContent = "· " + s.ip;
    }
    updateView();
  }

  async function refresh() {
    try {
      const res = await fetch("/api/host/state", {
        credentials: "same-origin",
      });
      if (res.ok) render(await res.json());
    } catch {
      els.badge.textContent = "Server non raggiungibile";
      els.badge.classList.remove("live");
    }
  }

  /** Alterna la schermata di attesa e quella dello schermo live. */
  function updateView() {
    const live = rtc.live && !!(state && state.session);
    if (live === showingLive) return;
    showingLive = live;
    els.live.hidden = !live;
    els.setup.hidden = live;
    els.body.classList.toggle("is-live", live);
    if (live) {
      els.video.play().catch(() => {});
    } else if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
    }
  }

  /* ------------------------------------------------------------ */
  /* Signaling + WebRTC                                           */
  /* ------------------------------------------------------------ */
  let ws = null;
  let retries = 0;
  let iceServers = [];
  let peer = { connected: false, sharing: false };
  const rtc = { pc: null, id: null, pending: [], live: false };
  let queue = Promise.resolve(); // i messaggi di signaling vengono elaborati in ordine
  let statsTimer = null;
  let lastBytes = 0;
  let lastStatsAt = 0;

  const send = (obj) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  };

  function closePc() {
    clearInterval(statsTimer);
    if (rtc.pc) {
      rtc.pc.ontrack = null;
      rtc.pc.onicecandidate = null;
      rtc.pc.onconnectionstatechange = null;
      try {
        rtc.pc.close();
      } catch {
        /* già chiusa */
      }
    }
    rtc.pc = null;
    rtc.id = null;
    rtc.pending = [];
    rtc.live = false;
    els.video.srcObject = null;
    els.liveStats.textContent = "";
    if (state) render(state);
    else updateView();
  }

  function startStats(pc) {
    clearInterval(statsTimer);
    lastBytes = 0;
    lastStatsAt = 0;
    statsTimer = setInterval(async () => {
      if (rtc.pc !== pc) return;
      try {
        const report = await pc.getStats();
        report.forEach((r) => {
          if (r.type !== "inbound-rtp" || r.kind !== "video") return;
          const now = performance.now();
          const kbps = lastStatsAt
            ? Math.round(
                ((r.bytesReceived - lastBytes) * 8) / (now - lastStatsAt),
              )
            : 0;
          lastBytes = r.bytesReceived;
          lastStatsAt = now;
          const size = els.video.videoWidth
            ? `${els.video.videoWidth}×${els.video.videoHeight}`
            : "";
          const fps = r.framesPerSecond
            ? `${Math.round(r.framesPerSecond)} fps`
            : "";
          els.liveStats.textContent = [size, fps, kbps ? kbps + " kbps" : ""]
            .filter(Boolean)
            .join(" · ");
        });
      } catch {
        /* statistiche non disponibili */
      }
    }, 2000);
  }

  async function onOffer(msg) {
    closePc();
    const pc = new RTCPeerConnection({ iceServers });
    rtc.pc = pc;
    rtc.id = msg.pc;

    pc.ontrack = (e) => {
      els.video.srcObject = e.streams[0] || new MediaStream([e.track]);
      els.video.play().catch(() => {});
    };
    pc.onicecandidate = (e) => {
      if (e.candidate && rtc.pc === pc)
        send({ type: "signal", pc: msg.pc, data: { candidate: e.candidate } });
    };
    pc.onconnectionstatechange = () => {
      if (rtc.pc !== pc) return;
      if (pc.connectionState === "connected") {
        startStats(pc);
      } else if (
        pc.connectionState === "failed" ||
        pc.connectionState === "closed"
      ) {
        closePc();
      }
    };

    await pc.setRemoteDescription(msg.data.sdp);
    for (const c of rtc.pending) await pc.addIceCandidate(c).catch(() => {});
    rtc.pending = [];
    await pc.setLocalDescription(await pc.createAnswer());
    send({ type: "signal", pc: msg.pc, data: { sdp: pc.localDescription } });
  }

  async function onSignal(msg) {
    const data = msg.data || {};
    if (data.sdp && data.sdp.type === "offer") return onOffer(msg);
    if (!rtc.pc || msg.pc !== rtc.id) return;
    if (data.candidate) {
      if (rtc.pc.remoteDescription)
        await rtc.pc.addIceCandidate(data.candidate).catch(() => {});
      else rtc.pending.push(data.candidate);
    }
  }

  els.video.addEventListener("playing", () => {
    rtc.live = true;
    if (state) render(state);
    else updateView();
  });

  function connect() {
    const proto = location.protocol === "https:" ? "wss" : "ws";
    ws = new WebSocket(`${proto}://${location.host}/ws/host`);

    ws.onopen = () => {
      retries = 0;
    };

    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      switch (msg.type) {
        case "hello":
          iceServers = msg.ice || [];
          break;
        case "peer":
          peer = { connected: !!msg.connected, sharing: !!msg.sharing };
          if (!peer.sharing || !peer.connected) {
            // Il cliente non condivide più (o è uscito): chiudo il collegamento video
            if (rtc.pc && !peer.sharing) closePc();
          }
          if (state) render(state);
          break;
        case "signal":
          queue = queue.then(() => onSignal(msg)).catch(() => {});
          break;
        default:
      }
    };

    ws.onclose = (ev) => {
      closePc();
      if (ev.code === 4002) {
        els.badge.textContent = "Aperto in un'altra scheda";
        els.badge.classList.remove("live");
        return;
      }
      retries += 1;
      setTimeout(connect, Math.min(1000 * retries, 5000));
    };
  }

  /* ------------------------------------------------------------ */
  /* Azioni                                                       */
  /* ------------------------------------------------------------ */
  els.otpNew.addEventListener("click", async () => {
    await post("/api/host/otp");
    refresh();
  });

  els.linkNew.addEventListener("click", async () => {
    if (
      !confirm(
        "Rigenerando il link, quello vecchio smette di funzionare. Continuare?",
      )
    )
      return;
    const r = await post("/api/host/link");
    if (r.ok === false && r.error) alert(r.error);
    refresh();
  });

  async function kick() {
    await post("/api/host/disconnect");
    closePc();
    refresh();
  }
  els.kickBtn.addEventListener("click", kick);
  els.liveKick.addEventListener("click", kick);

  els.fsBtn.addEventListener("click", () => {
    if (document.fullscreenElement) document.exitFullscreen();
    else els.stage.requestFullscreen?.().catch(() => {});
  });

  refresh();
  setInterval(refresh, 1000);
  connect();
})();
