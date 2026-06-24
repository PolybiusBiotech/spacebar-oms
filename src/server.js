import fs from "node:fs/promises";
import http from "node:http";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, validateRuntimeConfig } from "./config.js";
import { fetchOrders, markCollected, markRejected, TillwebError } from "./tillweb.js";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8"
};

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
    order_ref: order.order_ref,
    order_name: order.order_name,
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

function broadcastPayMessage() {
  const data = `data: ${JSON.stringify({ message: payMessage })}\n\n`;
  for (const res of payClients) {
    try { res.write(data); } catch { payClients.delete(res); }
  }
}

function broadcastMaintenance() {
  const data = `event: maintenance\ndata: ${JSON.stringify({ active: maintenanceMode, reopeningAt: maintenanceReopeningAt })}\n\n`;
  for (const res of payClients) {
    try { res.write(data); } catch { payClients.delete(res); }
  }
}

function broadcastKioskOnlyMaintenance() {
  const data = `event: kiosk-maintenance\ndata: ${JSON.stringify({ active: kioskMaintenanceMode, reopeningAt: kioskMaintenanceReopeningAt })}\n\n`;
  for (const res of payClients) {
    try { res.write(data); } catch { payClients.delete(res); }
  }
}

function broadcastPrinterAlerts() {
  const data = `event: printer-alert\ndata: ${JSON.stringify({ alerts: printerAlerts })}\n\n`;
  for (const res of payClients) {
    try { res.write(data); } catch { payClients.delete(res); }
  }
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

async function pollLoop(config) {
  const baseMs = config.pollInterval * 1000;
  const maxMs = 60_000;
  let delayMs = 0;
  let firstPoll = true;

  while (true) {
    if (delayMs > 0) await new Promise(r => setTimeout(r, delayMs));
    try {
      const orders = await fetchOrders(config);
      const liveRefs = new Set(orders.map(o => o.order_ref));
      for (const order of orders) transitionOrder(order.order_ref, order);
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

function mockOrders() {
  const orders = [
    { order_ref: "10042", order_name: "10042", total: "3.50",  paid: false, lines: [], created_at: new Date().toISOString() },
    { order_ref: "10043", order_name: "10043", total: "7.20",  paid: false, lines: [], created_at: new Date().toISOString() },
    { order_ref: "10044", order_name: "10044", total: "12.00", paid: false, lines: [], created_at: new Date().toISOString() },
  ];
  for (let i = 45; i < 95; i++) {
    const ref = String(10000 + i);
    orders.push({ order_ref: ref, order_name: ref, total: "5.00", paid: true, lines: [], created_at: new Date().toISOString() });
  }
  return orders;
}

function seedMockCollect() {
  const now = Date.now();
  const seeds = [
    // hatch only
    ["10048", 2, [{ quantity: 1, description: "Pint of Lager", line_total: "5.50" }, { quantity: 1, description: "Glass of Wine", line_total: "6.00" }]],
    // tube only
    ["10049", 5, [{ quantity: 2, description: "Buzzball Watermelon", line_total: "6.00" }, { quantity: 1, description: "Buzzball Strawberry Daiquiri", line_total: "3.00" }]],
    // hatch & tube
    ["10050", 3, [{ quantity: 1, description: "Buzzball Strawberry", line_total: "3.00" }, { quantity: 1, description: "Pint of Cider", line_total: "5.50" }]],
  ];
  for (const [ref, collection_point, lines] of seeds) {
    orderState.set(ref, {
      order_ref: ref, order_name: ref, total: lines.reduce((s, l) => s + parseFloat(l.line_total), 0).toFixed(2),
      state: "collect", collectAt: now, collection_point, lines, scanned: true,
      created_at: new Date().toISOString(),
    });
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Content-Length": Buffer.byteLength(body)
  });
  res.end(body);
}

async function serveStatic(config, req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const safePath = path
    .normalize(decodeURIComponent(requestUrl.pathname))
    .replace(/^(\.\.[/\\])+/, "");
  const relativePath = safePath === "/" ? "index.html" : safePath.replace(/^[/\\]/, "");
  const filePath = path.join(config.publicDir, relativePath);

  if (!filePath.startsWith(config.publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const body = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "Content-Type": MIME_TYPES[ext] ?? "application/octet-stream",
      "Cache-Control": "no-store"
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
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
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
        const location = body.location || "unknown";
        printerAlerts[location] = { message: body.message || "Printer error", at: body.at || new Date().toISOString() };
        console.warn(`[printer-alert] ${location}: ${printerAlerts[location].message}`);
        broadcastPrinterAlerts();
        sendJson(res, 200, { ok: true });
        return;
      }

      if (url.pathname === "/api/printer-alert" && req.method === "DELETE") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
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
            sendJson(res, 200, { order: { order_ref: o.order_ref, state: o.state }, kiosk_maintenance: kioskMaint });
          }
          return;
        }
        const orders = [...orderState.values()].map(o => ({
          order_ref: o.order_ref,
          order_name: o.order_name,
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

      // Operator marks an order as ready for collection, assigning a collection point (1-6).
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
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
        const collection_point = Number(body.collection_point);
        if (!Number.isInteger(collection_point) || collection_point < 1 || collection_point > 6) {
          sendJson(res, 400, { error: "bad-collection-point", message: "collection_point must be an integer 1–6." });
          return;
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
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
        const orderRef = String(body.order_ref ?? "").slice(0, 40);
        const softOnly = Boolean(body.soft_only);
        if (orderRef) {
          const payload = `event: order-loaded\ndata: ${JSON.stringify({ order_ref: orderRef, soft_only: softOnly })}\n\n`;
          for (const client of payClients) client.write(payload);
          console.log(`[pay] order loaded: ${orderRef}${softOnly ? " (soft-only)" : ""}`);
          if (softOnly) logIdCheck(config, orderRef, "soft_only_no_check");
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      const idCheckMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/id-check$/);
      if (idCheckMatch && req.method === "POST") {
        const ref = decodeURIComponent(idCheckMatch[1]);
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
        const result = ["approved", "rejected", "id_requested"].includes(body.result)
          ? body.result : "rejected";
        if (result !== "id_requested") logIdCheck(config, ref, result);
        if (result === "rejected") {
          setPayMessage("REJECTED");
          markRejected(config, ref).catch(err =>
            console.error(`[id-check] Failed to mark ${ref} rejected in tillweb: ${err.message}`)
          );
        }
        sendJson(res, 200, { ok: true, order_ref: ref, result });
        return;
      }

      if (url.pathname === "/pay/message" && req.method === "POST") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
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
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
        maintenanceMode = Boolean(body.active);
        if (body.reopeningAt !== undefined) maintenanceReopeningAt = String(body.reopeningAt ?? "");
        saveMaintenanceState();
        broadcastMaintenance();
        console.log(`[maintenance] mode ${maintenanceMode ? "ON" : "OFF"}${maintenanceReopeningAt ? ` reopening ${maintenanceReopeningAt}` : ""}`);
        sendJson(res, 200, { ok: true, active: maintenanceMode, reopeningAt: maintenanceReopeningAt });
        return;
      }

      if (url.pathname === "/kiosk-maintenance" && req.method === "POST") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
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

      // Clean URLs for the OMS screens
      const collectionRouteMatch = url.pathname.match(/^\/collection\/([1-6])$/);
      if (collectionRouteMatch) { req.url = "/collection.html"; await serveStatic(config, req, res); return; }

      const rewrites = { "/status": "/status.html", "/customer": "/status.html", "/staff": "/staff.html", "/pay": "/pay.html", "/control": "/control.html", "/pay/control": "/control.html", "/scan": "/scan.html" };
      if (rewrites[url.pathname]) req.url = rewrites[url.pathname];

      if (req.method === "GET" || req.method === "HEAD") {
        await serveStatic(config, req, res);
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
      transitionOrder(order.order_ref, order);
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
