# Riffle's tests

`index.html` has no dependencies. These tests do — a browser to run the app
in, and a copy of Leaflet to serve in place of the CDN.

```
cd test
npm install
npm test              # every scenario
npm test -- happy     # one of them
```

Chromium is found in this order: `$CHROME_PATH`, then a browser already on
disk under `$PLAYWRIGHT_BROWSERS_PATH` (or `/opt/pw-browsers`), then the usual
system paths. Nothing is downloaded. If none is found the run says so.

## What it does

`run.mjs` serves `index.html` behind the exact headers the deploy sets on
`/*` — read out of `netlify.toml`, CSP and permissions policy alike — and
mocks the five services the app talks to — Nominatim,
Overpass, USGS, Open-Meteo, and the tile server — then drives the app the way
a person does: open **Where**, search an address, read the access list, pick
the top entry, then walk over to **On river** and file a report on the day.

The report is the second half of the walk, and it is checked end to end: the
entry lands in storage and in the log for that location, the thermometer
reading it carries becomes the water temperature on **Fish**, the tally of
what anglers said was right or wrong shows up there too, and the play that
worked is marked and moved in the ranking. Pooling is checked as well — a log
from somebody else merges once and is skipped the second time.

A CSP violation or a console error fails the run, so the deploy policy is
tested as hard as the code. The `deploy headers` section goes further and
proves a browser feature the app depends on still works behind the real
policy: it grants geolocation, loads the page, and calls
`getCurrentPosition`. That check exists because `geolocation=()` in the
permissions policy had quietly killed "Use my location" on the deploy while it
kept working locally — the header is only wrong once it is served.

The suite also checks the subresource-integrity hash pinned in `index.html`
against the Leaflet in `node_modules`, which is how a version bump that
forgets the hash gets caught.

## The scenarios

| name | proves |
| --- | --- |
| `happy` | access is ranked and labelled, the private lot and the lot with no water near it are excluded, and picking a point re-reads the whole app there |
| `scaled` | flow bands rescale by the ratio of the two gauges' drainage areas (23.4 mi² against 241 turns 150–500 cfs into 15–49) |
| `noarea` | with no drainage area the bands travel unscaled and are flagged uncalibrated |
| `overpassdown` | an Overpass outage is stated plainly and the pin is still readable |
| `noleaflet` | with the map library blocked, address search still drives everything |
| `notiles` | blank tiles are explained rather than left as a grey box |

The last four are the ones worth keeping. Every step of the Where flow depends
on a service that will eventually be down, and the app is supposed to degrade
rather than fail — that is only true for as long as something checks it.

## Fixtures

`fixtures.mjs` holds the canned responses, shaped like the real services —
including the RDB format line (`5s`, `16d`, `8n`) that USGS puts between the
header and the data, which is exactly the kind of thing a hand-rolled parser
gets wrong.
