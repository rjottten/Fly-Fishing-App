# Riffle

A single-file fly fishing app for the Northeast US: point at where you are
fishing — an address, a pin on the map, your own location — and it finds the
public access nearby, then reads the date, clock, season and conditions to tell
you what is likely hatching, what to tie on, and whether the water is worth
fishing at all.

## What it does

- **Plan bar** — which water is being read, and which day. Fish today, or point
  it at a Saturday three weeks out and the whole app reads that date.
- **Plays** — the wade-or-float call for the day, then ranked,
  confidence-scored tactics, each with the flies, sizes, rig specs and how to
  fish it.
- **River conditions** — water temperature, flow band, clarity, light and
  barometric pressure for the selected water, under the map on **Where**.
- **Shop list** — the flies and terminal tackle the plays actually call for,
  as a checkable list.
- **Hatch** — what is on and off across the season for that water.
- **Where** — search an address, drop a pin on the map, or use your location.
  Riffle lists the public access mapped nearby and reads the water from there.
  The 27 hand-written waters — Catskill and Delaware tailwaters, Pennsylvania
  limestoners, New England freestones, Lake Ontario / Lake Erie steelhead
  tributaries — re-sort around wherever you last pointed, nearest first.
- **On river** — one-tap corrections for what you can see and the model cannot:
  flow, clarity, sky, the glass.
- **Diary** — what actually happened out there, and the only input to the plays
  that is not modeled. See below.

## The diary

Everything else in Riffle is modeled: seasonal curves, hatch calendars,
averages taken across a whole region. A day on the river is a measurement *of*
that river, and once there are a few of them the book knows things the model
never will — that the Hendricksons run a week late in this pool, that the fish
here only ever come to a swung wet, that high-and-green is the streamer day.

Log a day and it records how it went, what you fished, what came off the water,
the flies that caught, the river as it looked, and your notes. Days live in the
browser's own storage and are never sent anywhere.

What Riffle does with them:

- **Ranks the plays.** A logged day counts for the water it was logged on (or
  one within 12 miles), for the three weeks of calendar around it, more when
  the season is recent, and more again when today's river matches what you
  wrote down. From that it derives a multiplier per method, **bounded to ±15
  percent** — a handful of days is evidence, not proof. Play cards say which
  days moved them and by how much.
- **Weights the hatch.** A bug you have logged here at this time of year is
  weighted up on the hatch panel, and a sighting near this date will stretch a
  hatch window by up to twelve days — hatches run early or late and the book
  knows which way this water runs. It will never open one months out of season.
- **Fills in the days you cannot see.** Planning a Saturday two weeks out, the
  gauge has nothing to say; the diary does.

Export the book to JSON and import it back — browser storage is not a durable
place to keep several seasons of notes.

## Planning a day

The plan bar reads any day up to three weeks ahead. A gauge reading is not a
forecast, but the gap between the gauge and the model for today is closer to
one: a river running warm or high this afternoon is still likely to be running
warm or high tomorrow. So Riffle carries that anomaly forward and lets it
decay — quickly for flow, which a single storm resets, slowly for water
temperature, which has a season's mass behind it. A week out there is almost
nothing of the gauge left, and the reading is the seasonal curve plus whatever
the diary knows about that week on that water. The bar always says which it is.

Barometric pressure is never carried forward at all. It is weather, not season;
check a forecast the night before and tap it on **On river**.

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

It covers the access flow, the diary's whole round trip through the ranking,
how much of the gauge survives into a planned day, and — deliberately — the
four ways the access flow can degrade: Overpass down, no drainage area, no map
library, no tiles. See [test/README.md](test/README.md).

`.github/workflows/test.yml` runs the same suite on every pull request and on
every push to `main`, against the browser the runner image already carries —
nothing is downloaded.

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
