import fs from "node:fs/promises";
import http from "node:http";
import { appendFileSync } from "node:fs";
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

// In-memory order state.
// Map<order_ref, { ...tillwebFields, state: 'pending'|'processing'|'collect', collectAt: number|null }>
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
  return [
    { order_ref: "42",  order_name: "42",  total: "3.50",  paid: false, lines: [], created_at: new Date().toISOString() },
    { order_ref: "43",  order_name: "43",  total: "7.20",  paid: false, lines: [], created_at: new Date().toISOString() },
    { order_ref: "44",  order_name: "44",  total: "12.00", paid: false, lines: [], created_at: new Date().toISOString() },
    { order_ref: "45",  order_name: "45",  total: "5.60",  paid: true,  lines: [], created_at: new Date().toISOString() },
    { order_ref: "46",  order_name: "46",  total: "8.40",  paid: true,  lines: [], created_at: new Date().toISOString() },
    { order_ref: "47",  order_name: "47",  total: "4.20",  paid: true,  lines: [], created_at: new Date().toISOString() },
  ];
}

function seedMockCollect() {
  const now = Date.now();
  for (const ref of ["48", "49"]) {
    orderState.set(ref, {
      order_ref: ref, order_name: ref, total: "6.00",
      state: "collect", collectAt: now, lines: [],
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
        const ref = url.searchParams.get("order");
        if (ref) {
          const o = orderState.get(ref);
          if (!o) {
            sendJson(res, 404, { error: "not-found" });
          } else {
            sendJson(res, 200, { order: { order_ref: o.order_ref, state: o.state } });
          }
          return;
        }
        const orders = [...orderState.values()].map(o => ({
          order_ref: o.order_ref,
          order_name: o.order_name,
          total: o.total,
          lines: o.lines,
          created_at: o.created_at,
          state: o.state
        }));
        sendJson(res, 200, { orders, printer_alerts: printerAlerts });
        return;
      }

      // Operator marks an order as ready for collection.
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
        const collected = { ...order, state: "collect", collectAt: Date.now() };
        orderState.set(ref, collected);
        collectedRefs.add(ref);
        logCollect(config, collected);
        markCollected(config, ref).catch(err =>
          console.error(`[collect] Failed to mark ${ref} collected in tillweb: ${err.message}`)
        );
        sendJson(res, 200, { order_ref: ref, state: "collect" });
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

      // Clean URLs for the OMS screens
      const rewrites = { "/status": "/status.html", "/staff": "/staff.html", "/pay": "/pay.html", "/pay/control": "/pay-control.html", "/control": "/pay-control.html" };
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
