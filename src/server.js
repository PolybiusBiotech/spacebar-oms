import http from "node:http";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, validateRuntimeConfig } from "./config.js";
import { fetchOrders, markCollected, markRejected, TillwebError } from "./tillweb.js";
import { sendJson, serveStatic } from "@spacebar/shared/http-helpers.js";

const COLLECT_TIMEOUT_MS = 2 * 60 * 1000;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MAINTENANCE_FILE = process.env.OMS_MAINTENANCE_STATE
  || path.join(__dirname, "..", "maintenance.json");
const KIOSK_MAINTENANCE_FILE = process.env.OMS_KIOSK_MAINTENANCE_STATE
  || path.join(__dirname, "..", "kiosk-maintenance.json");

// In-memory order state.
// Map<order_ref, { ...tillwebFields, state: 'unpaid'|'processing'|'collect', collectAt: number|null }>
const orderState = new Map();

// Refs that have been collected — never re-enter the state machine after collect timeout.
const collectedRefs = new Set();

// Refs that were ID-rejected this session. Map<order_ref, timestamp_ms>.
const REJECTED_TTL_MS = 15 * 60 * 1000;
const rejectedCache = new Map();

// In-memory printer alerts from kiosks. Keyed by location, last alert wins.
// { [location]: { message, at } }
const printerAlerts = {};

// In-memory payment instruction screen state.
const PAY_DEFAULT = "PAY HERE";
let payMessage = PAY_DEFAULT;
let payClearTimer = null;
const payClients = new Set();
const PAY_IDLE_MS = 30_000;

// OMS-wide maintenance — affects all screens including OMS displays.
// Kiosk-only maintenance — affects kiosks/badge only; OMS displays stay live for order collection.
let maintenanceMode = false;
let maintenanceReopeningAt = "";
let kioskMaintenanceMode = false;
let kioskMaintenanceReopeningAt = "";

try {
  const saved = JSON.parse(readFileSync(MAINTENANCE_FILE, "utf8"));
  maintenanceMode = Boolean(saved.active);
  maintenanceReopeningAt = String(saved.reopeningAt ?? "");
} catch { /* no file yet */ }

try {
  const saved = JSON.parse(readFileSync(KIOSK_MAINTENANCE_FILE, "utf8"));
  kioskMaintenanceMode = Boolean(saved.active);
  kioskMaintenanceReopeningAt = String(saved.reopeningAt ?? "");
} catch { /* no file yet */ }

function saveMaintenanceState() {
  try {
    writeFileSync(MAINTENANCE_FILE, JSON.stringify({ active: maintenanceMode, reopeningAt: maintenanceReopeningAt }), "utf8");
  } catch (err) {
    console.error(`[maintenance] Failed to save state: ${err.message}`);
  }
}

function saveKioskMaintenanceState() {
  try {
    writeFileSync(KIOSK_MAINTENANCE_FILE, JSON.stringify({ active: kioskMaintenanceMode, reopeningAt: kioskMaintenanceReopeningAt }), "utf8");
  } catch (err) {
    console.error(`[kiosk-maintenance] Failed to save state: ${err.message}`);
  }
}

