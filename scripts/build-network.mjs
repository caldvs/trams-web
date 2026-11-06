// Builds public/network.json (stop positions + simplified track) from TfGM's GM Metrolink Network data.
//
//   curl -LO https://odata.tfgm.com/opendata/downloads/MetrolinkMapData/GM_Metrolink_MapData.zip
//   unzip GM_Metrolink_MapData.zip -d tfgm
//   node scripts/build-network.mjs tfgm/JSON-format http://localhost:8090/api/metrolinks
//
// The live feed (second argument, from the running server) gives the stop names the app uses.
import { readFileSync, writeFileSync } from "node:fs";
import { simplify } from "./geo.mjs";

const [dir, feedUrl = "http://localhost:8090/api/metrolinks"] = process.argv.slice(2);
if (!dir) throw new Error("usage: node scripts/build-network.mjs <JSON-format dir> [feed url]");

const lines = JSON.parse(readFileSync(`${dir}/Metrolink_Lines_Functional.json`, "utf8"));
const stopsGeo = JSON.parse(readFileSync(`${dir}/Metrolink_Stops_Functional.json`, "utf8"));
const { value: feed } = await (await fetch(feedUrl)).json();

const norm = (s) => s.toLowerCase().replace(/[’`]/g, "'").replace(/[^a-z0-9]+/g, " ").trim();
const byCode = new Map(stopsGeo.features.map((f) => [f.properties.stationCode, f]));
const byName = new Map(stopsGeo.features.map((f) => [norm(f.properties.name), f]));
const r5 = (x) => Math.round(x * 1e5) / 1e5;

// Feed TLAREF = TfGM stationCode, except a few (Deansgate - Castlefield is GMX in the feed): fall back to the name.
const stops = {};
for (const [name, code] of [...new Map(feed.map((m) => [m.StationLocation, m.TLAREF]))].sort()) {
  const f = byCode.get(code) ?? byName.get(norm(name));
  if (!f) throw new Error(`No TfGM stop for ${name} (${code})`);
  const [lon, lat] = f.geometry.coordinates;
  stops[name] = [r5(lat), r5(lon)];
}

const tracks = [];
for (const f of lines.features) {
  const parts = f.geometry.type === "LineString" ? [f.geometry.coordinates] : f.geometry.coordinates;
  for (const part of parts) tracks.push(simplify(part, 4).map(([lon, lat]) => [r5(lon), r5(lat)]));
}

const out = {
  source: "Transport for Greater Manchester, GM Metrolink Network, OGL v3. Contains OS data © Crown copyright and database right 2017.",
  stops,
  tracks,
};
writeFileSync(new URL("../public/network.json", import.meta.url), JSON.stringify(out));
console.log(`${Object.keys(stops).length} stops, ${tracks.length} track sections, ${tracks.flat().length} points`);
