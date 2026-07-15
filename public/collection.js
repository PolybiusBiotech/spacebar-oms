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
