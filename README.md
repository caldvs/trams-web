# Trams (web)

Live Manchester Metrolink departures, stop by stop. Web version of the `trams` iOS app.

```sh
npm start        # live data, if TFGM_API_KEY is set or in .env; sample data otherwise
npm run demo     # always sample data
```

Then open http://localhost:8090. Needs Node 20.12 or newer; there are no dependencies.

## Setup

Put your TfGM key in `.env` (gitignored):

```
TFGM_API_KEY=...
```

A copy is stored as the `TFGM_KEY` Actions secret in `caldvs/metrolink-performance`. TfGM's developer portal has closed, so keep a copy safe.

| Variable       | Default     | |
|----------------|-------------|---|
| `TFGM_API_KEY` |             | TfGM subscription key. Without it the app shows `sample.json`. |
| `HOST`         | `127.0.0.1` | Set `0.0.0.0` to open it from your phone on the same Wi-Fi. "Nearest stops" won't work there, because browsers only share location over https or localhost. |
| `PORT`         | `8090`      | |
| `DEMO`         | unset       | `1` forces sample data. |

## How it works

- `server.mjs` serves `public/` and passes `/api/metrolinks` through to `https://api.tfgm.com/odata/Metrolinks`, so the key never reaches the browser. It reuses TfGM's answer for 15 seconds, and requests that arrive together share one call. If TfGM fails, it serves the last good answer for up to 5 minutes, marked as stale.
- `public/app.js` shows a searchable list of stops and a page for each stop. It refreshes every 30 seconds while the tab is visible. It also:
  - merges a platform's duplicate signs (TfGM's TPID, TPTS and TPTD signs often show the same trams)
  - strips the signs' control codes (`^F0`, `^J`) from notices, and hides the standing "Welcome to Metrolink" notice
  - warns when TfGM's own timestamp is over 3 minutes old
  - keeps saved stops in this browser (`localStorage`)
  - shows the 3 stops nearest to you, with a small map drawn as SVG (no third-party map tiles): roads, the track in Metrolink yellow, stops in their area's colour, you, and a scale bar. Tapping a stop opens it.
    - The map covers 1 km around you. If the nearest stop is further, it zooms out just enough to include it, using main roads only beyond 2.5 km.
    - More than 10 km from every stop, it shows the whole network instead: you and a dashed line to the nearest stop, or an arrow at the edge if you're over 60 km away. It also says which way the stop is, with a link to directions on Google Maps.
    - After you share your location once, the page finds you by itself on later visits (or straight away if the browser already allows it) and updates your position every 30 s while the tab is open.
- The server gzips text over 1 KB, so a live refresh is about 8 KB instead of 145 KB.

## Map data

Both are built by scripts in `scripts/`; see the comment at the top of each for the download command.

- `public/network.json` (16 KB): each stop's coordinates and simplified track, from TfGM's [GM Metrolink Network](https://www.data.gov.uk/dataset/55576216-cd1d-4e2b-adcf-c87c07473373/gm-metrolink-network) data (June 2026, the GeoJSON in `GM_Metrolink_MapData.zip`). Stops are matched to the live feed on `stationCode` = `TLAREF`, and by name for Deansgate - Castlefield (`GMX` in the feed). The track is simplified to within 4 m. Rebuild it with `scripts/build-network.mjs` when TfGM publishes a new network.
- `public/roads/`: OpenStreetMap roads within 2.5 km of a stop, simplified to within 3 m and cut into 132 squares about 2 km across (1.4 MB in total, 11 KB each on average), so a close-up map downloads only 2–6 of them. `roads/main.json` (220 KB, 80 KB gzipped) has just the motorways and A-roads, for wider views. Rebuild both with `scripts/build-roads.mjs`, after `network.json`.

## Licence

- Network data: Contains Transport for Greater Manchester data. Contains OS data © Crown copyright and database right 2017. Used under the [Open Government Licence v3.0](https://www.nationalarchives.gov.uk/doc/open-government-licence/version/3/).
- Road data: © OpenStreetMap contributors, under the [Open Database Licence](https://www.openstreetmap.org/copyright).
- TfGM's `Line` field is one value per stop (the area of the network), not the route of each tram, so it's shown once per stop.
