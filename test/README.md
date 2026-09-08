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

CI runs this same suite on every pull request — see
`.github/workflows/test.yml`, which resolves the runner image's own Chrome into
`$CHROME_PATH` before handing over.

## What it does

`run.mjs` serves `index.html` behind the exact `Content-Security-Policy` from
`netlify.toml` and mocks the five services the app talks to — Nominatim,
Overpass, USGS, Open-Meteo, and the tile server — then drives the app the way
a person does: open **Plan**, search an address, read the access list, pick
the top entry, then open **Shop** and read the counters near it. Overpass is
asked two different questions, so the mock answers by what the query asks
for.

A CSP violation or a console error fails the run, so the deploy policy is
tested as hard as the code. The suite also checks the subresource-integrity
hash pinned in `index.html` against the Leaflet in `node_modules`, which is
how a version bump that forgets the hash gets caught.

## The scenarios

| name | proves |
| --- | --- |
| `happy` | access is ranked and labelled, the private lot and the lot with no water near it are excluded, picking a point re-reads the whole app there, the four tabs carry what they should in the order they should, and the fly shops link out without ever building a link from a `javascript:` tag |
| `scaled` | flow bands rescale by the ratio of the two gauges' drainage areas (23.4 mi² against 241 turns 150–500 cfs into 15–49) |
| `noarea` | with no drainage area the bands travel unscaled and are flagged uncalibrated |
| `overpassdown` | an Overpass outage is stated plainly and the pin is still readable |
| `noleaflet` | with the map library blocked, address search still drives everything |
| `notiles` | blank tiles are explained rather than left as a grey box |
| `slowmap` | the reading renders before the map library arrives, and the map still comes up once it does |
| `security` | an OpenStreetMap name tag full of markup renders as text everywhere, and the policy blocks an inline handler even from a sink nobody has found yet |
| `diary` | a day logged through the form is stored, re-ranks the plays up to the ±15% cap, stretches a hatch window it should and leaves one it should not, survives a reload, and speaks for no other water or time of year |
| `plan` | a planned day carries today's gauge forward and lets it decay — flow lets go before water temperature, a fortnight out both are the bare seasonal model, and pressure is never carried at all |

`diary` and `plan` are the two that test arithmetic rather than plumbing: both
feed the ranking, and both are bounded on purpose, so a regression in either
would show up as plays that quietly stop moving — or start moving too much —
rather than as anything that looks broken.

Of the rest, the last four are the ones worth keeping. Every step of the Plan flow depends
on a service that will eventually be down, and the app is supposed to degrade
rather than fail — that is only true for as long as something checks it.

## The seal

`index.html` carries its script inline, so the deploy has two ways to allow
it: `'unsafe-inline'`, which allows every *other* inline script too — including
one injected through the world-writable OpenStreetMap data the app reads — or
the SHA-256 of that exact script and nothing else. It is the second.

The cost is that the hash has to follow the file:

```
npm run seal          # rewrite the hash in netlify.toml after editing index.html
npm run seal -- -c    # check only
```

`npm test` checks it too, so a forgotten reseal fails CI rather than serving a
blank page. `style-src` keeps `'unsafe-inline'` because the page styles
elements by attribute, which no hash covers.

## Fixtures

`fixtures.mjs` holds the canned responses, shaped like the real services —
including the RDB format line (`5s`, `16d`, `8n`) that USGS puts between the
header and the data, which is exactly the kind of thing a hand-rolled parser
gets wrong. The shop fixture carries a `website` tag edited into a
`javascript:` URL, because that tag is world-writable and the app puts it in
an `href`.
