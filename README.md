# Riffle

A single-file fly fishing app for the Northeast US: point at where you are
fishing — an address, a pin on the map, your own location — and it finds the
public access nearby, then reads the date, clock, season and conditions to tell
you what is likely hatching, what to tie on, and whether the water is worth
fishing at all.

## What it does

- **Fish** — the dashboard, and the tab you land on: modeled water
  temperature, flow band, wade safety, barometer and a plain-language
  "go / think / stay home" call for the selected water. It appears here and
  nowhere else.
- **Where** — search an address, drop a pin on the map, or use your location.
  Riffle lists the public access mapped nearby and reads the water from there.
  The 27 hand-written waters — Catskill and Delaware tailwaters, Pennsylvania
  limestoners, New England freestones, Lake Ontario / Lake Erie steelhead
  tributaries — are still one tap away.
- **Plays** — ranked, confidence-scored tactics for right now, each with the
  flies, sizes, rig specs and how to fish it.
- **Shop list** — the flies and terminal tackle the plays actually call for,
  as a checkable list.
- **Hatch** — what is on and off across the season for that water.
- **On river** — the conditions you can see and the log you keep: confirm
  whether the Fish tab told the truth, then file how the day actually went.

## The river log

Everything on **Fish** is a model with a gauge bolted to it, and the gauge is
usually miles downstream. The **On river** tab is where that gets corrected,
and where a location slowly accumulates a record worth reading before you
drive out.

- **Confirm the read** — mark each number on Fish *matched* or *off*: water
  temperature, flow, clarity, barometer, the wade call. Fish shows the running
  tally, and names whichever number anglers most often say is wrong.
- **Your thermometer** — a reading filed here becomes the water temperature on
  Fish for the next six hours, ahead of both the gauge and the seasonal curve.
- **How you fished it** — which play you ran, the fly that did it, hours, fish
  moved and landed, and how the day rated.
- **What you learned**, and **who else was out** — what the others were doing
  and whether it worked.

Reports are kept per location — a water from the book by its own name, a
picked spot rounded to about 110 m, so two anglers at the same pool file into
the same log. Reports from that spot at that time of year re-rank the plays:
gently, shrunk toward neutral until several agree, and never by more than a
tenth either way, so one bad afternoon can't bury a play the model likes.
Each play card says when the log moved it.

Riffle has no server. The log lives in your browser and is sent nowhere, so
pooling one is manual and deliberate: copy your entries, hand them to whoever
you fish with, paste theirs back in. Entries already on file are skipped, so
the same log can be merged twice with no harm.

## Choosing where you fish

Point at a spot and Riffle assembles a reading for it:

1. **Find the spot** — [Nominatim](https://nominatim.openstreetmap.org) geocodes
   an address or town; a map tap or a drag of the pin works the same way.
2. **List the access** — the [Overpass API](https://overpass-api.de) is asked
   what OpenStreetMap has mapped within five miles: slipways, fishing access,
   piers, trailheads, and parking within 400 m of a waterway. Lots tagged
   `access=private` are dropped, and parking with no water near it never
   appears. **These are mapped features, not a statement of legal access** —
   verify with the state agency or posted signs before you park.
3. **Read the water** — the nearest USGS gauge supplies live flow and
   temperature. Seasonal temperature curves, hatch timing and flow character
   are borrowed from the nearest of the 27 curated waters, and the flow bands
   are rescaled by the ratio of the two gauges' drainage areas. When USGS has
   no drainage area for one of them, the bands travel unscaled and the panel
   says so rather than implying a precision it does not have.

Every step degrades instead of failing: no Overpass, and you can still read the
pin itself; no gauge, and the numbers are modeled; no map library or tiles, and
the address search still drives everything.

Live flow and water temperature come from the USGS Instantaneous Values service
(`waterservices.usgs.gov`) when a gauge reading is available. When it is not,
the numbers shown are **modeled** from date, water type and season — check the
gauge and your own thermometer before you commit to a day. Stop fishing trout
above 68 °F.

## Running it

`index.html` is self-contained — no build step, no dependencies to install.
[Leaflet](https://leafletjs.com) 1.9.4 loads from cdnjs with a subresource
integrity hash; its stylesheet is inlined so the map stays styled in embeds
that block third-party CSS.
Open it in a browser, or serve the directory:

```
python3 -m http.server 8000
```

then visit http://localhost:8000/.

Fonts load from Google Fonts and gauge data from USGS, so a network connection
gets you the intended typography and live readings; offline it still runs on
the modeled values with fallback fonts.

## Tests

`test/` drives the app in a real browser behind the deploy's own
Content-Security-Policy, with the upstream services mocked:

```
cd test && npm install && npm test
```

It covers the access flow, the river log end to end — filing a report, the
thermometer reading reaching Fish, the play it moves, pooling somebody else's
log — and, deliberately, the four ways the access flow can degrade: Overpass
down, no drainage area, no map library, no tiles. See
[test/README.md](test/README.md).

## Deploying to Netlify

`netlify.toml` in the repo root holds the whole deploy configuration — there is
no build step, so Netlify publishes the repository root as-is:

- **Publish directory** `.` with no build command.
- **Redirects** — every path rewrites to `/index.html` (status 200), so a
  bookmarked or mistyped URL still lands on the app instead of a 404.
- **Caching** — `index.html` is served `must-revalidate` so a new deploy is
  picked up on the next load rather than from a stale cache.
- **Headers** — `nosniff`, a strict referrer policy, a locked-down permissions
  policy, and a Content-Security-Policy that allows only what the page actually
  uses: its own inline styles and script, Leaflet from cdnjs, Google Fonts,
  OpenStreetMap tiles, and the USGS, Open-Meteo, Nominatim and Overpass APIs.

Point a Netlify site at this repository (or run `netlify deploy --prod` from the
root) and the config is applied automatically. If you add an external script,
stylesheet or data source, widen the matching CSP directive in `netlify.toml` or
the browser will block it.
