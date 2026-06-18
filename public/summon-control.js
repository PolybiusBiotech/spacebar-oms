const currentEl = document.getElementById("current-message");
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

// --- SSE: keep current message in sync ---

let helpAlertTimer = null;
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

function playHelpBeep() {
  try {
    const { ctx, master } = getAudio();
    master.gain.setValueAtTime(1, ctx.currentTime);
    [0, 0.18, 0.36].forEach(offset => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(master);
      osc.frequency.value = 880;
      gain.gain.setValueAtTime(0.6, ctx.currentTime + offset);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + offset + 0.15);
      osc.start(ctx.currentTime + offset);
      osc.stop(ctx.currentTime + offset + 0.15);
    });
  } catch {}
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

function triggerFlash() {
  document.body.classList.remove("help-alert");
  void document.body.offsetWidth;
  document.body.classList.add("help-alert");
  document.body.addEventListener("animationend", () => {
    document.body.classList.remove("help-alert");
  }, { once: true });
}

function startHelpAlert() {
  stopHelpAlert();
  playHelpBeep();
  triggerFlash();
  helpAlertTimer = setInterval(() => {
    playHelpBeep();
    triggerFlash();
  }, 2500);
}

function stopHelpAlert() {
  clearInterval(helpAlertTimer);
  helpAlertTimer = null;
  document.body.classList.remove("help-alert");
  if (masterGain) {
    masterGain.gain.cancelScheduledValues(audioCtx.currentTime);
    masterGain.gain.value = 0;
  }
}

// Any staff action acknowledges the alert
document.addEventListener("click", e => {
  if (helpAlertTimer && e.target.closest("button, input")) stopHelpAlert();
}, { capture: true });

let currentDisplayMessage = "";

function connect() {
  stopHelpAlert();
  const es = new EventSource("/summon/events");
  es.onmessage = e => {
    try {
      const { message } = JSON.parse(e.data);
      currentDisplayMessage = message || "";
      currentEl.textContent = message || "—";
      document.querySelectorAll(".preset[data-lore-msg]").forEach(b => {
        const lorActive  = b.dataset.loreMsg  === message;
        const plainActive = b.dataset.plainMsg === message && b.dataset.loreMsg !== message;
        b.classList.toggle("preset--active-lore",  lorActive);
        b.classList.toggle("preset--active-plain", plainActive);
      });
    } catch {}
  };
  es.addEventListener("help", startHelpAlert);
  es.addEventListener("order-loaded", e => {
    try {
      const { order_ref, soft_only } = JSON.parse(e.data);
      showOrderAlert(order_ref, soft_only);
    } catch {}
  });
  es.addEventListener("printer-alert", e => {
    try {
      const { alerts } = JSON.parse(e.data);
      renderPrinterAlerts(alerts);
    } catch {}
  });
  es.onerror = () => { es.close(); setTimeout(connect, 3000); };
}

connect();

// --- Send message ---

async function sendMessage(msg) {
  await fetch("/summon/message", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ message: msg })
  });
}

document.querySelectorAll(".preset[data-lore-msg]").forEach(btn => {
  btn.addEventListener("click", () => {
    const loreMsg  = btn.dataset.loreMsg;
    const plainMsg = btn.dataset.plainMsg;

    // Second tap on an active lore preset → send the plain/serious version
    const msg = (currentDisplayMessage === loreMsg && plainMsg !== loreMsg)
      ? plainMsg
      : loreMsg;

    sendMessage(msg);

    // Either ID preset triggers the id_requested audit event
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
