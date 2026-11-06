// Web port of the trams iOS app: stop list -> stop detail, from /api/metrolinks.
const REFRESH_MS = 30_000;
const OLD_DATA_MS = 3 * 60_000; // warn when TfGM's own timestamp is older than this
const NEAREST = 3;

const $ = (sel) => document.querySelector(sel);
const app = $("#app");
const state = {
  rows: [],
  loading: false,
  error: null,
  stale: false, // server fell back to an older answer
  fetchedAt: null,
  query: "",
  favs: new Set(readFavs()),
  stops: {}, // name -> [lat, lon]
  here: null, // [lat, lon] once the user asks for nearest stops
  locating: false,
  locError: null,
  listScroll: null, // where the list was when you opened a stop
};

// ---------- data helpers ----------

// TfGM's Line values, plus the names the iOS app used.
const LINE_COLOURS = {
  altrincham: "#0a84ff",
  "altrincham - piccadilly": "#0a84ff",
  bury: "#a68400",
  "bury - piccadilly": "#a68400",
  eccles: "#30b350",
  "eccles - ashton": "#30b350",
  "east manchester": "#30b350",
  airport: "#ff9500",
  "airport - victoria": "#ff9500",
  "oldham & rochdale": "#ff3b30",
  "rochdale - east didsbury": "#ff3b30",
  "south manchester": "#ff3b30",
  "trafford park": "#af52de",
  "manchester airport - etihad campus": "#af52de",
};
const lineColour = (line) => LINE_COLOURS[line.toLowerCase()] ?? "#8e8e93";

const esc = (s) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

function departures(m) {
  return [0, 1, 2, 3]
    .map((i) => ({ dest: m[`Dest${i}`], carriages: m[`Carriages${i}`], status: m[`Status${i}`], wait: m[`Wait${i}`] }))
    .filter((d) => d.dest);
}

// Message boards carry the signs' control codes: ^J is a line break, ^F0 and friends are formatting.
// The standing "Welcome to Metrolink" notice is on nearly every sign, so it's dropped.
const message = (m) => {
  const text = (m.MessageBoard ?? "")
    .replace(/\^J/g, "\n")
    .replace(/\^[A-Z][0-9A-F]?/g, " ")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  if (!text || text === "<no message>" || /^welcome to metrolink\b/i.test(text)) return "";
  return text;
};

function byStation() {
  const map = new Map();
  for (const m of state.rows) {
    if (!map.has(m.StationLocation)) map.set(m.StationLocation, []);
    map.get(m.StationLocation).push(m);
  }
  return map;
}

// A platform can have several signs (TPID, TPTS, TPTD) showing the same trams; keep one of each.
const boardKey = (m) => [m.Direction, ...departures(m).map((d) => `${d.dest}|${d.wait}|${d.carriages}`)].join("#");
const signRank = (m) => (/-TPID\d/.test(m.PIDREF) ? 0 : 1);
function platformsAt(name) {
  const rows = (byStation().get(name) ?? [])
    .slice()
    .sort((a, b) => a.Direction.localeCompare(b.Direction) || signRank(a) - signRank(b) || a.PIDREF.localeCompare(b.PIDREF));
  const seen = new Set();
  return rows.filter((m) => !seen.has(boardKey(m)) && seen.add(boardKey(m)));
}

function nextDeparture(platforms) {
  let best = null;
  for (const p of platforms)
    for (const d of departures(p)) {
      const mins = d.wait === "" ? Infinity : Number(d.wait);
      if (!best || mins < best.mins) best = { ...d, mins };
    }
  return best;
}

// TfGM's Status is "Due" for any upcoming tram; only a 0 wait or Arrived/Departing means it's here.
const isHere = (d) => d.wait === "0" || /arrived|departing/i.test(d.status);
const waitText = (d) => (isHere(d) ? "Due" : d.wait ? `${d.wait} min` : "–");
const statusNote = (d) => (/^due$/i.test(d.status) ? "" : d.status);
function waitClass(d) {
  if (isHere(d)) return "is-due";
  if (/delay/i.test(d.status)) return "is-late";
  return d.wait !== "" && Number(d.wait) <= 5 ? "is-soon" : "";
}

