(() => {
  const form = document.getElementById("loginForm");
  const input = document.getElementById("otp");
  const btn = document.getElementById("submitBtn");
  const msg = document.getElementById("msg");

  // Il token segreto è l'ultimo pezzo dell'indirizzo: /c/<token>
  const token = location.pathname.split("/").filter(Boolean).pop() || "";
  let busy = false;

  function show(text, type) {
    msg.textContent = text;
    msg.className = "msg " + type;
    msg.hidden = false;
  }

  async function submit() {
    if (busy) return;
    const otp = input.value.replace(/\D/g, "");
    if (otp.length !== 6) {
      show("Inserisci le 6 cifre del codice.", "error");
      return;
    }

    busy = true;
    btn.disabled = true;
    btn.textContent = "Verifica…";
    try {
      const res = await fetch("/api/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({ token, otp }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok && data.ok) {
        show("Codice corretto, un attimo…", "ok");
        location.href = data.redirect || "/viewer";
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
      btn.textContent = "Continua";
    }
  }

  input.addEventListener("input", () => {
    input.value = input.value.replace(/\D/g, "").slice(0, 6);
    if (input.value.length === 6) submit();
  });

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    submit();
  });
})();
