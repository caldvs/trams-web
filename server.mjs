// Serves the web app and proxies TfGM's Metrolink feed, so the API key stays on the server.
import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

// Local dev: TFGM_API_KEY can live in .env (gitignored). Real env vars win.
const envFile = fileURLToPath(new URL("./.env", import.meta.url));
if (existsSync(envFile)) {
  if (typeof process.loadEnvFile !== "function") {
    console.error(`Node ${process.versions.node} can't read .env: use Node 20.12 or newer.`);
    process.exit(1);
  }
  process.loadEnvFile(envFile);
}

const root = fileURLToPath(new URL("./public/", import.meta.url));
const host = process.env.HOST || "127.0.0.1"; // HOST=0.0.0.0 to reach it from your phone
const port = Number(process.env.PORT) || 8090;
const apiKey = process.env.TFGM_API_KEY?.trim();
const demo = process.env.DEMO === "1" || !apiKey;
const FRESH_MS = 15_000; // reuse TfGM's answer this long
const STALE_MS = 5 * 60_000; // if TfGM fails, fall back to an answer up to this old

const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
};

let cache = { at: 0, value: null };
let inFlight = null;

async function fetchTfgm() {
  let res;
  try {
    res = await fetch("https://api.tfgm.com/odata/Metrolinks", {
      headers: { "Ocp-Apim-Subscription-Key": apiKey },
      signal: AbortSignal.timeout(10_000),
    });
  } catch (err) {
    const timedOut = err.name === "TimeoutError";
    throw Object.assign(new Error(timedOut ? "TfGM didn't answer in time" : "Can't reach TfGM"), { status: timedOut ? 504 : 502 });
  }
  if (!res.ok) throw Object.assign(new Error(`TfGM answered ${res.status}`), { status: 502 });
  const { value } = await res.json();
  cache = { at: Date.now(), value };
  return value;
}

async function metrolinks() {
  if (demo) {
    const sample = JSON.parse(await readFile(new URL("./sample.json", import.meta.url), "utf8"));
    const now = new Date().toISOString();
    return { demo: true, value: sample.value.map((m) => ({ ...m, LastUpdated: now })) };
  }
  if (cache.value && Date.now() - cache.at < FRESH_MS) return { demo: false, value: cache.value };
  // Requests that arrive together share one call to TfGM.
  inFlight ??= fetchTfgm().finally(() => (inFlight = null));
  try {
    return { demo: false, value: await inFlight };
  } catch (err) {
    if (cache.value && Date.now() - cache.at < STALE_MS) {
      console.warn(`${err.message}; serving data from ${new Date(cache.at).toISOString()}`);
      return { demo: false, stale: true, value: cache.value };
    }
    throw err;
  }
}

function send(res, status, body, type = types[".json"]) {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}

createServer(async (req, res) => {
  const { pathname } = new URL(req.url, "http://x");
  try {
    if (pathname === "/api/metrolinks") {
      return send(res, 200, JSON.stringify(await metrolinks()));
    }
    const file = normalize(join(root, pathname === "/" ? "index.html" : pathname));
    if (!file.startsWith(root)) return send(res, 403, "Forbidden", "text/plain");
    const body = await readFile(file).catch(() => null);
    if (!body) return send(res, 404, "Not found", "text/plain");
    send(res, 200, body, types[extname(file)] ?? "application/octet-stream");
  } catch (err) {
    if (!err.status) console.error(err);
    send(res, err.status ?? 500, JSON.stringify({ error: err.status ? err.message : "Server error" }));
  }
}).listen(port, host, () => {
  console.log(`Trams on http://${host === "0.0.0.0" ? "localhost" : host}:${port}${demo ? " (sample data: set TFGM_API_KEY for live)" : ""}`);
});
