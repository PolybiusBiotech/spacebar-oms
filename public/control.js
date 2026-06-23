const currentEl = document.getElementById("current-message");
const btnMaintenance = document.getElementById("btn-maintenance");
const btnKioskMaintenance = document.getElementById("btn-kiosk-maintenance");
const reopenTimeInput = document.getElementById("reopen-time");
let maintenanceActive = false;
let kioskMaintenanceActive = false;

btnMaintenance.addEventListener("click", () => {
  const enabling = !maintenanceActive;
  const t = reopenTimeInput.value || "";
  fetch("/maintenance", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ active: enabling, reopeningAt: t })
  }).catch(err => console.error("maintenance toggle failed:", err));
  // Full maintenance locks kiosk maintenance in sync
  fetch("/kiosk-maintenance", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ active: enabling, reopeningAt: enabling ? t : "" })
  }).catch(() => {});
});

btnKioskMaintenance.addEventListener("click", () => {
  const enabling = !kioskMaintenanceActive;
  fetch("/kiosk-maintenance", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ active: enabling, reopeningAt: reopenTimeInput.value || "" })
  }).catch(err => console.error("kiosk maintenance toggle failed:", err));
});

// Live-update reopening time in whichever mode(s) are currently active
reopenTimeInput.addEventListener("input", () => {
  const t = reopenTimeInput.value;
  if (maintenanceActive) {
    fetch("/maintenance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: true, reopeningAt: t })
    }).catch(() => {});
  }
  if (kioskMaintenanceActive) {
    fetch("/kiosk-maintenance", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ active: true, reopeningAt: t })
    }).catch(() => {});
  }
});

function setMaintenanceUI(active) {
  maintenanceActive = active;
  btnMaintenance.textContent = active ? "Disable full maintenance" : "Enable full maintenance";
  btnMaintenance.classList.toggle("btn-maintenance--active", active);
  // Full maintenance locks kiosk maintenance on — disable the button while locked
  if (active) {
    btnKioskMaintenance.classList.add("btn-kiosk-maintenance--active");
    btnKioskMaintenance.textContent = "Disable kiosk maintenance";
    btnKioskMaintenance.disabled = true;
  } else {
    btnKioskMaintenance.disabled = false;
    setKioskMaintenanceUI(kioskMaintenanceActive);
  }
}

function setKioskMaintenanceUI(active) {
  kioskMaintenanceActive = active;
  if (maintenanceActive) return; // locked — don't update visuals
  btnKioskMaintenance.textContent = active ? "Disable kiosk maintenance" : "Enable kiosk maintenance";
  btnKioskMaintenance.classList.toggle("btn-kiosk-maintenance--active", active);
}

const printerAlertsEl = document.getElementById("printer-alerts");

function renderPrinterAlerts(alerts) {
  printerAlertsEl.innerHTML = "";
  for (const [location, info] of Object.entries(alerts || {})) {
    const banner = document.createElement("div");
    banner.className = "printer-alert-banner";

    const label = document.createElement("span");
    label.className = "printer-alert-label";
    label.textContent = "⚠ Printer";

    const msg = document.createElement("span");
    msg.className = "printer-alert-msg";
    msg.textContent = `${location}: ${info.message}`;

    const btn = document.createElement("button");
    btn.className = "btn-clear-alert";
    btn.textContent = "Clear";
    btn.addEventListener("click", () => {
      fetch("/api/printer-alert", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ location })
      }).catch(err => console.error("clear alert failed:", err));
    });

    banner.appendChild(label);
    banner.appendChild(msg);
    banner.appendChild(btn);
    printerAlertsEl.appendChild(banner);
  }
}

const customInput = document.getElementById("custom-input");
const btnSend = document.getElementById("btn-send");
const btnClear = document.getElementById("btn-clear");

let orderAlertTimer = null;
let audioCtx = null;
let masterGain = null;

const orderAlertEl = document.getElementById("order-alert");
const orderAlertRefEl = document.getElementById("order-alert-ref");
const btnIdReject = document.getElementById("btn-id-reject");

let currentOrderRef = null;

function getAudio() {
  if (!audioCtx || audioCtx.state === "closed") {
    audioCtx = new AudioContext();
    masterGain = audioCtx.createGain();
    masterGain.connect(audioCtx.destination);
  }
  return { ctx: audioCtx, master: masterGain };
}

