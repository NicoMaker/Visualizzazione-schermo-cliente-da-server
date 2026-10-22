(() => {
  const form = document.getElementById("hostForm");
  const input = document.getElementById("pwd");
  const btn = document.getElementById("submitBtn");
  const msg = document.getElementById("msg");
  let busy = false;

  function show(text, type) {
    msg.textContent = text;
    msg.className = "msg " + type;
    msg.hidden = false;
  }

  async function submit() {
    if (busy || !input.value) return;
    busy = true;
    btn.disabled = true;
    btn.textContent = "Verifica…";
    try {
      const res = await fetch("/api/host/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ password: input.value }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        show("Accesso eseguito, un attimo…", "ok");
        location.href = data.redirect || "/";
        return;
      }
      show(data.error || "Accesso negato.", "error");
      input.value = "";
      input.focus();
    } catch {
      show("Server non raggiungibile. Riprova.", "error");
    } finally {
      busy = false;
      btn.disabled = false;
      btn.textContent = "Entra nel pannello";
    }
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    submit();
  });
})();
