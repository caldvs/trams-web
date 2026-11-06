// Live tram positions, worked out from departure boards (TfGM publishes no GPS).
//
// 1. buildGraph(): turns TfGM's track sections + stop positions into a graph of stops, each pair of
//    neighbouring stops knowing the exact track between them.
// 2. inferTrams(): reads every board. "Eccles, 2 min" at Exchange Square means a tram heading for
//    Eccles is about 2 minutes back along the track from Exchange Square. Each tram appears on every
//    board ahead of it, so it's placed only on the stretch between the stop it has just passed and
//    its next stop: where its wait is shorter than that stretch's travel time.
// 3. trackPoint(): where along that stretch a tram is at a given moment, for animation.
//
// Works in the browser and in Node (no DOM), so it can be tested against saved feed snapshots.

const M_PER_DEG_LAT = 110_574;
const M_PER_DEG_LON = 111_320 * Math.cos((53.48 * Math.PI) / 180);
const JOIN_M = 15; // track ends this close together are the same junction
const CENTRE = "St Peter's Square"; // "Incoming" boards mean towards here
const DEFAULT_SPEED_M_PER_MIN = 420; // about 25 km/h, Metrolink's average with stops…
const DWELL_MIN = 0.4; // …plus a short stop at each platform

export const toXY = ([lon, lat]) => [lon * M_PER_DEG_LON, lat * M_PER_DEG_LAT];
export const toLonLat = ([x, y]) => [x / M_PER_DEG_LON, y / M_PER_DEG_LAT];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
// Cosine of the turn at b when going a -> b -> c: 1 straight on, 0 a right angle, -1 doubling back.
function heading(a, b, c) {
  const [ux, uy, vx, vy] = [b[0] - a[0], b[1] - a[1], c[0] - b[0], c[1] - b[1]];
  return (ux * vx + uy * vy) / ((Math.hypot(ux, uy) * Math.hypot(vx, vy)) || 1);
}

