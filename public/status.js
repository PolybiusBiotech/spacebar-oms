let maintenanceGlitchTimer = null;

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

function escapeHtml(v) {
  return String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const pending = document.getElementById("pending");
const paying  = document.getElementById("paying");
const collect = document.getElementById("collect");

let refreshDelay = 3000;
const REFRESH_BASE = 3000;
const REFRESH_MAX  = 30_000;

async function refresh() {
  try {
    const res  = await fetch("/api/orders");
    const data = await res.json();
    const orders = data.orders ?? [];

    refreshDelay = REFRESH_BASE;

    const byState = { unpaid: [], processing: [], collect: [] };
    for (const o of orders) {
      if (byState[o.state]) byState[o.state].push(o);
    }

    pending.innerHTML = byState.unpaid.map(o =>
      `<div class="order-name">${escapeHtml(o.order_name)}</div>`).join("") || "";
    paying.innerHTML  = byState.processing.map(o =>
      `<div class="order-name">${escapeHtml(o.order_name)}</div>`).join("") || "";
    collect.innerHTML = byState.collect.map(o =>
      `<div class="order-name">${escapeHtml(o.order_name)}</div>`).join("") || "";
  } catch {
    refreshDelay = Math.min(refreshDelay * 2, REFRESH_MAX);
    // silent — screen keeps showing last good state
  }
}

async function refreshLoop() {
  await refresh();
  setTimeout(refreshLoop, refreshDelay);
}

refreshLoop();

let maintenanceReconnectDelay = 3000;
function connectMaintenance() {
  const es = new EventSource("/pay/events");
  es.addEventListener("maintenance", e => {
    try {
      const { active, reopeningAt } = JSON.parse(e.data);
      document.getElementById("maintenance-overlay").hidden = !active;
      const reopenEl = document.getElementById("maintenance-reopen");
      if (reopenEl) {
        reopenEl.hidden = !active || !reopeningAt;
        reopenEl.textContent = reopeningAt ? `REOPENING ${reopeningAt}` : "";
      }
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