function playOrderBeep() {
  try {
    const { ctx, master } = getAudio();
    master.gain.setValueAtTime(1, ctx.currentTime);
    [[440, 0], [660, 0.14], [440, 0.4], [660, 0.54], [440, 0.8], [660, 0.94]].forEach(([freq, offset]) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(master);
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.45, ctx.currentTime + offset);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + offset + 0.12);
      osc.start(ctx.currentTime + offset);
      osc.stop(ctx.currentTime + offset + 0.12);
    });
  } catch {}
}

function showOrderAlert(orderRef, softOnly = false) {
  clearTimeout(orderAlertTimer);
  currentOrderRef = orderRef;
  orderAlertRefEl.textContent = orderRef;
  orderAlertEl.hidden = false;
  orderAlertEl.classList.toggle("order-alert--soft-only", softOnly);
  const labelEl = orderAlertEl.querySelector(".order-alert-label");
  if (labelEl) labelEl.textContent = softOnly ? "Soft-only — auto pay" : "Order loaded";
  if (!softOnly) playOrderBeep();
  document.body.classList.remove("order-flash");
  void document.body.offsetWidth;
  document.body.classList.add("order-flash");
  document.body.addEventListener("animationend", () => document.body.classList.remove("order-flash"), { once: true });
  orderAlertTimer = setTimeout(() => { orderAlertEl.hidden = true; currentOrderRef = null; }, 5000);
}

btnIdReject.addEventListener("click", async () => {
  const ref = currentOrderRef;
  if (!ref) return;
  orderAlertEl.hidden = true;
  currentOrderRef = null;
  clearTimeout(orderAlertTimer);
  await fetch(`/api/orders/${encodeURIComponent(ref)}/id-check`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ result: "rejected" })
  });
});

let currentDisplayMessage = "";
let reconnectDelay = 3000;
const RECONNECT_BASE = 3000;
const RECONNECT_MAX  = 30_000;

function connect() {
  const es = new EventSource("/pay/events");
  es.onmessage = e => {
    try {
      const { message } = JSON.parse(e.data);
      reconnectDelay = RECONNECT_BASE;
      currentDisplayMessage = message || "";
      currentEl.textContent = message || "—";
      document.querySelectorAll(".preset[data-lore-msg]").forEach(b => {
        const lore  = b.dataset.loreMsg.replace(/\|/g, "\n");
        const plain = b.dataset.plainMsg.replace(/\|/g, "\n");
        const lorActive  = lore  === message;
        const plainActive = plain === message && lore !== message;
        b.classList.toggle("preset--active-lore",  lorActive);
        b.classList.toggle("preset--active-plain", plainActive);
      });
    } catch {}
  };
  es.addEventListener("order-loaded", e => {
    try {
      const { order_ref, soft_only } = JSON.parse(e.data);
      showOrderAlert(order_ref, soft_only);
    } catch {}
  });
  es.addEventListener("maintenance", e => {
    try {
      const { active } = JSON.parse(e.data);
      setMaintenanceUI(active);
    } catch {}
  });
  es.addEventListener("kiosk-maintenance", e => {
    try {
      const { active } = JSON.parse(e.data);
      setKioskMaintenanceUI(active);
    } catch {}
  });
  es.addEventListener("printer-alert", e => {
    try {
      const { alerts } = JSON.parse(e.data);
      renderPrinterAlerts(alerts);
    } catch {}
  });
  es.onerror = () => {
    es.close();
    setTimeout(connect, reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX);
  };
}

connect();

async function sendMessage(msg) {
  await fetch("/pay/message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: msg.replace(/\|/g, "\n") })
  });
}

document.querySelectorAll(".preset[data-lore-msg]").forEach(btn => {
  btn.addEventListener("click", () => {
    const loreMsg  = btn.dataset.loreMsg.replace(/\|/g, "\n");
    const plainMsg = btn.dataset.plainMsg.replace(/\|/g, "\n");

    const msg = (currentDisplayMessage === loreMsg && plainMsg !== loreMsg)
      ? plainMsg
      : loreMsg;

    sendMessage(msg);

    if (loreMsg === "PRESENT 'EMPLOYEE' ID" && currentOrderRef) {
      fetch(`/api/orders/${encodeURIComponent(currentOrderRef)}/id-check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ result: "id_requested" })
      });
    }
  });
});

btnSend.addEventListener("click", () => {
  const msg = customInput.value.trim();
  if (msg) { sendMessage(msg); customInput.value = ""; }
});

customInput.addEventListener("keydown", e => {
  if (e.key === "Enter") btnSend.click();
});

btnClear.addEventListener("click", () => {
  sendMessage("PAY HERE");
});
