const messageEl = document.getElementById("message");
const subtitleEl = document.getElementById("subtitle");
const helpBtn = document.getElementById("help-btn");

function connect() {
  const es = new EventSource("/summon/events");

  es.onmessage = e => {
    const { message } = JSON.parse(e.data);
    const isDefault = !message || message === "PAY HERE";
    messageEl.textContent = isDefault ? "PAY HERE" : message;
    messageEl.classList.toggle("pay-here", isDefault);
    subtitleEl.classList.toggle("visible", isDefault);
  };

  es.onerror = () => {
    es.close();
    setTimeout(connect, 3000);
  };
}

connect();

helpBtn.addEventListener("click", () => {
  fetch("/summon/help", { method: "POST" });
});
