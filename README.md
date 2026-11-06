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
  - can show the 3 stops nearest to you
- `public/stops.json` maps each stop to coordinates, from DfT's NaPTAN data (Metrolink is area code 940), matched on the feed's `AtcoCode`. Rebuild it if stops are added.
- TfGM's `Line` field is one value per stop (the area of the network), not the route of each tram, so it's shown once per stop.
