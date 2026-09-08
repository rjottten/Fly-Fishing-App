# Riffle

### [robsriffle.netlify.app](https://robsriffle.netlify.app)

A single-file fly fishing app for the Northeast US: point at where you are
fishing — an address, a pin on the map, your own location — and it finds the
public access nearby, then reads the date, clock, season and conditions to tell
you what is likely hatching, what to tie on, and whether the water is worth
fishing at all.

No account, no install, nothing to configure. Open the link and it is already
reading a river. It is one HTML file, so it works on the phone in your waders
as well as it does on a desktop.

## Start here

1. It opens on **Plan**, asking where you are fishing. Type a town, tap the
   map, or use your location. Riffle lists the public access mapped around
   that point and the waters nearest to it.
2. Go to **Fish**. Top of the tab is what the river is doing; under it, whether
   to wade or float; under that, three ranked plays with the flies, sizes and
   rig for each.
3. Before you drive, open **Shop** for the shops nearest that water and the
   list of everything the plays call for.
4. When you get back, open **Report** and write the day down. That is the one
   thing Riffle cannot model, and it is what makes the next reading better.

Fishing a Saturday three weeks out? Set the day under the tabs first and every
tab reads that date instead of today.

## What it does

Four tabs, and two strips that belong to all of them: the water being read sits
above the tabs, and the day you are fishing sits below them, because every
panel is read through it.

- **Plan** — search an address, drop a pin on the map, or use your location.
  The 27 hand-written waters — Catskill and Delaware tailwaters, Pennsylvania
  limestoners, New England freestones, Lake Ontario / Lake Erie steelhead
  tributaries — re-sort directly under the map, nearest to wherever you last
  pointed. Below them, the public access OpenStreetMap has mapped around that
  point, and this water's wading ladder.
- **Fish** — everything you read standing in the river, in the order you ask
  it. **River conditions** first: water temperature, flow band, clarity, light
  and barometric pressure, with the gauge it is reading and what this river is
  actually like. Then the wade-or-float call, then ranked, confidence-scored
  plays — each with the flies, sizes, rig specs and how to fish it — and last,
  what is hatching and what starts within four weeks.
- **Shop** — the fly shops mapped nearest the water, with a link to each, and
  then the flies and terminal tackle the plays actually call for, as a
  checkable list to hand across the counter.
- **Report** — what you can see that the model cannot (flow, clarity, sky, the
  glass, as one-tap corrections), and what the day came to. The second half is
  the diary, the only input to the plays that is not modeled. See below.

## Where it works

Riffle reads any point you drop in the Northeast — it borrows the seasonal
curves of the nearest of these 27 hand-written waters and rescales the flow
bands to the gauge it finds. So your home pool does not have to be on this list
for the app to read it; the list is what it reasons *from*.

**Outside the Northeast it says so.** Those curves and hatch windows travel
about 150 miles and no further, so past that Riffle tells you where you are,
reads your local USGS gauge — which is as good in Montana as it is in the
Catskills — and shows **no hatches at all** rather than a Catskill calendar
that would be wrong. The plays still come; read them as technique rather than
as a match-the-hatch. Continental coverage is the next thing being built.

<details>
<summary><b>The 27 waters in the book</b></summary>

**Tailwaters** — West Branch Delaware (Hale Eddy, NY) · East Branch Delaware
(Harvard, NY) · Main Stem Delaware (Lordville, NY) · Neversink River (Neversink
Gorge, NY) · Farmington River (Riverton / Church Pool, CT)

**Freestones** — Beaverkill (Cooks Falls, NY) · Willowemoc Creek (Livingston
Manor, NY) · Esopus Creek (Coldbrook, NY) · Housatonic River (Cornwall Bridge,
CT) · West Branch Ausable (Wilmington, NY) · Battenkill (Arlington, VT) · South
Branch Raritan (Ken Lockwood Gorge, NJ)

