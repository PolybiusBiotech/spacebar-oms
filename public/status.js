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

function escapeHtml(v) {
  return String(v ?? "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

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
    collect.innerHTML = byState.collect.map(o => {
      if (o.scanned && o.collection_point) {
        return `<div class="order-entry order-entry--scanned">
          <div class="order-name">${escapeHtml(o.order_name)}</div>
          <span class="order-collect-label">${escapeHtml(collectionLabel(o.lines ?? []))}</span>
          <span class="order-collect-point">${escapeHtml(String(o.collection_point))}</span>
        </div>`;
      }
      return `<div class="order-entry"><div class="order-name">${escapeHtml(o.order_name)}</div></div>`;
    }).join("") || "";
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
