# Riffle

A single-file fly fishing app for the Northeast US: point at where you are
fishing — an address, a pin on the map, your own location — and it finds the
public access nearby, then reads the date, clock, season and conditions to tell
you what is likely hatching, what to tie on, and whether the water is worth
fishing at all.

## What it does

- **Reading panel** — modeled water temperature, flow band, wade safety and a
  plain-language "go / think / stay home" call for the selected water.
- **Plays** — ranked, confidence-scored tactics for right now, each with the
  flies, sizes, rig specs and how to fish it.
- **Shop list** — the flies and terminal tackle the plays actually call for,
  as a checkable list.
- **Hatch** — what is on and off across the season for that water.
- **Where** — search an address, drop a pin on the map, or use your location.
  Riffle lists the public access mapped nearby and reads the water from there.
  The 27 hand-written waters — Catskill and Delaware tailwaters, Pennsylvania
  limestoners, New England freestones, Lake Ontario / Lake Erie steelhead
  tributaries — are still one tap away.

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
