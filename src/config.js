import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function loadDotEnv(filePath = path.join(__dirname, "..", ".env")) {
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return;
  }
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).replace(/#.*$/, "").trim().replace(/^['"]|['"]$/g, "");
    if (!(key in process.env)) process.env[key] = val;
  }
}

function boolEnv(name, fallback) {
  const val = process.env[name];
  if (val === undefined) return fallback;
  return !["0", "false", "no", "off"].includes(val.toLowerCase());
}

function intEnv(name, fallback) {
  const val = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(val) ? val : fallback;
}

export function loadConfig() {
  loadDotEnv();
  const location = process.env.OMS_LOCATION ?? "spacebar";
  return {
    tillwebBaseUrl: (process.env.TILLWEB_BASE_URL ?? "").replace(/\/$/, ""),
    tillwebToken: process.env.TILLWEB_TOKEN ?? "",
    location,
    listenHost: process.env.OMS_LISTEN_HOST ?? "0.0.0.0",
    port: intEnv("OMS_PORT", 8081),
    pollInterval: intEnv("OMS_POLL_INTERVAL", 5),
    mockMode: boolEnv("OMS_MOCK_MODE", false),
    collectLog: process.env.OMS_COLLECT_LOG ?? "",
    publicDir: path.join(__dirname, "..", "public")
  };
}

export function validateRuntimeConfig(config) {
  const missing = [];
  if (!config.tillwebBaseUrl) missing.push("TILLWEB_BASE_URL");
  if (!config.tillwebToken) missing.push("TILLWEB_TOKEN");
  return missing;
}
