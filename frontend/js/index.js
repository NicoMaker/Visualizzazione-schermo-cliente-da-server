// Mostra il pulsante del pannello host se la pagina è aperta da un dispositivo autorizzato
// oppure se il server ha l'accesso con password attivo (HOST_PASSWORD)
fetch("/api/host/info", { credentials: "same-origin" })
  .then((res) => (res.ok ? res.json() : null))
  .then((info) => {
    if (info && (info.authorized || info.loginAvailable))
      document.getElementById("hostLink").hidden = false;
  })
  .catch(() => {});
