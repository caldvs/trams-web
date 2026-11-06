// Builds public/roads/<latIndex>_<lonIndex>.json: OpenStreetMap roads within 2.5 km of a tram stop,
// simplified to 3 m and cut into squares of 0.02° lat x 0.032° lon (about 2 km), so the mini map
// only downloads the few squares it shows. Run after build-network.mjs.
//
//   curl --data-urlencode 'data=[out:json][timeout:240];way["highway"~"^(motorway|trunk|primary|secondary|tertiary|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link|residential|unclassified|pedestrian|living_street)$"](53.33,-2.40,53.65,-2.05);out tags geom;' \
//     https://overpass-api.de/api/interpreter -o roads-osm.json
//   node scripts/build-roads.mjs roads-osm.json
//
// Each road is [class, lon, lat, dLon, dLat, ...] in 1e-5 degrees (first point absolute, then deltas).
// Road data © OpenStreetMap contributors, ODbL.
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { distanceM, simplify } from "./geo.mjs";

const TILE_LAT = 0.02; // keep in step with public/app.js
const TILE_LON = 0.032;
const CLASS = {
  motorway: 0, motorway_link: 0,
  trunk: 1, trunk_link: 1,
  primary: 2, primary_link: 2,
  secondary: 3, secondary_link: 3,
  tertiary: 4, tertiary_link: 4,
  residential: 5, unclassified: 5, living_street: 5,
  pedestrian: 6,
};

const [input] = process.argv.slice(2);
if (!input) throw new Error("usage: node scripts/build-roads.mjs <overpass json>");
const osm = JSON.parse(readFileSync(input, "utf8"));
const stops = Object.values(JSON.parse(readFileSync(new URL("../public/network.json", import.meta.url), "utf8")).stops);
const nearStop = ({ lat, lon }) => stops.some((s) => distanceM(s, [lat, lon]) < 2500);

const tiles = new Map();
let roads = 0;
for (const way of osm.elements) {
  const cls = CLASS[way.tags?.highway];
  const g = way.geometry;
  if (cls === undefined || !g?.length) continue;
  if (![g[0], g[g.length >> 1], g[g.length - 1]].some(nearStop)) continue;
  const pts = simplify(g.map((p) => [p.lon, p.lat]), 3).map(([lon, lat]) => [Math.round(lon * 1e5), Math.round(lat * 1e5)]);
  const road = [cls, ...pts[0]];
  for (let i = 1; i < pts.length; i++) road.push(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  const keys = new Set(pts.map(([lon, lat]) => `${Math.floor(lat / 1e5 / TILE_LAT)}_${Math.floor(lon / 1e5 / TILE_LON)}`));
  for (const key of keys) (tiles.get(key) ?? tiles.set(key, []).get(key)).push(road);
  roads++;
}

const dir = new URL("../public/roads/", import.meta.url);
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });
let bytes = 0;
for (const [key, list] of tiles) {
  const json = JSON.stringify(list);
  bytes += json.length;
  writeFileSync(new URL(`${key}.json`, dir), json);
}
console.log(`${roads} roads in ${tiles.size} squares, ${Math.round(bytes / 1024)} KB`);

// main.json: motorways, trunk and primary roads only (no slip roads) across the whole area,
// simplified to 10 m. The map uses it when zoomed out past the squares' range.
const main = [];
for (const way of osm.elements) {
  const cls = CLASS[way.tags?.highway];
  if (cls === undefined || cls > 2 || way.tags.highway.endsWith("_link") || !way.geometry?.length) continue;
  const pts = simplify(way.geometry.map((p) => [p.lon, p.lat]), 10).map(([lon, lat]) => [Math.round(lon * 1e5), Math.round(lat * 1e5)]);
  const road = [cls, ...pts[0]];
  for (let i = 1; i < pts.length; i++) road.push(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  main.push(road);
}
const mainJson = JSON.stringify(main);
writeFileSync(new URL("main.json", dir), mainJson);
console.log(`main.json: ${main.length} main roads, ${Math.round(mainJson.length / 1024)} KB`);
