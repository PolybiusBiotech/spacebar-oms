const scanInput = document.getElementById("scan-input");
const screen    = document.getElementById("screen");

let resetTimer = null;

function escapeHtml(v) {
  return String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

// Keep the hidden input focused so it captures scanner keystrokes
function refocus() { scanInput.focus(); }
document.addEventListener("click", refocus);
document.addEventListener("visibilitychange", () => { if (!document.hidden) refocus(); });
refocus();

scanInput.addEventListener("keydown", e => {
  if (e.key === "Enter") {
    e.preventDefault();
    const raw = scanInput.value.trim();
    scanInput.value = "";
    if (raw) processScan(raw);
  }
});

async function processScan(raw) {
  clearTimeout(resetTimer);

  // Strip KIOSK: prefix if present
  const orderRef = raw.startsWith("KIOSK:") ? raw.slice(6) : raw;

  try {
    const res = await fetch("/api/orders");
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
    const orders = data.orders ?? [];

    const order = orders.find(o => o.order_ref === orderRef);

    if (!order) {
      showError("Receipt not found");
    } else if (order.state !== "collect") {
      showError("Order not ready yet");
    } else if (!order.collection_point) {
      showError("No collection point assigned");
    } else {
      showResult(order.order_name, order.collection_point);
    }
  } catch {
    showError("Connection error");
  }

  resetTimer = setTimeout(showIdle, 12_000);
}

function showIdle() {
  screen.innerHTML = `
    <div class="idle-icon">▤</div>
    <div class="idle-prompt">Scan receipt</div>`;
}

function showResult(orderName, collectionPoint) {
  screen.innerHTML = `
    <div class="result-order">${escapeHtml(orderName)}</div>
    <div class="result-label">Collection Point</div>
    <div class="result-cp">${escapeHtml(String(collectionPoint))}</div>`;
}

function showError(msg) {
  screen.innerHTML = `<div class="error-msg">${escapeHtml(msg)}</div>`;
}
