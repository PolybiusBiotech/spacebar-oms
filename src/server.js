import fs from "node:fs/promises";
import http from "node:http";
import { appendFileSync } from "node:fs";
import path from "node:path";

import { loadConfig, validateRuntimeConfig } from "./config.js";
import { fetchOrders, TillwebError } from "./tillweb.js";

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

// In-memory printer alerts from kiosks. Keyed by location, last alert wins.
// { [location]: { message, at } }
const printerAlerts = {};

// In-memory summon state.
const SUMMON_DEFAULT = "PAY HERE";
let summonMessage = SUMMON_DEFAULT;
let summonClearTimer = null;
const summonClients = new Set();
const SUMMON_IDLE_MS = 30_000;

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

function broadcastSummon() {
  const data = `data: ${JSON.stringify({ message: summonMessage })}\n\n`;
  for (const res of summonClients) {
    res.write(data);
  }
}

function setSummonMessage(msg) {
  summonMessage = msg || SUMMON_DEFAULT;
  clearTimeout(summonClearTimer);
  summonClearTimer = null;
  if (summonMessage !== SUMMON_DEFAULT) {
    summonClearTimer = setTimeout(() => {
      summonMessage = SUMMON_DEFAULT;
      broadcastSummon();
    }, SUMMON_IDLE_MS);
  }
  broadcastSummon();
}

function transitionOrder(ref, incoming) {
  const existing = orderState.get(ref);

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
    } else if (!liveRefs.has(ref)) {
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
    { order_ref: "AA1111", order_name: "SB AA1111", total: "5.60", paid: false, lines: [], created_at: new Date().toISOString() },
    { order_ref: "BB2222", order_name: "SB BB2222", total: "8.40", paid: true,  lines: [], created_at: new Date().toISOString() }
  ];
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
        sendJson(res, 200, { ok: true });
        return;
      }

      if (url.pathname === "/api/orders" && req.method === "GET") {
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
        logCollect(config, collected);
        sendJson(res, 200, { order_ref: ref, state: "collect" });
        return;
      }

      if (url.pathname === "/summon/events" && req.method === "GET") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          "Connection": "keep-alive",
          "X-Accel-Buffering": "no"
        });
        res.write(`data: ${JSON.stringify({ message: summonMessage })}\n\n`);
        summonClients.add(res);
        req.on("close", () => summonClients.delete(res));
        return;
      }

      if (url.pathname === "/summon/order-loaded" && req.method === "POST") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
        const orderRef = String(body.order_ref ?? "").slice(0, 40);
        const softOnly = Boolean(body.soft_only);
        if (orderRef) {
          const payload = `event: order-loaded\ndata: ${JSON.stringify({ order_ref: orderRef, soft_only: softOnly })}\n\n`;
          for (const client of summonClients) client.write(payload);
          console.log(`[summon] order loaded: ${orderRef}${softOnly ? " (soft-only)" : ""}`);
        }
        sendJson(res, 200, { ok: true });
        return;
      }

      if (url.pathname === "/summon/help" && req.method === "POST") {
        setSummonMessage("PLEASE WAIT");
        const helpAlert = `event: help\ndata: {}\n\n`;
        for (const client of summonClients) client.write(helpAlert);
        sendJson(res, 200, { ok: true });
        return;
      }

      if (url.pathname === "/summon/message" && req.method === "POST") {
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        let body = {};
        try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); } catch {}
        setSummonMessage(String(body.message ?? "").slice(0, 200));
        sendJson(res, 200, { ok: true, message: summonMessage });
        return;
      }

      if (url.pathname === "/summon/clear" && req.method === "POST") {
        setSummonMessage("");
        sendJson(res, 200, { ok: true });
        return;
      }

      // Clean URLs for the OMS screens
      const rewrites = { "/customer": "/customer.html", "/staff": "/staff.html", "/summon": "/summon.html", "/summon/control": "/summon-control.html" };
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

if (import.meta.url === `file://${process.argv[1]}`) {
  const config = loadConfig();

  if (config.mockMode) {
    for (const order of mockOrders()) {
      transitionOrder(order.order_ref, order);
    }
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
    for (const client of summonClients) {
      try { client.write(": ping\n\n"); } catch { summonClients.delete(client); }
    }
  }, 25_000);
}
