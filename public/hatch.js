const hatchNumberEl  = document.getElementById("hatch-number");
const orderSectionEl = document.getElementById("order-section");

// Read hatch number from URL path e.g. /hatch/3
const hatch = Number(location.pathname.match(/\/hatch\/(\d+)/)?.[1]);

if (!hatch) {
  hatchNumberEl.textContent = "?";
} else {
  hatchNumberEl.textContent = hatch;
  document.title = `Hatch ${hatch} — Space Bar`;
}

let lastOrderRef = null;
let refreshDelay = 3000;
const REFRESH_BASE = 3000;
const REFRESH_MAX  = 30_000;

async function refresh() {
  try {
    const res  = await fetch("/api/orders");
    if (!res.ok) throw new Error(`${res.status}`);
    const data = await res.json();
    const orders = data.orders ?? [];

    refreshDelay = REFRESH_BASE;

    const order = orders.find(o => o.state === "collect" && o.hatch === hatch) ?? null;
    const ref = order?.order_ref ?? null;

    if (ref !== lastOrderRef) {
      lastOrderRef = ref;
      if (order) {
        orderSectionEl.innerHTML = `
          <div class="order-name">${escapeHtml(order.order_name)}</div>
          <div class="order-sub">Ready to collect</div>`;
      } else {
        orderSectionEl.innerHTML = `<div class="empty">No order assigned</div>`;
      }
    }
  } catch {
    refreshDelay = Math.min(refreshDelay * 2, REFRESH_MAX);
  }
  setTimeout(refresh, refreshDelay);
}

function escapeHtml(v) {
  return String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

refresh();
