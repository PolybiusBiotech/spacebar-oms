function escapeHtml(v) {
  return String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const alertsEl  = document.getElementById("alerts");
const errorEl   = document.getElementById("error");
const pendingEl = document.getElementById("pending");
const payingEl  = document.getElementById("paying");
const collectEl = document.getElementById("collect");

function renderLines(lines) {
  if (!lines?.length) return "";
  return `<ul class="order-lines">${lines.map(l =>
    `<li>${escapeHtml(l.quantity)} × ${escapeHtml(l.description)} — £${escapeHtml(l.line_total)}</li>`
  ).join("")}</ul>`;
}

function renderOrder(order) {
  const collectBtn = order.state === "processing"
    ? `<button class="collect-btn" data-collect="${escapeHtml(order.order_ref)}">Ready to collect ✓</button>`
    : "";
  return `
    <div class="order order--${escapeHtml(order.state)}" data-ref="${escapeHtml(order.order_ref)}">
      <div class="order-name">${escapeHtml(order.order_name)}</div>
      <div class="order-total">£${escapeHtml(order.total)}</div>
      ${order.state !== "unpaid" ? renderLines(order.lines) : ""}
      ${collectBtn}
    </div>`;
}

async function markCollect(ref) {
  const res = await fetch(`/api/orders/${encodeURIComponent(ref)}/collect`, { method: "POST" });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.message || `Failed: ${res.status}`);
  }
}

async function clearPrinterAlert(location) {
  await fetch("/api/printer-alert", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(location ? { location } : {})
  });
  await refresh();
}

async function refresh() {
  try {
    const res  = await fetch("/api/orders");
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    const data = await res.json();
    const orders = data.orders ?? [];
    const printerAlerts = data.printer_alerts ?? {};

    // Printer alerts banner
    const alertEntries = Object.entries(printerAlerts);
    alertsEl.innerHTML = alertEntries.map(([loc, alert]) => `
      <div class="printer-alert">
        🖨️ <strong>${escapeHtml(loc)}</strong>: ${escapeHtml(alert.message)}
        <button data-clear-alert="${escapeHtml(loc)}">Clear</button>
      </div>`).join("");

    errorEl.innerHTML = "";

    const byState = { unpaid: [], processing: [], collect: [] };
    for (const o of orders) {
      if (byState[o.state]) byState[o.state].push(o);
    }

    pendingEl.innerHTML = byState.unpaid.map(renderOrder).join("") || "<p>None</p>";
    payingEl.innerHTML  = byState.processing.map(renderOrder).join("") || "<p>None</p>";
    collectEl.innerHTML = byState.collect.map(renderOrder).join("") || "<p>None</p>";
  } catch (err) {
    errorEl.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
  }
}

document.addEventListener("click", async e => {
  const collectBtn = e.target.closest("[data-collect]");
  if (collectBtn) {
    collectBtn.disabled = true;
    try { await markCollect(collectBtn.dataset.collect); await refresh(); }
    catch (err) { alert(err.message); collectBtn.disabled = false; }
    return;
  }

  const clearBtn = e.target.closest("[data-clear-alert]");
  if (clearBtn) {
    await clearPrinterAlert(clearBtn.dataset.clearAlert);
  }
});

refresh();
setInterval(refresh, 3000);
