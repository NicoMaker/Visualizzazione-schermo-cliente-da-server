// Mostra il pulsante del pannello host solo se la pagina è aperta dal PC del server
fetch("/api/host/state", { credentials: "same-origin" })
  .then((res) => {
    if (res.ok) document.getElementById("hostLink").hidden = false;
  })
  .catch(() => {});
