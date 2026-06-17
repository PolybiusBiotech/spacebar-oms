function escapeHtml(v) {
  return String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const pending = document.getElementById("pending");
const paying  = document.getElementById("paying");
const collect = document.getElementById("collect");

async function refresh() {
  try {
    const res  = await fetch("/api/orders");
    const data = await res.json();
    const orders = data.orders ?? [];

    const byState = { pending: [], processing: [], collect: [] };
    for (const o of orders) {
      if (byState[o.state]) byState[o.state].push(o);
    }

    pending.innerHTML = byState.pending.map(o =>
      `<div class="order-name">${escapeHtml(o.order_name)}</div>`).join("") || "";
    paying.innerHTML  = byState.processing.map(o =>
      `<div class="order-name">${escapeHtml(o.order_name)}</div>`).join("") || "";
    collect.innerHTML = byState.collect.map(o =>
      `<div class="order-name">${escapeHtml(o.order_name)}</div>`).join("") || "";
  } catch {
    // silent — screen keeps showing last good state
  }
}

refresh();
setInterval(refresh, 3000);
