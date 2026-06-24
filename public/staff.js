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
  return `<div class="order-lines">${lines.map(l =>
    `<div class="order-line">
      <span class="order-line-qty">${escapeHtml(String(l.quantity))}×</span>
      <span class="order-line-desc">${escapeHtml(l.description)}</span>
    </div>`
  ).join("")}</div>`;
}

function renderOrder(order, occupiedHatches) {
  let footer = "";
  if (order.state === "processing") {
    footer = `<button class="collect-btn" data-collect="${escapeHtml(order.order_ref)}">Ready to collect ✓</button>`;
  } else if (order.state === "collect" && order.collection_point) {
    const scanStatus = order.scanned
      ? `<span class="scan-status scan-status--scanned">Scanned — en route</span>`
      : `<span class="scan-status scan-status--waiting">Awaiting scan</span>`;
    footer = `<div class="order-hatch">Collection Point ${escapeHtml(String(order.collection_point))}${scanStatus}</div>`;
  }
  return `
    <div class="order order--${escapeHtml(order.state)}" data-ref="${escapeHtml(order.order_ref)}">
      <div class="order-name">${escapeHtml(order.order_name)}</div>
      <div class="order-total">£${escapeHtml(order.total)}</div>
      ${order.state !== "unpaid" ? renderLines(order.lines) : ""}
      ${footer}
    </div>`;
}

function renderHatchPicker(ref, occupiedHatches) {
  const buttons = Array.from({ length: 6 }, (_, i) => {
    const n = i + 1;
    const occ = occupiedHatches[n];
    if (occ) {
      return `<button class="hatch-btn hatch-btn--occupied" data-assign-hatch="${n}" data-assign-ref="${escapeHtml(ref)}" title="Will displace ${escapeHtml(occ)}">${n}<br><span style="font-size:0.7em">${escapeHtml(occ)}</span></button>`;
    }
    return `<button class="hatch-btn" data-assign-hatch="${n}" data-assign-ref="${escapeHtml(ref)}">${n}</button>`;
  }).join("");
  return `
    <div class="hatch-picker" data-picker-ref="${escapeHtml(ref)}">
      <div class="hatch-picker-label">Assign collection point:</div>
      <div class="hatch-grid">${buttons}</div>
      <button class="hatch-cancel" data-cancel-picker="${escapeHtml(ref)}">Cancel</button>
    </div>`;
}

async function markCollect(ref, collection_point) {
  const res = await fetch(`/api/orders/${encodeURIComponent(ref)}/collect`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ collection_point })
  });
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

// Refs with the hatch picker open — preserved across refreshes
const openPickers = new Set();

async function refresh() {
  try {
    const res  = await fetch("/api/orders");
    if (!res.ok) throw new Error(`Server error ${res.status}`);
    const data = await res.json();
    const orders = data.orders ?? [];
    const printerAlerts = data.printer_alerts ?? {};

    refreshDelay = REFRESH_BASE;

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

    // Build occupied hatch map: hatch# → order_name
    const occupiedHatches = {};
    for (const o of byState.collect) {
      if (o.collection_point) occupiedHatches[o.collection_point] = o.order_name;
    }

    pendingEl.innerHTML = byState.unpaid.map(o => renderOrder(o, occupiedHatches)).join("") || "<p>None</p>";
    payingEl.innerHTML  = byState.processing.map(o => renderOrder(o, occupiedHatches)).join("") || "<p>None</p>";
    collectEl.innerHTML = byState.collect.map(o => renderOrder(o, occupiedHatches)).join("") || "<p>None</p>";

    // Re-open any hatch pickers that were open before the refresh
    for (const ref of openPickers) {
      const orderEl = document.querySelector(`[data-ref="${CSS.escape(ref)}"]`);
      if (orderEl && !orderEl.querySelector(".hatch-picker")) {
        const btn = orderEl.querySelector(".collect-btn");
        if (btn) btn.replaceWith(createPickerEl(ref, occupiedHatches));
      }
    }
  } catch (err) {
    refreshDelay = Math.min(refreshDelay * 2, REFRESH_MAX);
    errorEl.innerHTML = `<div class="error-banner">${escapeHtml(err.message)}</div>`;
  }
}

function createPickerEl(ref, occupiedHatches) {
  const div = document.createElement("div");
  div.innerHTML = renderHatchPicker(ref, occupiedHatches);
  return div.firstElementChild;
}

document.addEventListener("click", async e => {
  // "Ready to collect" — show hatch picker
  const collectBtn = e.target.closest("[data-collect]");
  if (collectBtn) {
    const ref = collectBtn.dataset.collect;
    openPickers.add(ref);
    // Build current occupied map from rendered collect column
    const occupiedHatches = {};
    document.querySelectorAll(".order--collect[data-ref]").forEach(el => {
      const hatchEl = el.querySelector(".order-hatch");
      if (hatchEl) {
        const m = hatchEl.textContent.match(/\d+/);
        if (m) occupiedHatches[Number(m[0])] = el.querySelector(".order-name")?.textContent ?? "";
      }
    });
    collectBtn.replaceWith(createPickerEl(ref, occupiedHatches));
    return;
  }

  // Hatch button — assign and move to collect
  const hatchBtn = e.target.closest("[data-assign-hatch]");
  if (hatchBtn) {
    const ref              = hatchBtn.dataset.assignRef;
    const collection_point = Number(hatchBtn.dataset.assignHatch);
    hatchBtn.disabled = true;
    try {
      await markCollect(ref, collection_point);
      openPickers.delete(ref);
      await refresh();
    } catch (err) {
      alert(err.message);
      hatchBtn.disabled = false;
    }
    return;
  }

  // Cancel hatch picker
  const cancelBtn = e.target.closest("[data-cancel-picker]");
  if (cancelBtn) {
    const ref = cancelBtn.dataset.cancelPicker;
    openPickers.delete(ref);
    await refresh();
    return;
  }

  const clearBtn = e.target.closest("[data-clear-alert]");
  if (clearBtn) {
    await clearPrinterAlert(clearBtn.dataset.clearAlert);
  }
});

let refreshDelay = 3000;
const REFRESH_BASE = 3000;
const REFRESH_MAX  = 30_000;

async function refreshLoop() {
  await refresh();
  setTimeout(refreshLoop, refreshDelay);
}

refreshLoop();
