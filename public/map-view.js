// The live map page: the whole network, pan and zoom, and trams animated along the track at the
// positions live.js works out from the departure boards.
import { toXY, tramShape, tramTransform } from "./live.js";

const MIN_W = 600; // metres across, zoomed right in…
const MAX_W = 45_000; // …and right out
const LABELS_UNDER_W = 5_000; // stop names when zoomed in this far
const MAIN_ROADS_UNDER_W = 14_000;
const TILE_ROADS_UNDER_W = 4_500; // detailed road squares (with side streets under 2,500 m)
const MINOR_ROADS_UNDER_W = 2_500;
const TILE_LAT = 0.02; // keep in step with scripts/build-roads.mjs
const TILE_LON = 0.032;
const SVG_NS = "http://www.w3.org/2000/svg";

const el = (name, attrs = {}) => {
  const node = document.createElementNS(SVG_NS, name);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};
const escapeText = (s) => String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// `tracker` (live.js createTracker) is shared with the home page map and updated by the app.
export function createLiveMap(root, { net, colourFor, tracker }) {
  // Local coordinates in metres, x east and y south (SVG's way up), centred on St Peter's Square.
  const [ox, oy] = toXY([net.stops["St Peter's Square"][1], net.stops["St Peter's Square"][0]]);
  const local = ([x, y]) => [x - ox, oy - y];
  const fromLatLon = (lat, lon) => local(toXY([lon, lat]));

  root.innerHTML = `
    <div class="livemap">
      <svg class="livemap__svg" role="img" aria-label="Live map of trams">
        <g class="lm-roads"></g><g class="lm-tracks"></g><g class="lm-stops"></g><g class="lm-trams"></g><g class="lm-you"></g>
      </svg>
      <div class="livemap__controls">
        <button data-zoom="in" aria-label="Zoom in">+</button>
        <button data-zoom="out" aria-label="Zoom out">−</button>
        <button data-zoom="me" class="livemap__me" hidden>Near me</button>
      </div>
      <p class="livemap__status" aria-live="polite"></p>
    </div>
    <div class="livemap__info" hidden></div>
    <p class="livemap__note">Tram positions are estimated from departure boards; TfGM doesn't publish live locations.
      © OpenStreetMap contributors · Contains TfGM data · © Crown copyright 2017</p>`;
  const svg = root.querySelector("svg");
  const layer = (c) => svg.querySelector(`.lm-${c}`);
  const info = root.querySelector(".livemap__info");
  const status = root.querySelector(".livemap__status");

  // ---------- view: centre (cx, cy) and width w in metres ----------
  const allPts = Object.values(net.stops).map(([lat, lon]) => fromLatLon(lat, lon));
  const xs = allPts.map((p) => p[0]);
  const ys = allPts.map((p) => p[1]);
  const view = { cx: (Math.min(...xs) + Math.max(...xs)) / 2, cy: (Math.min(...ys) + Math.max(...ys)) / 2, w: 0 };
  const size = () => {
    const r = svg.getBoundingClientRect();
    return [r.width || 360, r.height || 480];
  };
  {
    const [pw, ph] = size();
    const spanX = Math.max(...xs) - Math.min(...xs);
    const spanY = Math.max(...ys) - Math.min(...ys);
    view.w = Math.max(spanX, (spanY * pw) / ph) * 1.08;
  }
  const inv = () => view.w / size()[0]; // metres per screen pixel

  function applyView({ settled = false } = {}) {
    view.w = Math.min(MAX_W, Math.max(MIN_W, view.w));
    const [pw, ph] = size();
    const h = (view.w * ph) / pw;
    svg.setAttribute("viewBox", `${view.cx - view.w / 2} ${view.cy - h / 2} ${view.w} ${h}`);
    const s = inv();
    for (const g of stopEls) g.setAttribute("transform", `translate(${g.dataset.x} ${g.dataset.y}) scale(${s})`);
    svg.classList.toggle("is-labelled", view.w < LABELS_UNDER_W);
    if (youEl) placeYou();
    clearTimeout(roadTimer);
    roadTimer = setTimeout(drawRoads, settled ? 0 : 150);
  }

  // ---------- static layers ----------
  layer("tracks").innerHTML = net.tracks
    .map((t) => `<path d="M${t.map(([lon, lat]) => fromLatLon(lat, lon).map((v) => v.toFixed(1)).join(" ")).join("L")}"/>`)
    .join("");

  const stopEls = [];
  for (const [name, [lat, lon]] of Object.entries(net.stops)) {
    const [x, y] = fromLatLon(lat, lon);
    const a = el("a", { href: `#/station/${encodeURIComponent(name)}`, class: "lm-stop" });
    const g = el("g");
    g.dataset.x = x.toFixed(1);
    g.dataset.y = y.toFixed(1);
    g.innerHTML = `<title>${escapeText(name)}</title><circle r="4" style="--c:${colourFor(name)}"/><text x="7" y="3.5">${escapeText(name)}</text>`;
    a.append(g);
    layer("stops").append(a);
    stopEls.push(g);
  }

  // ---------- roads (OpenStreetMap; main roads when zoomed out, detailed squares when in) ----------
  const roadCache = new Map();
  let roadTimer = 0;
  const roadFile = (key) => {
    if (roadCache.has(key)) return roadCache.get(key);
    roadCache.set(key, null);
    fetch(`roads/${key}.json`)
      .then((r) => (r.ok ? r.json() : []))
      .then((roads) => {
        roadCache.set(key, roads);
        drawRoads();
      })
      .catch(() => roadCache.set(key, []));
    return null;
  };
  function drawRoads() {
    const g = layer("roads");
    if (view.w > MAIN_ROADS_UNDER_W) return (g.innerHTML = "");
    const sources = [];
    if (view.w > TILE_ROADS_UNDER_W) sources.push(roadFile("main"));
    else {
      const [pw, ph] = size();
      const h = (view.w * ph) / pw;
      // Back from local metres to degrees to find the squares in view.
      const corners = [
        [view.cx - view.w / 2, view.cy - h / 2],
        [view.cx + view.w / 2, view.cy + h / 2],
      ].map(([x, y]) => [(x + ox) / (toXY([1, 0])[0]), (oy - y) / toXY([0, 1])[1]]); // [lon, lat]
      const [lonA, lonB] = [Math.min(corners[0][0], corners[1][0]), Math.max(corners[0][0], corners[1][0])];
      const [latA, latB] = [Math.min(corners[0][1], corners[1][1]), Math.max(corners[0][1], corners[1][1])];
      for (let i = Math.floor(latA / TILE_LAT); i <= Math.floor(latB / TILE_LAT); i++)
        for (let j = Math.floor(lonA / TILE_LON); j <= Math.floor(lonB / TILE_LON); j++) sources.push(roadFile(`${i}_${j}`));
    }
    const byClass = [[], [], [], [], [], [], []];
    const minor = view.w <= MINOR_ROADS_UNDER_W;
    for (const roads of sources)
      for (const road of roads ?? []) {
        const cls = road[0];
        if (cls >= 5 && !minor) continue;
        let lon = road[1];
        let lat = road[2];
        let d = "";
        for (let n = 1; n < road.length; n += 2) {
          if (n > 1) {
            lon += road[n];
            lat += road[n + 1];
          }
          const [x, y] = fromLatLon(lat / 1e5, lon / 1e5);
          d += `${n === 1 ? "M" : "L"}${x.toFixed(0)} ${y.toFixed(0)}`;
        }
        byClass[cls].push(d);
      }
    g.innerHTML = [6, 5, 4, 3, 2, 1, 0]
      .filter((c) => byClass[c].length)
      .map((c) => `<path class="road road--${c}" d="${byClass[c].join("")}"/>`)
      .join("");
  }

  // ---------- you ----------
  let here = null;
  let youEl = null;
  const meButton = root.querySelector(".livemap__me");
  function placeYou() {
    const [x, y] = fromLatLon(...here);
    youEl.setAttribute("transform", `translate(${x} ${y}) scale(${inv()})`);
  }

  // ---------- trams ----------
  const els = new Map(); // tram id -> <g>
  let selected = null;

  // Call after tracker.update(): adds and removes trams to match.
  function update() {
    const trams = tracker.trams;
    const ids = new Set(trams.map((t) => t.id));
    for (const [id, g] of els)
      if (!ids.has(id)) {
        g.remove();
        els.delete(id);
      }
    for (const t of trams) {
      let g = els.get(t.id);
      if (!g) {
        g = el("g", { class: "lm-tram is-new" });
        g.dataset.id = t.id;
        layer("trams").append(g);
        els.set(t.id, g);
      }
      g.innerHTML = tramShape(t.data, colourFor(t.data.dest));
      g.classList.toggle("is-selected", t.id === selected);
    }
    if (selected && !ids.has(selected)) select(null);
    status.textContent = trams.length ? `${trams.length} trams` : "No trams running right now";
    showInfo();
  }

  let raf = 0;
  function frame() {
    tracker.step();
    const s = inv();
    for (const t of tracker.trams) {
      const g = els.get(t.id);
      if (!g) continue;
      g.setAttribute("transform", tramTransform(local(t.p), t.angle, s, 4.5 * s));
      g.classList.remove("is-new");
    }
    raf = requestAnimationFrame(frame);
  }

  function select(id) {
    selected = id;
    for (const [tid, g] of els) g.classList.toggle("is-selected", tid === id);
    showInfo();
  }
  function showInfo() {
    const t = tracker.trams.find((x) => x.id === selected);
    info.hidden = !t;
    if (!t) return;
    const mins = Math.max(0, Math.round((t.data.arriveAt - Date.now()) / 60_000));
    const next = t.data.to === t.data.dest ? `${t.data.to} (last stop)` : t.data.to;
    info.innerHTML = `<b style="--c:${colourFor(t.data.dest)}">${escapeText(t.data.dest)}</b>
      <span>Next stop ${escapeText(next)}, ${mins ? `${mins} min` : "due"}${t.data.double ? " · Double tram" : ""}</span>
      <a href="#/station/${encodeURIComponent(t.data.to)}">${escapeText(t.data.to)} departures ›</a>`;
  }
  const infoTimer = setInterval(showInfo, 5_000);

  // ---------- pan, zoom, taps ----------
  const pointers = new Map();
  let gesture = null;
  const toWorld = (clientX, clientY) => {
    const r = svg.getBoundingClientRect();
    const s = inv();
    const h = (view.w * r.height) / r.width;
    return [view.cx - view.w / 2 + (clientX - r.left) * s, view.cy - h / 2 + (clientY - r.top) * s];
  };
  const zoomAt = (factor, clientX, clientY) => {
    const before = toWorld(clientX, clientY);
    view.w = Math.min(MAX_W, Math.max(MIN_W, view.w * factor));
    applyView();
    const after = toWorld(clientX, clientY);
    view.cx += before[0] - after[0];
    view.cy += before[1] - after[1];
    applyView();
  };
  svg.addEventListener("pointerdown", (e) => {
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    const pts = [...pointers.values()];
    gesture = {
      moved: false,
      start: pts.map((p) => [...p]),
      cx: view.cx,
      cy: view.cy,
      w: view.w,
      mid: pts.length === 2 ? toWorld((pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2) : null,
    };
  });
  svg.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId) || !gesture) return;
    pointers.set(e.pointerId, [e.clientX, e.clientY]);
    const pts = [...pointers.values()];
    if (pts.length === 1) {
      const [dx, dy] = [pts[0][0] - gesture.start[0][0], pts[0][1] - gesture.start[0][1]];
      if (!gesture.moved && Math.hypot(dx, dy) < 6) return;
      if (!gesture.moved) svg.setPointerCapture(e.pointerId);
      gesture.moved = true;
      const s = gesture.w / size()[0];
      view.cx = gesture.cx - dx * s;
      view.cy = gesture.cy - dy * s;
      applyView();
    } else if (pts.length === 2 && gesture.start.length === 2) {
      gesture.moved = true;
      const d0 = Math.hypot(gesture.start[0][0] - gesture.start[1][0], gesture.start[0][1] - gesture.start[1][1]);
      const d1 = Math.hypot(pts[0][0] - pts[1][0], pts[0][1] - pts[1][1]);
      view.w = gesture.w * (d0 / (d1 || 1));
      applyView();
      // Keep the point that started under the fingers' midpoint under it.
      const now = toWorld((pts[0][0] + pts[1][0]) / 2, (pts[0][1] + pts[1][1]) / 2);
      view.cx += gesture.mid[0] - now[0];
      view.cy += gesture.mid[1] - now[1];
      applyView();
    }
  });
  const end = (e) => {
    const wasDrag = gesture?.moved;
    pointers.delete(e.pointerId);
    if (!pointers.size) {
      if (wasDrag) applyView({ settled: true });
      else if (e.type === "pointerup") {
        // A tap: on a tram selects it; on empty map clears the selection. Stop taps follow their link.
        const tram = e.target.closest?.(".lm-tram");
        if (tram) select(Number(tram.dataset.id));
        else if (!e.target.closest?.(".lm-stop")) select(null);
      }
      gesture = null;
    } else gesture = { ...gesture, start: [...pointers.values()].map((p) => [...p]), cx: view.cx, cy: view.cy, w: view.w };
  };
  svg.addEventListener("pointerup", end);
  svg.addEventListener("pointercancel", end);
  // A drag that ends on a stop shouldn't open it.
  svg.addEventListener("click", (e) => {
    if (e.target.closest(".lm-stop") && suppressClick) {
      e.preventDefault();
      suppressClick = false;
    }
  });
  let suppressClick = false;
  svg.addEventListener("pointerup", () => (suppressClick = false), true);
  svg.addEventListener("pointermove", () => gesture?.moved && (suppressClick = true), true);
  svg.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      zoomAt(Math.exp(e.deltaY * 0.0015), e.clientX, e.clientY);
    },
    { passive: false },
  );
  root.querySelector(".livemap__controls").addEventListener("click", (e) => {
    const z = e.target.closest("[data-zoom]")?.dataset.zoom;
    const r = svg.getBoundingClientRect();
    if (z === "in") zoomAt(1 / 1.6, r.left + r.width / 2, r.top + r.height / 2);
    if (z === "out") zoomAt(1.6, r.left + r.width / 2, r.top + r.height / 2);
    if (z === "me" && here) {
      [view.cx, view.cy] = fromLatLon(...here);
      view.w = 3_000;
      applyView({ settled: true });
    }
  });
  const onResize = () => applyView({ settled: true });
  window.addEventListener("resize", onResize);

  applyView({ settled: true });
  raf = requestAnimationFrame(frame);

  return {
    update,
    setHere(latLon) {
      here = latLon;
      meButton.hidden = !here;
      if (!here) return youEl?.remove(), (youEl = null);
      if (!youEl) {
        youEl = el("g", { class: "lm-me" });
        youEl.innerHTML = `<circle r="11" class="you__halo"/><circle r="5.5"/>`;
        layer("you").append(youEl);
      }
      placeYou();
    },
    destroy() {
      cancelAnimationFrame(raf);
      clearInterval(infoTimer);
      clearTimeout(roadTimer);
      window.removeEventListener("resize", onResize);
    },
  };
}