**Limestoners** — Spring Creek (Fisherman's Paradise, PA) · Penns Creek
(Coburn, PA) · Little Juniata (Spruce Creek, PA) · Yellow Breeches (Boiling
Springs, PA) · Letort Spring Run (Carlisle, PA) · Big Fishing Creek (The
Narrows, Lamar, PA) · Lackawanna River (Archbald, PA) · Musconetcong River
(Point Mountain, NJ)

**Great Lakes tributaries** — Salmon River (Altmar / Pineville, NY) · Oak
Orchard Creek (The Bridges, NY) · Cattaraugus Creek (Gowanda, NY) · Elk Creek
(Folly's End / Legion Hole, PA) · Walnut Creek (Manchester Hole, PA) · Conneaut
Creek (State Line, PA/OH) · Eighteenmile Creek (Burt Dam, NY)

</details>

## What it is not

- **It is not a gauge.** Where USGS has a live reading Riffle shows it and says
  so. Everywhere else the numbers are **modeled** from date, water type and
  season. Check the gauge and your own thermometer before you commit to a day.
- **It is not a statement of legal access.** The access list is features mapped
  in OpenStreetMap — a launch, a lot, a trailhead. Verify with the state agency
  or posted signs before you park.
- **It is not a substitute for your own judgement about wading.** The ladder is
  built from flow numbers, and flow numbers do not know about the ledge you
  cannot see.
- **Stop fishing trout above 68 °F.** Released fish die hours later even when
  they swim away strong. Riffle says so on the day and names colder water
  nearby, but it cannot make the call for you.

## The diary

Everything else in Riffle is modeled: seasonal curves, hatch calendars,
averages taken across a whole region. A day on the river is a measurement *of*
that river, and once there are a few of them the book knows things the model
never will — that the Hendricksons run a week late in this pool, that the fish
here only ever come to a swung wet, that high-and-green is the streamer day.

Log a day and it records how it went, what you fished, what came off the water,
the flies that caught, the river as it looked, and your notes. Days live in the
browser's own storage and are never sent anywhere — there is no account, no
backend of Riffle's own, and no analytics of any kind. The only things the page
ever talks to are the map, the gauges and the weather, and it only asks them
about the water, never about you.

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

The day strip under the tabs reads any day up to three weeks ahead. A gauge
reading is not a forecast, but the gap between the gauge and the model for
today is closer to one: a river running warm or high this afternoon is still
likely to be running warm or high tomorrow. So Riffle carries that anomaly
forward and lets it decay — quickly for flow, which a single storm resets,
slowly for water temperature, which has a season's mass behind it. A week out
there is almost nothing of the gauge left, and the reading is the seasonal
curve plus whatever the diary knows about that week on that water. The strip
always says which it is.

Barometric pressure is never carried forward at all. It is weather, not season;
check a forecast the night before and tap it on **Report**.

## Choosing where you fish

Point at a spot and Riffle assembles a reading for it:

1. **Find the spot** — [Nominatim](https://nominatim.openstreetmap.org) geocodes
   an address or town; a map tap or a drag of the pin works the same way.
2. **List the access** — the [Overpass API](https://overpass-api.de) is asked
   what OpenStreetMap has mapped within five miles, widening to twelve if that
   finds nothing: slipways, fishing access, piers, trailheads, and parking
   within 400 m of a waterway. Lots tagged `access=private` are dropped, and
   parking with no water near it never appears. **These are mapped features,
   not a statement of legal access** — verify with the state agency or posted
   signs before you park.
3. **Read the water** — the nearest USGS gauge supplies live flow and
   temperature. Seasonal temperature curves, hatch timing and flow character
   are borrowed from the nearest of the 27 curated waters, and the flow bands
   are rescaled by the ratio of the two gauges' drainage areas. When USGS has
   no drainage area for one of them, the bands travel unscaled and the dashboard
   says so rather than implying a precision it does not have.
4. **Find the counter** — the same Overpass API is asked, when you open
   **Shop**, for the tackle and outdoor shops mapped within 25 miles of that
   point, widening to 55 if none are. A shop's own website is linked where
   OpenStreetMap has one, and its place on the map where it does not. Those
   tags are world-writable, so only an `http(s)` URL is ever turned into a
   link.

Every step degrades instead of failing: no Overpass, and you can still read the
pin itself and the shop list is simply shopless; no gauge, and the numbers are
modeled; no map library or tiles, and the address search still drives
everything.

Live flow and water temperature come from the USGS Instantaneous Values service
(`waterservices.usgs.gov`) when a gauge reading is available; barometric
pressure comes from [Open-Meteo](https://open-meteo.com). Every panel says
which of its numbers were read and which were modeled, because the difference
is the whole point.

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

Two of the scenarios are about the deploy rather than the app. `security`
serves an OpenStreetMap node whose name has been edited into an attack and
proves it renders as text; `slowmap` proves the reading does not wait on the
map library. Both are things the source cannot tell you on its own.

### Editing index.html

The deploy's Content-Security-Policy allows the inline script by its hash, so
after changing `index.html` run `npm run seal` in `test/` and commit the
updated `netlify.toml`. `npm test` fails if you forget. See
[test/README.md](test/README.md#the-seal).

## Deploying to Netlify

Riffle is live at **[robsriffle.netlify.app](https://robsriffle.netlify.app)**,
deployed from `main` — a push to that branch is the deploy.

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

To stand up your own copy, point a Netlify site at a fork (or run
`netlify deploy --prod` from the root) and the config is applied automatically.
If you add an external script,
stylesheet or data source, widen the matching CSP directive in `netlify.toml` or
the browser will block it.