// "st peters" finds "St Peter's Square"; "deansgate castlefield" finds "Deansgate - Castlefield".
const norm = (s) => s.toLowerCase().replace(/['’]/g, "").replace(/[^a-z0-9]+/g, " ").trim();

function distanceKm([lat1, lon1], [lat2, lon2]) {
  const r = (x) => (x * Math.PI) / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(a));
}
const distanceText = (km) => (km < 1 ? `${Math.round((km * 1000) / 10) * 10} m` : `${km.toFixed(1)} km`);

const time = (d) => d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

// ---------- favourites (this browser only) ----------

function readFavs() {
  try {
    return JSON.parse(localStorage.getItem("trams:favs") ?? "[]");
  } catch {
    return [];
  }
}
function toggleFav(name) {
  state.favs.has(name) ? state.favs.delete(name) : state.favs.add(name);
  try {
    localStorage.setItem("trams:favs", JSON.stringify([...state.favs]));
  } catch {}
  render();
}

// ---------- views ----------

function chips(platforms) {
  const lines = [...new Set(platforms.map((p) => p.Line))].sort();
  return lines.map((l) => `<span class="chip" style="--c:${lineColour(l)}">${esc(l)}</span>`).join("");
}

function stopRow(name, platforms, extra = "") {
  const next = nextDeparture(platforms);
  return `<li><a class="row" href="#/station/${encodeURIComponent(name)}">
    <span class="row__main">
      <span class="row__name">${state.favs.has(name) ? '<span class="star" aria-label="Saved">★</span> ' : ""}${esc(name)}</span>
      <span class="chips">${chips(platforms)}${extra}</span>
    </span>
    ${next ? `<span class="row__next"><b class="${waitClass(next)}">${esc(waitText(next))}</b><small>${esc(next.dest)}</small></span>` : ""}
    <span class="chev" aria-hidden="true">›</span>
  </a></li>`;
}

const section = (title, rows) => (rows ? `<h2 class="section">${title}</h2><ul class="list">${rows}</ul>` : "");

function renderList() {
  const stations = byStation();
  const q = norm(state.query);
  const names = [...stations.keys()].sort((a, b) => a.localeCompare(b));
  let html = "";

  if (q) {
    const rows = names.filter((n) => norm(n).includes(q)).map((n) => stopRow(n, stations.get(n))).join("");
    html = rows ? `<ul class="list">${rows}</ul>` : `<p class="empty">No stops match “${esc(state.query)}”.</p>`;
  } else {
    const favs = names.filter((n) => state.favs.has(n));
    html += section("Saved", favs.map((n) => stopRow(n, stations.get(n))).join(""));

    if (state.here) {
      const near = names
        .filter((n) => state.stops[n])
        .map((n) => [n, distanceKm(state.here, state.stops[n])])
        .sort((a, b) => a[1] - b[1])
        .slice(0, NEAREST);
      html += section("Nearest", near.map(([n, km]) => stopRow(n, stations.get(n), `<span class="dist">${distanceText(km)}</span>`)).join(""));
    } else {
      html += `<button class="link" data-action="locate" ${state.locating ? "disabled" : ""}>${state.locating ? "Finding you…" : "Show nearest stops"}</button>`;
      if (state.locError) html += `<p class="muted note">${esc(state.locError)}</p>`;
    }

    html += section("All stops", names.map((n) => stopRow(n, stations.get(n))).join(""));
  }

  const input = $("#search");
  if (input) {
    // Keep the search box (its focus and cursor) and only redraw the results.
    $("#results").innerHTML = html;
  } else {
    app.innerHTML = `<input id="search" class="search" type="search" placeholder="Search stops" autocomplete="off" aria-label="Search stops" value="${esc(state.query)}">
      <div id="results">${html}</div>`;
  }
}

function renderStation(name) {
  const platforms = platformsAt(name);
  if (!platforms.length) {
    app.innerHTML = `<p class="empty">No live data for ${esc(name)}.</p>`;
    return;
  }
  const saved = state.favs.has(name);
  // TfGM repeats the same notice on every platform; show each one once.
  const notices = [...new Set(platforms.map(message).filter(Boolean))];
  // TfGM's Line is one value per stop (its area of the network), not each tram's route.
  app.innerHTML =
    `<div class="area"><span class="chips">${chips(platforms)}</span>
      <button class="fav ${saved ? "is-on" : ""}" data-action="fav" aria-pressed="${saved}">${saved ? "★ Saved" : "☆ Save"}</button></div>` +
    notices.map((n) => `<p class="msg">${esc(n)}</p>`).join("") +
    platforms
      .map((p) => {
        const deps = departures(p);
        return `<section class="card">
        <header class="card__head"><h2 class="card__dir">${esc(p.Direction)}</h2></header>
        ${
          deps.length
            ? `<ul class="deps">${deps
                .map(
                  (d) => `<li class="dep">
                  <span class="dep__dest">${esc(d.dest)}
                    <small>${[d.carriages === "Double" ? "Double tram" : "", statusNote(d)].filter(Boolean).map(esc).join(" · ")}</small>
                  </span>
                  <span class="dep__wait ${waitClass(d)}">${esc(waitText(d))}</span>
                </li>`,
                )
                .join("")}</ul>`
            : `<p class="muted pad">No trams due</p>`
        }
      </section>`;
      })
      .join("");
}

function renderFooter() {
  const footer = $("#updated");
  const newest = state.rows.reduce((max, m) => Math.max(max, Date.parse(m.LastUpdated) || 0), 0);
  if (state.error && state.rows.length) {
    footer.textContent = `Couldn't refresh: ${state.error}. Times from ${time(state.fetchedAt)}.`;
  } else if (state.stale || (newest && Date.now() - newest > OLD_DATA_MS)) {
    footer.textContent = `TfGM's times are from ${time(new Date(newest || state.fetchedAt))} and may be out of date.`;
  } else {
    footer.textContent = state.fetchedAt ? `Updated ${time(state.fetchedAt)}` : "";
  }
  footer.classList.toggle("is-warn", Boolean(state.error || state.stale || (newest && Date.now() - newest > OLD_DATA_MS)));
}

function route() {
  const m = location.hash.match(/^#\/station\/(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}

function render() {
  const station = route();
  $("#title").textContent = station ?? "Metrolink";
  document.title = station ? `${station} · Trams` : "Trams";
  $(".back").hidden = !station;
  $("#refresh").classList.toggle("spin", state.loading);

  if (state.error && !state.rows.length) {
    app.innerHTML = `<div class="empty"><p>${esc(state.error)}</p><button class="btn" data-action="retry">Retry</button></div>`;
  } else if (!state.rows.length) {
    app.innerHTML = `<p class="empty">Loading stops…</p>`;
  } else if (station) {
    renderStation(station);
  } else {
    renderList();
  }
  renderFooter();
}

// ---------- loading ----------

async function load() {
  if (state.loading) return;
  state.loading = true;
  $("#refresh").classList.add("spin");
  try {
    const res = await fetch("/api/metrolinks");
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !Array.isArray(body.value)) throw new Error(body.error ?? `Server answered ${res.status}`);
    state.rows = body.value;
    state.stale = Boolean(body.stale);
    state.error = null;
    state.fetchedAt = new Date();
    $("#demo").hidden = !body.demo;
  } catch (err) {
    state.error = err instanceof TypeError ? "Can't reach the server" : err.message;
  } finally {
    state.loading = false;
    render();
  }
}

function locate() {
  if (!navigator.geolocation) {
    state.locError = "This browser can't share your location.";
    return render();
  }
  state.locating = true;
  state.locError = null;
  render();
  navigator.geolocation.getCurrentPosition(
    (pos) => {
      state.here = [pos.coords.latitude, pos.coords.longitude];
      state.locating = false;
      render();
    },
    (err) => {
      state.locating = false;
      state.locError =
        err.code === err.PERMISSION_DENIED
          ? "Location is blocked for this page."
          : window.isSecureContext
            ? "Couldn't find your location."
            : "Location needs https or localhost.";
      render();
    },
    { timeout: 10_000, maximumAge: 60_000 },
  );
}

// ---------- events ----------

app.addEventListener("input", (e) => {
  if (e.target.id !== "search") return;
  state.query = e.target.value;
  renderList();
});

app.addEventListener("click", (e) => {
  const action = e.target.closest("[data-action]")?.dataset.action;
  if (action === "retry") load();
  if (action === "locate") locate();
  if (action === "fav") toggleFav(route());
});

// Coming back to the list puts the stop you opened where it was on screen, even if the
// sections above it changed (e.g. you just saved it).
const rowFor = (name) =>
  [...document.querySelectorAll("#results .list:last-of-type .row")].find((a) => a.getAttribute("href") === `#/station/${encodeURIComponent(name)}`);
let lastRoute = route();
window.addEventListener("hashchange", () => {
  const next = route();
  if (!lastRoute && next) {
    const row = rowFor(next);
    state.listScroll = { name: next, offset: row ? row.getBoundingClientRect().top : null, y: window.scrollY };
  }
  const back = lastRoute && !next ? state.listScroll : null;
  lastRoute = next;
  app.innerHTML = "";
  render();
  if (!back) return window.scrollTo(0, 0);
  const row = back.offset != null && rowFor(back.name);
  window.scrollTo(0, row ? window.scrollY + row.getBoundingClientRect().top - back.offset : back.y);
});

$("#refresh").addEventListener("click", load);
document.addEventListener("visibilitychange", () => {
  if (!document.hidden) load();
});
setInterval(() => {
  if (!document.hidden) load();
}, REFRESH_MS);

fetch("stops.json")
  .then((r) => r.json())
  .then((stops) => (state.stops = stops))
  .catch(() => {});
render();
load();
