const scanInput = document.getElementById("scan-input");
const screen    = document.getElementById("screen");

let resetTimer = null;

function escapeHtml(v) {
  return String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

// ── Maintenance overlay ──────────────────────────────────────────────────
// Ported from pay.js/status.js — this page had no maintenance handling at
// all (site-wide maintenance only; kiosk-only maintenance intentionally
// doesn't affect this screen, same as /pay and /staff).
let maintenanceGlitchTimer = null;
let maintenanceCountdownInterval = null;

function maintenanceCountdownText(reopeningAt) {
  const [hh, mm] = reopeningAt.split(":").map(Number);
  const now = new Date();
  const target = new Date(now);
  target.setHours(hh, mm, 0, 0);
  if (target <= now) target.setDate(target.getDate() + 1);
  const totalMins = Math.ceil((target - now) / 60000);
  const hrs = Math.floor(totalMins / 60);
  const mins = totalMins % 60;
  if (hrs > 0) return `REOPENING IN ${hrs} HR${hrs !== 1 ? 'S' : ''} ${mins} MIN${mins !== 1 ? 'S' : ''}`;
  return `REOPENING IN ${mins} MIN${mins !== 1 ? 'S' : ''}`;
}

function startMaintenanceCountdown(reopeningAt) {
  clearInterval(maintenanceCountdownInterval);
  const reopenEl = document.getElementById("maintenance-reopen");
  if (!reopenEl || !reopeningAt) return;
  const update = () => { reopenEl.textContent = maintenanceCountdownText(reopeningAt); };
  update();
  maintenanceCountdownInterval = setInterval(update, 30_000);
}

function stopMaintenanceCountdown() {
  clearInterval(maintenanceCountdownInterval);
  maintenanceCountdownInterval = null;
}

function scheduleMaintenanceGlitch() {
  maintenanceGlitchTimer = setTimeout(() => {
    const titleEl = document.querySelector('.maintenance-title');
    if (titleEl) {
      titleEl.classList.add('glitching');
      titleEl.addEventListener('animationend', () => {
        titleEl.classList.remove('glitching');
        scheduleMaintenanceGlitch();
      }, { once: true });
    }
  }, 3_000 + Math.random() * 9_000);
}

function stopMaintenanceGlitch() {
  clearTimeout(maintenanceGlitchTimer);
  maintenanceGlitchTimer = null;
  document.querySelector('.maintenance-title')?.classList.remove('glitching');
}

let maintenanceReconnectDelay = 3000;
function connectMaintenance() {
  const es = new EventSource("/pay/events");
  es.addEventListener("maintenance", e => {
    try {
      const { active, reopeningAt } = JSON.parse(e.data);
      document.getElementById("maintenance-overlay").hidden = !active;
      const reopenEl = document.getElementById("maintenance-reopen");
      if (reopenEl) reopenEl.hidden = !active || !reopeningAt;
      if (active && reopeningAt) startMaintenanceCountdown(reopeningAt);
      else stopMaintenanceCountdown();
      if (active) scheduleMaintenanceGlitch(); else stopMaintenanceGlitch();
      maintenanceReconnectDelay = 3000;
    } catch {}
  });
  es.onerror = () => {
    es.close();
    setTimeout(connectMaintenance, maintenanceReconnectDelay);
    maintenanceReconnectDelay = Math.min(maintenanceReconnectDelay * 2, 30_000);
  };
}
connectMaintenance();

// Dev helpers (mock mode only)
window.clearCollect = () => fetch('/api/dev/expire-collect', { method: 'POST' }).then(r => r.json()).then(console.log);
// scan(ref) or scan() to pick a random collect order
window.scan = async (ref) => {
  if (!ref) {
    const { orders } = await fetch('/api/orders').then(r => r.json());
    const ready = orders.filter(o => o.state === 'collect' && o.collection_point);
    if (!ready.length) { console.log('[scan] no orders in collect state'); return; }
    ref = ready[Math.floor(Math.random() * ready.length)].order_ref;
    console.log('[scan] picked', ref);
  }
  scanInput.value = `KIOSK:${ref}`;
  scanInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
};

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

function isBuzzball(description) {
  return String(description ?? "").toLowerCase().startsWith("buzzball");
}

function collectionLabel(lines) {
  const hasTube  = lines.some(l => isBuzzball(l.description));
  const hasHatch = lines.some(l => !isBuzzball(l.description));
  if (hasTube && hasHatch) return "Hatch & Tube";
  if (hasTube) return "Tube";
  return "Hatch";
}

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
      showError("Receipt not recognised");
    } else if (order.state === "unpaid") {
      showPaymentRequired(order.order_name);
    } else if (order.state !== "collect") {
      showError("Asset retrieval in progress");
    } else if (!order.collection_point) {
      showError("Collection point not assigned");
    } else {
      showResult(order.order_name, order.collection_point, collectionLabel(order.lines ?? []));
      fetch(`/api/orders/${encodeURIComponent(orderRef)}/scan`, { method: "POST" }).catch(() => {});
    }
  } catch {
    showError("Connection error");
  }

  resetTimer = setTimeout(showIdle, 12_000);
}

function showIdle() {
  screen.innerHTML = `
    <div class="idle-icon">▤</div>
    <div class="idle-prompt">Scan your receipt</div>`;
}

function showResult(orderName, collectionPoint, label) {
  screen.innerHTML = `
    <div class="result-order-label">Asset Reference</div>
    <div class="result-order">${escapeHtml(orderName)}</div>
    <div class="result-label">Collection Point</div>
    <div class="result-cp">${escapeHtml(String(collectionPoint))}</div>
    <div class="result-order-label" style="margin-top:0.6em">via ${escapeHtml(label)}</div>`;
}

function showPaymentRequired(orderName) {
  screen.innerHTML = `
    <div class="result-order-label">Asset Reference</div>
    <div class="result-order">${escapeHtml(orderName)}</div>
    <div class="payment-required">Payment Required</div>
    <div class="payment-required-sub">Please proceed to the payment terminal</div>`;
}

function showError(msg) {
  screen.innerHTML = `<div class="error-msg">${escapeHtml(msg)}</div>`;
}
