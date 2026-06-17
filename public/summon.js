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
  subtitleEl.classList.remove("soft-only");
  subtitleEl.classList.toggle("visible", isDefault);
}

function showOrderLoaded(orderRef, softOnly = false) {
  clearTimeout(orderLoadedTimer);
  messageEl.textContent = orderRef;
  messageEl.className = softOnly ? "order-loaded soft-only" : "order-loaded";
  subtitleEl.textContent = softOnly ? "TAP TO PAY" : "PLEASE WAIT";
  subtitleEl.classList.add("visible");
  subtitleEl.classList.toggle("soft-only", softOnly);
  const flashClass = softOnly ? "order-flash-soft" : "order-flash";
  document.body.classList.remove("order-flash", "order-flash-soft");
  void document.body.offsetWidth;
  document.body.classList.add(flashClass);
  document.body.addEventListener("animationend", () => document.body.classList.remove(flashClass), { once: true });
  orderLoadedTimer = setTimeout(() => {
    orderLoadedTimer = null;
    applyMessage(currentMessage);
  }, 30000);
}

function connect() {
  const es = new EventSource("/summon/events");

  es.onmessage = e => {
    try {
      const { message } = JSON.parse(e.data);
      currentMessage = message || "PAY HERE";
      if (!orderLoadedTimer) applyMessage(currentMessage);
    } catch {}
  };

  es.addEventListener("order-loaded", e => {
    try {
      const { order_ref, soft_only } = JSON.parse(e.data);
      showOrderLoaded(order_ref, soft_only);
    } catch {}
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
