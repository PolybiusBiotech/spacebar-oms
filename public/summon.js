const messageEl = document.getElementById("message");
const subtitleEl = document.getElementById("subtitle");
const helpBtn = document.getElementById("help-btn");

let currentMessage = "PAY HERE";
let orderLoadedTimer = null;

function applyMessage(msg) {
  const isDefault = !msg || msg === "PAY HERE";
  messageEl.textContent = isDefault ? "PAY HERE" : msg;
  messageEl.className = isDefault ? "pay-here" : "";
  subtitleEl.textContent = "Scan order slip";
  subtitleEl.classList.toggle("visible", isDefault);
}

function showOrderLoaded(orderRef) {
  clearTimeout(orderLoadedTimer);
  messageEl.textContent = orderRef;
  messageEl.className = "order-loaded";
  subtitleEl.textContent = "PLEASE WAIT";
  subtitleEl.classList.add("visible");
  orderLoadedTimer = setTimeout(() => {
    orderLoadedTimer = null;
    applyMessage(currentMessage);
  }, 30000);
}

function connect() {
  const es = new EventSource("/summon/events");

  es.onmessage = e => {
    const { message } = JSON.parse(e.data);
    currentMessage = message || "PAY HERE";
    if (!orderLoadedTimer) applyMessage(currentMessage);
  };

  es.addEventListener("order-loaded", e => {
    const { order_ref } = JSON.parse(e.data);
    showOrderLoaded(order_ref);
  });

  es.onerror = () => {
    es.close();
    setTimeout(connect, 3000);
  };
}

connect();

helpBtn.addEventListener("click", () => {
  fetch("/summon/help", { method: "POST" });
});
