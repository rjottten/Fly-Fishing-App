# Riffle

A single-file fly fishing app for the Northeast US: pick a water, and it reads
the date, clock, season and conditions to tell you what is likely hatching,
what to tie on, and whether the water is worth fishing at all.

## What it does

- **Reading panel** — modeled water temperature, flow band, wade safety and a
  plain-language "go / think / stay home" call for the selected water.
- **Plays** — ranked, confidence-scored tactics for right now, each with the
  flies, sizes, rig specs and how to fish it.
- **Shop list** — the flies and terminal tackle the plays actually call for,
  as a checkable list.
- **Hatch** — what is on and off across the season for that water.
- **Water** — 27 waters covering Catskill and Delaware tailwaters, Pennsylvania
  limestoners, New England freestones and the Lake Ontario / Lake Erie
  steelhead tributaries.

Live flow and water temperature come from the USGS Instantaneous Values service
(`waterservices.usgs.gov`) when a gauge reading is available. When it is not,
the numbers shown are **modeled** from date, water type and season — check the
gauge and your own thermometer before you commit to a day. Stop fishing trout
above 68 °F.

## Running it

`index.html` is self-contained — no build step, no dependencies to install.
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
  uses: its own inline styles and script, Google Fonts, and the USGS gauge API.

Point a Netlify site at this repository (or run `netlify deploy --prod` from the
root) and the config is applied automatically. If you add an external script,
stylesheet or data source, widen the matching CSP directive in `netlify.toml` or
the browser will block it.