// "Ashton-under-Lyne", "Ashton-Under-Lyne" and "Besses o' th' Barn" vs "Besses O’ Th’ Barn" all match.
export const normName = (s) => s.toLowerCase().replace(/[’`]/g, "'").replace(/[^a-z0-9]+/g, " ").trim();

function nearestOnSegment(p, a, b) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const u = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy || 1)));
  const q = [a[0] + u * dx, a[1] + u * dy];
  return { q, d: dist(p, q), u };
}

export function buildGraph(net) {
  // Vertices are shared between track sections at junctions; each section is a list of vertex ids.
  const verts = []; // { p: [x, y], stop?: name }
  const tracks = net.tracks.map((t) => t.map((pt) => verts.push({ p: toXY(pt) }) - 1));

  // Insert a new vertex into section `ti` at the point nearest `p`, unless an existing vertex is close.
  function insertAt(ti, p, maxD) {
    const ids = tracks[ti];
    let best = null;
    for (let k = 0; k < ids.length - 1; k++) {
      const r = nearestOnSegment(p, verts[ids[k]].p, verts[ids[k + 1]].p);
      if (!best || r.d < best.d) best = { ...r, k };
    }
    if (!best || best.d > maxD) return null;
    const near = [ids[best.k], ids[best.k + 1]].find((id) => dist(verts[id].p, best.q) < 1);
    if (near !== undefined) return near;
    const id = verts.push({ p: best.q }) - 1;
    ids.splice(best.k + 1, 0, id);
    return id;
  }

  // Join section ends to other sections' ends, or to the middle of another section (a junction).
  const parent = []; // union-find over vertices; vertices added later get an entry on first use
  const find = (i) => {
    parent[i] ??= i;
    return parent[i] === i ? i : (parent[i] = find(parent[i]));
  };
  const union = (a, b) => (parent[find(a)] = find(b));
  tracks.forEach((ids, ti) => {
    for (const end of [ids[0], ids[ids.length - 1]]) {
      let joined = false;
      tracks.forEach((other, oi) => {
        if (oi === ti) return;
        for (const oe of [other[0], other[other.length - 1]])
          if (dist(verts[end].p, verts[oe].p) < JOIN_M) {
            union(end, oe);
            joined = true;
          }
      });
      if (joined) continue;
      tracks.forEach((_, oi) => {
        if (oi === ti || joined) return;
        const id = insertAt(oi, verts[end].p, JOIN_M);
        if (id !== null) {
          union(end, id);
          joined = true;
        }
      });
    }
  });

  // Put each stop on its nearest section.
  for (const [name, [lat, lon]] of Object.entries(net.stops)) {
    const p = toXY([lon, lat]);
    let best = null;
    tracks.forEach((ids, ti) => {
      for (let k = 0; k < ids.length - 1; k++) {
        const r = nearestOnSegment(p, verts[ids[k]].p, verts[ids[k + 1]].p);
        if (!best || r.d < best.d) best = { ti, d: r.d };
      }
    });
    const id = insertAt(best.ti, p, 50);
    verts[find(id)].stop = name;
  }

  // Vertex adjacency (after merging junctions).
  const adj = new Map();
  const link = (a, b) => {
    const [ra, rb] = [find(a), find(b)];
    if (ra === rb) return;
    const d = dist(verts[ra].p, verts[rb].p);
    if (!adj.has(ra)) adj.set(ra, []);
    if (!adj.has(rb)) adj.set(rb, []);
    adj.get(ra).push([rb, d]);
    adj.get(rb).push([ra, d]);
  };
  for (const ids of tracks) for (let k = 0; k < ids.length - 1; k++) link(ids[k], ids[k + 1]);

  // Stop graph: from each stop, walk the track until the next stop in every direction.
  const stopVertex = new Map();
  verts.forEach((v, i) => v.stop && find(i) === i && stopVertex.set(v.stop, i));
  const neighbours = new Map(); // name -> [{ to, len, path: [[x, y], …] }]
  for (const [name, start] of stopVertex) {
    const out = [];
    for (const [first, d0] of adj.get(start) ?? []) {
      let prev = start;
      let cur = first;
      let len = d0;
      const path = [verts[start].p, verts[first].p];
      const seen = new Set([start]);
      // Follow the line; at a junction, explore each branch.
      const stack = [[prev, cur, len, path, seen]];
      while (stack.length) {
        [prev, cur, len] = stack[stack.length - 1];
        const [, , , p, s] = stack.pop();
        if (verts[cur].stop) {
          if (!out.some((o) => o.to === verts[cur].stop && o.len <= len)) {
            const i = out.findIndex((o) => o.to === verts[cur].stop);
            if (i >= 0) out.splice(i, 1);
            out.push({ to: verts[cur].stop, len, path: p });
          }
          continue;
        }
        s.add(cur);
        for (const [next, d] of adj.get(cur) ?? []) {
          if (next === prev || s.has(next)) continue;
          // Trams can't take a hairpin through a junction: skip turns sharper than 90°.
          if (heading(verts[prev].p, verts[cur].p, verts[next].p) < 0) continue;
          stack.push([cur, next, len + d, [...p, verts[next].p], new Set(s)]);
        }
      }
    }
    neighbours.set(name, out);
  }

  const byNorm = new Map([...stopVertex.keys()].map((n) => [normName(n), n]));
  const segment = (from, to) => neighbours.get(from)?.find((n) => n.to === to) ?? null;

  // A tram arriving at `stop` along a->stop can carry on to b only if it doesn't double back.
  const canContinue = (a, stop, b) => {
    if (a === b) return false;
    const inn = segment(a, stop)?.path;
    const out = segment(stop, b)?.path;
    if (!inn || !out) return false;
    return heading(inn[Math.max(0, inn.length - 3)], inn[inn.length - 1], out[Math.min(out.length - 1, 2)]) > -0.2;
  };

  // Shortest legal route from every stop to every other: Dijkstra over directed stretches (a->b),
  // so a route can't reverse at a stop. Records the first stop after `from` and the distance.
  const nextHop = new Map();
  const routeLen = new Map();
  for (const from of stopVertex.keys()) {
    const best = new Map(); // "a>b" -> distance
    const first = new Map(); // destination stop -> first hop
    const reach = new Map([[from, 0]]);
    const queue = neighbours.get(from).map((n) => [n.len, from, n.to, n.to]);
    while (queue.length) {
      queue.sort((x, y) => x[0] - y[0]);
      const [d, a, b, hop] = queue.shift();
      const key = `${a}>${b}`;
      if (best.has(key)) continue;
      best.set(key, d);
      if (d < (reach.get(b) ?? Infinity)) {
        reach.set(b, d);
        first.set(b, hop);
      }
      for (const n of neighbours.get(b)) if (canContinue(a, b, n.to) && !best.has(`${b}>${n.to}`)) queue.push([d + n.len, b, n.to, hop]);
    }
    nextHop.set(from, first);
    routeLen.set(from, reach);
  }

  return {
    stops: [...stopVertex.keys()],
    neighbours,
    nextHop: (from, to) => (from === to ? null : nextHop.get(from)?.get(to) ?? null),
    distance: (from, to) => routeLen.get(from)?.get(to) ?? Infinity,
    segment,
    canContinue,
    stopName: (s) => byNorm.get(normName(s)) ?? null,
    centre: CENTRE,
  };
}

// ---------- travel times ----------

// Minutes between neighbouring stops: from the boards themselves where possible (the same tram's
// wait at A and at B differ by the travel time), otherwise from the track length.
export function travelTimes(graph, rows, previous = new Map()) {
  const samples = new Map();
  const waits = boardsByStop(graph, rows);
  for (const [a, byDest] of waits)
    for (const [dest, wA] of byDest) {
      const b = graph.nextHop(a, dest);
      const wB = b && waits.get(b)?.get(dest);
      if (!wB) continue;
      for (const w of wA) {
        const later = wB.filter((x) => x >= w).sort((x, y) => x - y)[0];
        if (later === undefined || later - w > 6) continue;
        const key = `${a}>${b}`;
        if (!samples.has(key)) samples.set(key, []);
        samples.get(key).push(later - w);
      }
    }
  const times = new Map(previous);
  for (const [key, list] of samples) {
    if (list.length < 2) continue;
    list.sort((x, y) => x - y);
    const median = list[list.length >> 1];
    const old = previous.get(key);
    // Integer minutes are coarse: blend with what we knew, and keep it at least a little above 0.
    times.set(key, Math.max(0.6, old === undefined ? median : old * 0.7 + median * 0.3));
  }
  return times;
}

export function segmentMinutes(graph, times, from, to) {
  const known = times.get(`${from}>${to}`);
  if (known !== undefined) return known;
  const seg = graph.segment(from, to);
  return seg ? seg.len / DEFAULT_SPEED_M_PER_MIN + DWELL_MIN : 2;
}

// stop -> destination stop -> [waits in minutes], merging a stop's platforms and duplicate signs.
function boardsByStop(graph, rows) {
  const out = new Map();
  for (const m of rows) {
    const stop = graph.stopName(m.StationLocation);
    if (!stop) continue;
    for (let i = 0; i < 4; i++) {
      const dest = destination(graph, m[`Dest${i}`], stop);
      const wait = m[`Wait${i}`];
      if (!dest || wait === "") continue;
      if (!out.has(stop)) out.set(stop, new Map());
      const byDest = out.get(stop);
      if (!byDest.has(dest)) byDest.set(dest, []);
      const w = Number(wait);
      if (!byDest.get(dest).includes(w)) byDest.get(dest).push(w);
    }
  }
  return out;
}

// "Eccles via MediaCityUK" -> Eccles; "Terminates Here" -> this stop; unknown -> null.
function destination(graph, raw, here) {
  if (!raw) return null;
  if (/^terminates here$/i.test(raw.trim())) return here;
  return graph.stopName(raw.replace(/\s+via\s+.*$/i, "")) ?? null;
}

// ---------- placing trams ----------

// history: stop -> dest -> lowest wait seen in the previous poll, to settle which way a tram came at
// a junction.
export function inferTrams(graph, rows, { now = Date.now(), times = new Map(), history = new Map() } = {}) {
  const trams = [];
  const seen = new Set();
  const boards = boardsByStop(graph, rows);
  for (const m of rows) {
    const stop = graph.stopName(m.StationLocation);
    if (!stop) continue;
    for (let i = 0; i < 4; i++) {
      const dest = destination(graph, m[`Dest${i}`], stop);
      const waitRaw = m[`Wait${i}`];
      if (!dest || waitRaw === "") continue;
      const status = m[`Status${i}`] ?? "";
      const atStop = /arrived|departing/i.test(status);
      const wait = atStop ? 0 : Number(waitRaw);
      const key = `${stop}|${dest}|${wait}|${m[`Carriages${i}`]}`;
      if (seen.has(key)) continue; // the same tram on another sign at this stop
      seen.add(key);
      // Boards keep showing "Departing" long after a tram has gone (all night, after the last one).
      // A tram really at this stop is also on the next stop's board, about one stretch away.
      if (atStop && !atStopConfirmed(graph, boards, times, stop, dest, status)) continue;

      const from = previousStop(graph, stop, dest, m.Direction, wait, times, history);
      if (!from) continue;
      const minutes = segmentMinutes(graph, times, from, stop);
      // Between `from` and `stop` only if it'll reach `stop` within one stretch's travel time.
      if (wait > Math.ceil(minutes)) continue;
      trams.push({
        from,
        to: stop,
        dest,
        minutes,
        arriveAt: now + wait * 60_000,
        status,
        double: m[`Carriages${i}`] === "Double",
      });
    }
  }
  return dedupe(graph, trams, now);
}

function atStopConfirmed(graph, boards, times, stop, dest, status) {
  if (dest === stop) return /arrived/i.test(status);
  const next = graph.nextHop(stop, dest);
  const waits = next && boards.get(next)?.get(dest);
  if (!waits) return false;
  const limit = Math.ceil(segmentMinutes(graph, times, stop, next)) + 1;
  return waits.some((w) => w >= 1 && w <= limit);
}

function previousStop(graph, stop, dest, direction, wait, times, history) {
  const next = graph.nextHop(stop, dest);
  let options = graph.neighbours.get(stop).map((n) => n.to).filter((n) => n !== next);
  // Must be a stop from which this destination is reached through `stop`, without doubling back.
  options = options.filter(
    (a) => (dest === stop || graph.nextHop(a, dest) === stop) && (!next || graph.canContinue(a, stop, next)),
  );
  if (options.length <= 1) return options[0] ?? null;

  // "Incoming" means heading into the city centre, so it came from further out (and vice versa).
  const here = graph.distance(stop, graph.centre);
  const byDirection = options.filter((a) =>
    /incoming/i.test(direction) ? graph.distance(a, graph.centre) > here : /outgoing/i.test(direction) ? graph.distance(a, graph.centre) < here : true,
  );
  if (byDirection.length === 1) return byDirection[0];
  if (byDirection.length) options = byDirection;

  // At a junction: which way fits what the boards said last time (the tram was about to reach `a`).
  let best = null;
  for (const a of options) {
    const prevWait = history.get(a)?.get(dest);
    if (prevWait === undefined) continue;
    const expected = wait - segmentMinutes(graph, times, a, stop);
    const err = Math.abs(prevWait - Math.max(0, expected));
    if (!best || err < best.err) best = { a, err };
  }
  if (best && best.err <= 2) return best.a;

  // Otherwise, the way that continues most straight through the stop.
  const out = next ? graph.segment(stop, next) : null;
  if (!out) return options[0];
  const dir = (path) => {
    const [a, b] = [path[0], path[Math.min(path.length - 1, 3)]];
    const l = dist(a, b) || 1;
    return [(b[0] - a[0]) / l, (b[1] - a[1]) / l];
  };
  const o = dir(out.path);
  return options
    .map((a) => {
      const d = dir(graph.segment(stop, a).path);
      return [a, d[0] * o[0] + d[1] * o[1]]; // most opposite to the way out = straight through
    })
    .sort((x, y) => x[1] - y[1])[0][0];
}

// The same tram can be read off two boards with slightly inconsistent minutes and land twice,
// close together. Keep one of any pair heading the same way within 150 m.
function dedupe(graph, trams, now) {
  const placed = trams.map((t) => ({ ...t, p: trackPoint(graph, t, now).p }));
  placed.sort((a, b) => a.arriveAt - b.arriveAt);
  const kept = [];
  for (const t of placed) {
    if (kept.some((k) => k.dest === t.dest && dist(k.p, t.p) < 150)) continue;
    kept.push(t);
  }
  return kept.map(({ p, ...t }) => t);
}

export function boardHistory(graph, rows) {
  const out = new Map();
  for (const [stop, byDest] of boardsByStop(graph, rows)) {
    const m = new Map();
    for (const [dest, waits] of byDest) m.set(dest, Math.min(...waits));
    out.set(stop, m);
  }
  return out;
}

// Where a tram is at time `t`: along the track from `from` to `to`, by how much of the stretch's
// travel time is left. Returns the point [x, y] (metres) and the heading in radians.
export function trackPoint(graph, tram, t) {
  const seg = graph.segment(tram.from, tram.to);
  if (!seg) return { p: [0, 0], angle: 0 };
  const left = Math.max(0, tram.arriveAt - t) / 60_000;
  const f = Math.max(0, Math.min(1, 1 - left / tram.minutes));
  let target = f * seg.len;
  const path = seg.path;
  for (let i = 0; i < path.length - 1; i++) {
    const d = dist(path[i], path[i + 1]);
    if (target <= d || i === path.length - 2) {
      const u = d ? Math.min(1, target / d) : 0;
      return {
        p: [path[i][0] + (path[i + 1][0] - path[i][0]) * u, path[i][1] + (path[i + 1][1] - path[i][1]) * u],
        angle: Math.atan2(path[i + 1][1] - path[i][1], path[i + 1][0] - path[i][0]),
      };
    }
    target -= d;
  }
  return { p: path[path.length - 1], angle: 0 };
}

// ---------- tracking trams between refreshes ----------

// Keeps each tram's identity across refreshes and eases it towards its estimated position, so maps
// can draw it gliding along the track. `p` is in metres (toXY), `angle` in radians (0 = east, CCW).
export function createTracker(graph) {
  let times = new Map();
  let history = new Map();
  let trams = [];
  let nextId = 1;
  let last = 0;
  return {
    graph,
    get trams() {
      return trams;
    },
    update(rows) {
      if (!rows?.length) return;
      // Waits are relative to when TfGM made the data, if that's recent.
      const stamp = Math.max(...rows.map((m) => Date.parse(m.LastUpdated) || 0));
      const now = Math.abs(Date.now() - stamp) < 120_000 ? stamp : Date.now();
      times = travelTimes(graph, rows, times);
      const found = inferTrams(graph, rows, { now, times, history });
      history = boardHistory(graph, rows);
      const old = new Set(trams);
      const next = [];
      for (const data of found) {
        const { p, angle } = trackPoint(graph, data, Date.now());
        let match = null;
        let bestD = 700;
        for (const t of old) {
          if (t.data.dest !== data.dest) continue;
          const d = dist(t.p, p);
          if (d < bestD) [match, bestD] = [t, d];
        }
        if (match) {
          old.delete(match);
          // Whole-minute waits can put a tram later than last time; on the same stretch, keep the
          // earlier estimate so it never slides backwards (a late tram waits at the stop instead).
          if (match.data.from === data.from && match.data.to === data.to)
            data.arriveAt = Math.min(data.arriveAt, match.data.arriveAt);
          match.data = data;
          next.push(match);
        } else next.push({ id: nextId++, data, p, angle });
      }
      trams = next;
    },
    // Move every tram a frame's worth towards where it should be now.
    step() {
      const ts = performance.now();
      const dt = Math.min(1000, ts - last);
      last = ts;
      const now = Date.now();
      for (const t of trams) {
        const { p, angle } = trackPoint(graph, t.data, now);
        const gap = dist(p, t.p);
        const k = gap > 800 ? 1 : Math.min(1, dt / 500); // ease towards new estimates; jump if far off
        t.p = [t.p[0] + (p[0] - t.p[0]) * k, t.p[1] + (p[1] - t.p[1]) * k];
        t.angle = angle;
      }
    },
  };
}

// SVG for one tram, about 13 px long (20 for a double), pointing along +x. Place it with
// tramTransform().
export function tramShape(data, colour) {
  const len = data.double ? 20 : 13;
  return `<rect x="${-len / 2}" y="-3.2" width="${len}" height="6.4" rx="3.2" style="--c:${colour}"/>
    <path d="M${len / 2 - 1} -2.4L${len / 2 + 4} 0L${len / 2 - 1} 2.4Z" style="--c:${colour}"/>`;
}

// Transform for a tram at screen point [x, y] (y down) heading `angle`, nudged `off` screen units to
// the left of its track (Metrolink runs on the left), so opposite directions don't overlap.
export function tramTransform([x, y], angle, scale, off) {
  const sx = x - Math.sin(angle) * off;
  const sy = y - Math.cos(angle) * off;
  return `translate(${sx.toFixed(1)} ${sy.toFixed(1)}) rotate(${((-angle * 180) / Math.PI).toFixed(1)}) scale(${scale})`;
}
