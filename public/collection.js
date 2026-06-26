const cpNumberEl     = document.getElementById("cp-number");
const orderSectionEl = document.getElementById("order-section");

const collectionPoint = Number(location.pathname.match(/\/collection\/(\d+)/)?.[1]);

if (!collectionPoint) {
  cpNumberEl.textContent = "?";
} else {
  cpNumberEl.textContent = collectionPoint;
  document.title = `Collection Point ${collectionPoint} — Space Bar`;
}

let currentOrderRef = null;
let refreshDelay    = 3000;
const REFRESH_BASE  = 3000;
const REFRESH_MAX   = 30_000;

function escapeHtml(v) {
  return String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function showOrder(order) {
  orderSectionEl.innerHTML = `
    <div class="order-name order-name--active">${escapeHtml(order.order_name)}</div>
    <div class="order-sub">Ready to collect</div>
    <button class="clear-btn" id="clear-btn">Collected ✓</button>`;

  document.getElementById("clear-btn").addEventListener("click", () => clearOrder(order.order_ref));
  document.body.classList.add("has-order");
}

function showEmpty() {
  orderSectionEl.innerHTML = `<div class="empty">No order assigned</div>`;
  document.body.classList.remove("has-order");
}

async function clearOrder(ref) {
  const btn = document.getElementById("clear-btn");
  if (btn) btn.disabled = true;

  try {
    await fetch(`/api/orders/${encodeURIComponent(ref)}/collected`, { method: "POST" });
  } catch {}

  currentOrderRef = null;
  showEmpty();
}

async function refresh() {
  try {
    const res    = await fetch("/api/orders");
    if (!res.ok) throw new Error(`${res.status}`);
    const data   = await res.json();
    const orders = data.orders ?? [];
    refreshDelay = REFRESH_BASE;

    const order = orders.find(o => o.state === "collect" && o.collection_point === collectionPoint && o.scanned) ?? null;
    const ref   = order?.order_ref ?? null;

    if (ref !== currentOrderRef) {
      currentOrderRef = ref;
      if (order) showOrder(order);
      else        showEmpty();
    }
  } catch {
    refreshDelay = Math.min(refreshDelay * 2, REFRESH_MAX);
  }
  setTimeout(refresh, refreshDelay);
}

refresh();