function logCollect(config, order) {
  if (!config.collectLog) return;
  const entry = {
    collected_at: new Date().toISOString(),
    transaction_id: order.transaction_id,
    total: order.total,
    created_at: order.created_at,
    lines: order.lines ?? []
  };
  try {
    appendFileSync(config.collectLog, JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    console.error(`[collect-log] Failed to write to ${config.collectLog}: ${err.message}`);
  }
}

function logIdCheck(config, orderRef, result) {
  const entry = { order_ref: orderRef, checked_at: new Date().toISOString(), result };
  console.log(`[id-check] ${orderRef}: ${result}`);
  if (!config.idCheckLog) return;
  try {
    appendFileSync(config.idCheckLog, JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    console.error(`[id-check-log] Failed to write to ${config.idCheckLog}: ${err.message}`);
  }
}

function broadcast(data) {
  for (const res of payClients) {
    try { res.write(data); } catch { payClients.delete(res); }
  }
}

function broadcastPayMessage() {
  broadcast(`data: ${JSON.stringify({ message: payMessage })}\n\n`);
}

function broadcastMaintenance() {
  broadcast(`event: maintenance\ndata: ${JSON.stringify({ active: maintenanceMode, reopeningAt: maintenanceReopeningAt })}\n\n`);
}

function broadcastKioskOnlyMaintenance() {
  broadcast(`event: kiosk-maintenance\ndata: ${JSON.stringify({ active: kioskMaintenanceMode, reopeningAt: kioskMaintenanceReopeningAt })}\n\n`);
}

function broadcastPrinterAlerts() {
  broadcast(`event: printer-alert\ndata: ${JSON.stringify({ alerts: printerAlerts })}\n\n`);
}

function setPayMessage(msg) {
  payMessage = msg || PAY_DEFAULT;
  clearTimeout(payClearTimer);
  payClearTimer = null;
  if (payMessage !== PAY_DEFAULT) {
    payClearTimer = setTimeout(() => {
      payMessage = PAY_DEFAULT;
      broadcastPayMessage();
    }, PAY_IDLE_MS);
  }
  broadcastPayMessage();
}

function transitionOrder(ref, incoming) {
  const existing = orderState.get(ref);

  if (collectedRefs.has(ref)) return;

  if (!existing) {
    orderState.set(ref, {
      ...incoming,
      state: incoming.paid ? "processing" : "unpaid",
      collectAt: null
    });
    return;
  }

  if (existing.state === "collect") {
    return;
  }

  if (incoming.paid && existing.state === "unpaid") {
    orderState.set(ref, { ...existing, ...incoming, state: "processing" });
    return;
  }

  orderState.set(ref, { ...existing, ...incoming });
}

function pruneOrders(liveRefs) {
  const now = Date.now();
  for (const [ref, order] of orderState) {
    if (order.state === "collect") {
      if (order.collectAt && now - order.collectAt > COLLECT_TIMEOUT_MS) {
        orderState.delete(ref);
      }
    } else if (!liveRefs.has(ref) && order.state !== "processing") {
      orderState.delete(ref);
    }
  }
}

// Lets an in-flight backoff sleep be cut short (e.g. by an /pay/order-paid
// notification) so the next poll runs immediately instead of waiting out
// the rest of the interval. No-op when no sleep is currently pending.
let wakePoll = () => {};

function pollSleep(ms) {
  return new Promise(resolve => {
    const timer = setTimeout(() => { wakePoll = () => {}; resolve(); }, ms);
    wakePoll = () => { clearTimeout(timer); wakePoll = () => {}; resolve(); };
  });
}

function triggerImmediatePoll() {
  wakePoll();
}

async function pollLoop(config) {
  const baseMs = config.pollInterval * 1000;
  const maxMs = 60_000;
  let delayMs = 0;
  let firstPoll = true;
  let paused = false;

  while (true) {
    if (maintenanceMode) {
      if (!paused) {
        console.log("[poll] Paused — full maintenance mode active.");
        paused = true;
      }
      await new Promise(r => setTimeout(r, baseMs));
      continue;
    }
    if (paused) {
      console.log("[poll] Resuming — maintenance mode cleared.");
      paused = false;
      delayMs = 0;
      firstPoll = true;
    }
    if (delayMs > 0) await pollSleep(delayMs);
    try {
      const orders = await fetchOrders(config);
      const liveRefs = new Set(orders.map(o => String(o.transaction_id)));
      for (const order of orders) transitionOrder(String(order.transaction_id), order);
      pruneOrders(liveRefs);
      if (firstPoll) {
        console.log(`[poll] Cold-start: ${orders.length} order(s) loaded from till.`);
      } else if (delayMs > baseMs) {
        console.log("[poll] Reconnected to till.");
      }
      firstPoll = false;
      delayMs = baseMs;
    } catch (error) {
      const nextDelay = delayMs === 0 ? baseMs : Math.min(delayMs * 2, maxMs);
      console.error(`[poll] ${error.message} — retrying in ${Math.round(nextDelay / 1000)}s`);
      delayMs = nextDelay;
      firstPoll = false;
    }
  }
}

const MOCK_STOCK = [
  { description: "BuzzBallz Berry Cherry Limeade",        unit_price: 6.50 },
  { description: "BuzzBallz Chilli Mango",                unit_price: 6.50 },
  { description: "BuzzBallz Choc Tease",                  unit_price: 6.50 },
  { description: "BuzzBallz Espresso Martini",            unit_price: 6.50 },
  { description: "BuzzBallz Lotta Colada",                unit_price: 6.50 },
  { description: "BuzzBallz Passionfruit Martini",        unit_price: 6.50 },
  { description: "BuzzBallz Strawberry 'Rita",            unit_price: 6.50 },
  { description: "BuzzBallz Tequila 'Rita",               unit_price: 6.50 },
  { description: "Captain Morgan Gold and Pepsi Max (250ml)", unit_price: 5.00 },
  { description: "Jack Daniels and Coca Cola (330ml)",    unit_price: 5.00 },
  { description: "Smirnoff and Cola (250ml)",             unit_price: 5.00 },
  { description: "Tanqueray and Tonic (250ml)",           unit_price: 5.00 },
  { description: "Nice Fizz 200ml",                       unit_price: 5.00 },
  { description: "Nice Pale Rosé 187ml",                  unit_price: 5.00 },
  { description: "Nice Sauvignon Blanc 187ml",            unit_price: 5.00 },
  { description: "Sea Change Sparkling 0%",               unit_price: 5.00 },
];

function randomMockLines() {
  const count = Math.floor(Math.random() * 3) + 1;
  const lines = [];
  for (let i = 0; i < count; i++) {
    const item = MOCK_STOCK[Math.floor(Math.random() * MOCK_STOCK.length)];
    const quantity = Math.random() < 0.25 ? 2 : 1;
    lines.push({ quantity, description: item.description, line_total: (item.unit_price * quantity).toFixed(2) });
  }
  return lines;
}

function mockOrders() {
  const orders = [];
  for (let i = 42; i <= 44; i++) {
    const lines = randomMockLines();
    orders.push({ transaction_id: 10000 + i, paid: false, lines, total: lines.reduce((s, l) => s + parseFloat(l.line_total), 0).toFixed(2), created_at: new Date().toISOString() });
  }
  for (let i = 45; i < 95; i++) {
    const lines = randomMockLines();
    orders.push({ transaction_id: 10000 + i, paid: true, lines, total: lines.reduce((s, l) => s + parseFloat(l.line_total), 0).toFixed(2), created_at: new Date().toISOString() });
  }
  return orders;
}

function seedMockCollect() {
  const now = Date.now();
  const seeds = [
    [10048, 1, [
      { quantity: 2, description: "Jack Daniels and Coca Cola (330ml)", line_total: "10.00" },
      { quantity: 1, description: "Nice Pale Rosé 187ml",               line_total: "5.00"  },
    ]],
    [10049, 2, [
      { quantity: 1, description: "BuzzBallz Chilli Mango",             line_total: "6.50"  },
      { quantity: 1, description: "BuzzBallz Lotta Colada",             line_total: "6.50"  },
    ]],
    [10050, 3, [
      { quantity: 1, description: "BuzzBallz Espresso Martini",         line_total: "6.50"  },
      { quantity: 1, description: "Tanqueray and Tonic (250ml)",        line_total: "5.00"  },
      { quantity: 1, description: "Nice Sauvignon Blanc 187ml",         line_total: "5.00"  },
    ]],
  ];
  for (const [transaction_id, collection_point, lines] of seeds) {
    orderState.set(String(transaction_id), {
      transaction_id, total: lines.reduce((s, l) => s + parseFloat(l.line_total), 0).toFixed(2),
      state: "collect", collectAt: now, collection_point, lines, scanned: false,
      created_at: new Date().toISOString(),
    });
  }
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch { return {}; }
}

export function createServer(config) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);

    try {
      if (url.pathname === "/healthz") {
        sendJson(res, 200, { ok: true, location: config.location, printer_alerts: printerAlerts });
        return;
      }

      if (url.pathname === "/api/printer-alert" && req.method === "POST") {
        const body = await readBody(req);
        const location = body.location || "unknown";
        printerAlerts[location] = { message: body.message || "Printer error", at: body.at || new Date().toISOString() };
        console.warn(`[printer-alert] ${location}: ${printerAlerts[location].message}`);
        broadcastPrinterAlerts();
        sendJson(res, 200, { ok: true });
        return;
      }

      if (url.pathname === "/api/printer-alert" && req.method === "DELETE") {
        const body = await readBody(req);
        if (body.location) delete printerAlerts[body.location];
        else Object.keys(printerAlerts).forEach(k => delete printerAlerts[k]);
        broadcastPrinterAlerts();
        sendJson(res, 200, { ok: true });
        return;
      }

      if (url.pathname === "/api/orders" && req.method === "GET") {
        const kioskMaint = (maintenanceMode || kioskMaintenanceMode)
          ? { active: true, reopeningAt: maintenanceMode ? maintenanceReopeningAt : kioskMaintenanceReopeningAt }
          : { active: false };
        const ref = url.searchParams.get("order");
        if (ref) {
          const o = orderState.get(ref);
          if (!o) {
            sendJson(res, 404, { error: "not-found", kiosk_maintenance: kioskMaint });
          } else {
            sendJson(res, 200, { order: { order_ref: String(o.transaction_id), state: o.state }, kiosk_maintenance: kioskMaint });
          }
          return;
        }
        const orders = [...orderState.values()].map(o => ({
          order_ref: String(o.transaction_id),
          order_name: String(o.transaction_id),
          total: o.total,
          lines: o.lines,
          created_at: o.created_at,
          state: o.state,
          collection_point: o.collection_point ?? null,
          scanned: o.scanned ?? false
        }));
        sendJson(res, 200, { orders, printer_alerts: printerAlerts, kiosk_maintenance: kioskMaint });
        return;
      }

      // Operator marks an order as ready for collection, assigning a collection point (1-3).
      const collectMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/collect$/);
      if (collectMatch && req.method === "POST") {
        const ref = collectMatch[1];
        const order = orderState.get(ref);
        if (!order) {
          sendJson(res, 404, { error: "not-found", message: "Order not found." });
          return;
        }
        if (order.state !== "processing") {
          sendJson(res, 409, { error: "wrong-state", message: `Order is ${order.state}, not processing.` });
          return;
        }
        const body = await readBody(req);
        const collection_point = Number(body.collection_point);
        if (!Number.isInteger(collection_point) || collection_point < 1 || collection_point > 3) {
          sendJson(res, 400, { error: "bad-collection-point", message: "collection_point must be an integer 1–3." });
          return;
        }
        // Displace any existing order at this collection point.
        // If already scanned, complete it; if still waiting, move back to processing.
        for (const [existingRef, existingOrder] of orderState) {
          if (existingOrder.state === "collect" && existingOrder.collection_point === collection_point) {
            if (existingOrder.scanned) {
              orderState.delete(existingRef);
              collectedRefs.add(existingRef);
            } else {
              orderState.set(existingRef, { ...existingOrder, state: "processing", collectAt: null, collection_point: null });
            }
          }
        }
        const collected = { ...order, state: "collect", collectAt: Date.now(), collection_point };
        orderState.set(ref, collected);
        collectedRefs.add(ref);
        logCollect(config, collected);
        markCollected(config, ref).catch(err =>
          console.error(`[collect] Failed to mark ${ref} collected in tillweb: ${err.message}`)
        );
        sendJson(res, 200, { order_ref: ref, state: "collect", collection_point });
        return;
      }

      // Collection point screen clears order — customer has picked up.
      const collectedMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/collected$/);
      if (collectedMatch && req.method === "POST") {
        const ref = collectedMatch[1];
        const order = orderState.get(ref);
        if (!order || order.state !== "collect") {
          sendJson(res, 404, { error: "not-found", message: "Order not found at a collection point." });
          return;
        }
        orderState.delete(ref);
        collectedRefs.add(ref);
        sendJson(res, 200, { order_ref: ref, state: "collected" });
        return;
      }

      if (url.pathname === "/pay/events" && req.method === "GET") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no"
        });
        res.write(`data: ${JSON.stringify({ message: payMessage })}\n\n`);
        if (Object.keys(printerAlerts).length > 0) {
          res.write(`event: printer-alert\ndata: ${JSON.stringify({ alerts: printerAlerts })}\n\n`);
        }
        if (maintenanceMode) {
          res.write(`event: maintenance\ndata: ${JSON.stringify({ active: true, reopeningAt: maintenanceReopeningAt })}\n\n`);
        }
        if (kioskMaintenanceMode) {
          res.write(`event: kiosk-maintenance\ndata: ${JSON.stringify({ active: true, reopeningAt: kioskMaintenanceReopeningAt })}\n\n`);
        }
        payClients.add(res);
        req.on("close", () => payClients.delete(res));
        return;
      }

      if (url.pathname === "/pay/order-loaded" && req.method === "POST") {
        const body = await readBody(req);
        const orderRef = String(body.order_ref ?? "").slice(0, 40);
        const softOnly = Boolean(body.soft_only);
        if (orderRef) {
          const rejectedAt = rejectedCache.get(orderRef);
          const previouslyRejected = rejectedAt != null && (Date.now() - rejectedAt) < REJECTED_TTL_MS;
          if (!previouslyRejected) rejectedCache.delete(orderRef);
          if (previouslyRejected) setPayMessage("REFUSED");
          const payload = `event: order-loaded\ndata: ${JSON.stringify({ order_ref: orderRef, soft_only: softOnly, previously_rejected: previouslyRejected })}\n\n`;
          for (const client of payClients) client.write(payload);
          console.log(`[pay] order loaded: ${orderRef}${softOnly ? " (soft-only)" : ""}`);
          if (softOnly) logIdCheck(config, orderRef, "soft_only_no_check");
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      // Till notifies us the moment a kiosk transaction is paid — we don't
      // trust this as proof of payment, we just use it to shortcut the next
      // poll. `paid` still comes solely from the authenticated tillweb poll.
      if (url.pathname === "/pay/order-paid" && req.method === "POST") {
        const body = await readBody(req);
        const orderRef = String(body.order_ref ?? "").slice(0, 40);
        if (orderRef) {
          console.log(`[pay] order paid (till notify): ${orderRef} — triggering immediate poll`);
          triggerImmediatePoll();
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      const idCheckMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/id-check$/);
      if (idCheckMatch && req.method === "POST") {
        const ref = decodeURIComponent(idCheckMatch[1]);
        const body = await readBody(req);
        const result = ["approved", "rejected", "id_requested"].includes(body.result)
          ? body.result : "rejected";
        if (result !== "id_requested") logIdCheck(config, ref, result);
        if (result === "rejected") {
          setPayMessage("REFUSED");
          rejectedCache.set(ref, Date.now());
          markRejected(config, ref).catch(err =>
            console.error(`[id-check] Failed to mark ${ref} rejected in tillweb: ${err.message}`)
          );
        }
        sendJson(res, 200, { ok: true, order_ref: ref, result });
        return;
      }

      if (url.pathname === "/pay/message" && req.method === "POST") {
        const body = await readBody(req);
        setPayMessage(String(body.message ?? "").slice(0, 200));
        sendJson(res, 200, { ok: true, message: payMessage });
        return;
      }

      if (url.pathname === "/pay/clear" && req.method === "POST") {
        setPayMessage("");
        sendJson(res, 200, { ok: true });
        return;
      }

      if (url.pathname === "/maintenance" && req.method === "POST") {
        const body = await readBody(req);
        maintenanceMode = Boolean(body.active);
        if (body.reopeningAt !== undefined) maintenanceReopeningAt = String(body.reopeningAt ?? "");
        saveMaintenanceState();
        broadcastMaintenance();
        console.log(`[maintenance] mode ${maintenanceMode ? "ON" : "OFF"}${maintenanceReopeningAt ? ` reopening ${maintenanceReopeningAt}` : ""}`);
        sendJson(res, 200, { ok: true, active: maintenanceMode, reopeningAt: maintenanceReopeningAt });
        return;
      }

      if (url.pathname === "/kiosk-maintenance" && req.method === "POST") {
        const body = await readBody(req);
        kioskMaintenanceMode = Boolean(body.active);
        if (body.reopeningAt !== undefined) kioskMaintenanceReopeningAt = String(body.reopeningAt ?? "");
        saveKioskMaintenanceState();
        broadcastKioskOnlyMaintenance();
        console.log(`[kiosk-maintenance] mode ${kioskMaintenanceMode ? "ON" : "OFF"}${kioskMaintenanceReopeningAt ? ` reopening ${kioskMaintenanceReopeningAt}` : ""}`);
        sendJson(res, 200, { ok: true, active: kioskMaintenanceMode, reopeningAt: kioskMaintenanceReopeningAt });
        return;
      }

      // Customer scanned their receipt at the collection scanner.
      const scanMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/scan$/);
      if (scanMatch && req.method === "POST") {
        const ref = decodeURIComponent(scanMatch[1]);
        const order = orderState.get(ref);
        if (!order || order.state !== "collect") {
          sendJson(res, 404, { error: "not-found" });
          return;
        }
        orderState.set(ref, { ...order, scanned: true });
        sendJson(res, 200, { ok: true });
        return;
      }

      // Dev-only: expire all collect orders (mock mode)
      if (url.pathname === "/api/dev/expire-collect" && req.method === "POST") {
        if (!config.mockMode) { sendJson(res, 403, { error: "not-mock-mode" }); return; }
        let count = 0;
        for (const [ref, order] of orderState) {
          if (order.state === "collect") { orderState.delete(ref); collectedRefs.add(ref); count++; }
        }
        sendJson(res, 200, { ok: true, expired: count });
        return;
      }

      // Clean URLs for the OMS screens
      const collectionRouteMatch = url.pathname.match(/^\/collection\/([1-3])$/);
      if (collectionRouteMatch) { req.url = "/collection.html"; await serveStatic(config.publicDir, req, res); return; }

      const rewrites = { "/status": "/status.html", "/customer": "/status.html", "/staff": "/staff.html", "/pay": "/pay.html", "/control": "/control.html", "/pay/control": "/control.html", "/scan": "/scan.html" };
      if (rewrites[url.pathname]) req.url = rewrites[url.pathname];

      if (req.method === "GET" || req.method === "HEAD") {
        await serveStatic(config.publicDir, req, res);
        return;
      }

      sendJson(res, 405, { error: "method-not-allowed", message: "Method not allowed." });
    } catch (error) {
      sendJson(res, 500, { error: "server-error", message: error.message });
    }
  });
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const config = loadConfig();

  if (config.mockMode) {
    for (const order of mockOrders()) {
      transitionOrder(String(order.transaction_id), order);
    }
    seedMockCollect();
    console.log("Mock mode: pre-loaded sample orders.");
  } else {
    const missing = validateRuntimeConfig(config);
    if (missing.length) {
      console.warn(`Missing configuration: ${missing.join(", ")}`);
    }
  }

  const server = createServer(config);

  server.on("error", error => {
    console.error(`Could not start OMS: ${error.message}`);
    process.exitCode = 1;
  });

  server.listen(config.port, config.listenHost, () => {
    console.log(`Spacebar OMS listening on http://${config.listenHost}:${config.port}`);
    if (!config.mockMode) {
      pollLoop(config);
    }
  });

  setInterval(() => {
    for (const client of payClients) {
      try { client.write(": ping\n\n"); } catch { payClients.delete(client); }
    }
  }, 25_000);
}
