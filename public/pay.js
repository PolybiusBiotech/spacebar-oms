let maintenanceGlitchTimer = null;
let maintenanceCountdownInterval = null;

// Ported from status.js — this was missing here entirely, so /pay showed
// the raw reopening time as static text instead of a live countdown.
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

const messageEl = document.getElementById("message");
const subtitleEl = document.getElementById("subtitle");
const ghostEl    = document.getElementById("ghost-layer");

let currentMessage = "PAY HERE";
let orderLoadedTimer = null;
let reconnectDelay = 3000;
const RECONNECT_BASE = 3000;
const RECONNECT_MAX  = 30_000;

// Messages sent from the control page plain/serious mode — no ghost layer
const PLAIN_MESSAGES = new Set([
  "PRESENT ID",
  "REFUSED",
  "PLEASE WAIT",
  "NEXT CUSTOMER",
  "SCAN AGAIN",
  "SCAN FURTHER AWAY",
  "LOOK AT CAMERA",
]);

function escapeHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

// Render message as HTML — maps PAY HERE to lore text, wraps quoted words so
// the content stays corporate but the quote marks look spray-painted on.
function renderMessageHtml(msg) {
  if (!msg || msg === "PAY HERE") return "SCAN HERE";
  const safe = escapeHtml(msg);
  return safe
    .replace(/\n/g, '<br>')
    .replace(/'([^']+)'/g,
      `<span class="spray-quoted"><span class="graffiti-quote">&#x201C;</span>$1<span class="graffiti-quote">&#x201D;</span></span>`);
}

function applyMessage(msg) {
  const isDefault = !msg || msg === "PAY HERE";
  const isPlain   = PLAIN_MESSAGES.has(msg);

  messageEl.innerHTML = renderMessageHtml(msg);
  messageEl.className = isDefault ? "pay-here" : "";

  subtitleEl.innerHTML = isDefault
    ? 'Present Asset Retrieval Slip<br><span class="subtitle-hint">(163+ mm away works best)</span>'
    : "";
  subtitleEl.classList.remove("soft-only");
  subtitleEl.classList.toggle("visible", isDefault);

  ghostEl.classList.toggle("visible", !isPlain);
}

function showOrderLoaded(orderRef, softOnly = false) {
  clearTimeout(orderLoadedTimer);
  messageEl.textContent = orderRef;
  messageEl.className = softOnly ? "order-loaded soft-only" : "order-loaded";
  subtitleEl.textContent = softOnly ? "PAY BELOW" : "PLEASE WAIT";
  subtitleEl.classList.add("visible");
  subtitleEl.classList.toggle("soft-only", softOnly);
  const flashClass = softOnly ? "order-flash-soft" : "order-flash";
  document.body.classList.remove("order-flash", "order-flash-soft");
  void document.body.offsetWidth;
  document.body.classList.add(flashClass);
  document.body.addEventListener("animationend", () => document.body.classList.remove(flashClass), { once: true });
  orderLoadedTimer = setTimeout(() => {
    orderLoadedTimer = null;
    applyMessage(currentMessage);
  }, 30000);
}

function connect() {
  const es = new EventSource("/pay/events");

  es.onmessage = e => {
    try {
      const { message } = JSON.parse(e.data);
      reconnectDelay = RECONNECT_BASE;
      currentMessage = message || "PAY HERE";
      if (currentMessage !== "PAY HERE" || !orderLoadedTimer) {
        clearTimeout(orderLoadedTimer);
        orderLoadedTimer = null;
        applyMessage(currentMessage);
      }
    } catch {}
  };

  es.addEventListener("maintenance", e => {
    try {
      const { active, reopeningAt } = JSON.parse(e.data);
      document.getElementById("maintenance-overlay").hidden = !active;
      const reopenEl = document.getElementById("maintenance-reopen");
      if (reopenEl) reopenEl.hidden = !active || !reopeningAt;
      if (active && reopeningAt) startMaintenanceCountdown(reopeningAt);
      else stopMaintenanceCountdown();
      if (active) scheduleMaintenanceGlitch(); else stopMaintenanceGlitch();
    } catch {}
  });

  es.addEventListener("order-loaded", e => {
    try {
      const { order_ref, soft_only, previously_rejected } = JSON.parse(e.data);
      if (!previously_rejected) showOrderLoaded(order_ref, soft_only);
    } catch {}
  });

  es.onerror = () => {
    es.close();
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX);
  };
}

connect();

// Dev only: ?ol=42 triggers order-loaded state for screenshotting
const _devOl = new URLSearchParams(location.search).get('ol');
if (_devOl) showOrderLoaded(_devOl, new URLSearchParams(location.search).get('soft') === '1');
