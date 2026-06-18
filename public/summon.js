const messageEl = document.getElementById("message");
const subtitleEl = document.getElementById("subtitle");
const helpBtn    = document.getElementById("help-btn");
const ghostEl    = document.getElementById("ghost-layer");

let currentMessage = "PAY HERE";
let orderLoadedTimer = null;

// Messages sent from the control page plain/serious mode — no ghost layer
const PLAIN_MESSAGES = new Set([
  "PRESENT ID",
  "REJECTED",
  "APPROVED — PAY BELOW",
  "PAYMENT PROCESSED",
  "PLEASE WAIT",
  "NEXT CUSTOMER",
]);

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Render message as HTML — maps PAY HERE to lore text, wraps quoted words so
// the content stays corporate but the quote marks look spray-painted on.
function renderMessageHtml(msg) {
  if (!msg || msg === "PAY HERE") return "INSERT PAYMENT CREDIT HERE";
  const safe = escapeHtml(msg);
  return safe.replace(/'([^']+)'/g,
    `<span class="spray-quoted"><span class="graffiti-quote">&#x201C;</span>$1<span class="graffiti-quote">&#x201D;</span></span>`);
}

function applyMessage(msg) {
  const isDefault = !msg || msg === "PAY HERE";
  const isPlain   = PLAIN_MESSAGES.has(msg);

  messageEl.innerHTML = renderMessageHtml(msg);
  messageEl.className = isDefault ? "pay-here" : "";

  subtitleEl.textContent = isDefault ? "Present order slip" : "";
  subtitleEl.classList.remove("soft-only");
  subtitleEl.classList.toggle("visible", isDefault);

  ghostEl.classList.toggle("visible", !isPlain);
}

function showOrderLoaded(orderRef, softOnly = false) {
  clearTimeout(orderLoadedTimer);
  messageEl.textContent = orderRef;
  messageEl.className = softOnly ? "order-loaded soft-only" : "order-loaded";
  subtitleEl.textContent = softOnly ? "PAY BELOW" : "PLEASE WAIT";
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
