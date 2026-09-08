/* Riffle's test suite.
 *
 * Serves index.html behind the exact Content-Security-Policy from
 * netlify.toml, mocks the five upstream services, and drives the app
 * in a real browser. A CSP violation or a console error fails the run,
 * so the policy is tested as hard as the code is.
 *
 *   npm install && npm test          — all scenarios
 *   npm test -- happy notiles        — named scenarios only
 */
import { chromium } from "playwright-core";
import { createHash } from "node:crypto";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import http from "node:http";
import * as F from "./fixtures.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const PORT = 8811;

const LEAFLET = resolve(HERE, "node_modules/leaflet/dist/leaflet.js");
const INDEX   = resolve(ROOT, "index.html");
const TOML    = resolve(ROOT, "netlify.toml");

/* Chromium comes from the environment: CHROME_PATH, or a browser
   Playwright has already put on disk. We never download one. */
function chromePath(){
  if(process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const pool = process.env.PLAYWRIGHT_BROWSERS_PATH || "/opt/pw-browsers";
  if(existsSync(pool)){
    const dir = readdirSync(pool).filter(d=>/^chromium-\d+$/.test(d)).sort().pop();
    if(dir){
      for(const rel of ["chrome-linux/chrome", "chrome-mac/Chromium.app/Contents/MacOS/Chromium"]){
        const p = resolve(pool, dir, rel);
        if(existsSync(p)) return p;
      }
    }
  }
  for(const p of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]){
    if(existsSync(p)) return p;
  }
  throw new Error("No Chromium found. Set CHROME_PATH to a Chrome or Chromium binary.");
}

/* ---------- assertions ---------- */
let failures = 0, checks = 0;
function ok(cond, label, detail){
  checks++;
  if(cond){ console.log(`    ✓ ${label}`); return; }
  failures++;
  console.log(`    ✗ ${label}${detail!==undefined?`\n        got: ${JSON.stringify(detail)}`:""}`);
}
const eq = (a,b,label)=>ok(JSON.stringify(a)===JSON.stringify(b), label, a);

/* ---------- the harness ---------- */
const csp = readFileSync(TOML,"utf8").match(/Content-Security-Policy = "([^"]+)"/)[1];

const server = http.createServer((_req,res)=>{
  res.writeHead(200, {"Content-Type":"text/html; charset=utf-8", "Content-Security-Policy":csp});
  res.end(readFileSync(INDEX));
});

const json = (o)=>({status:200, contentType:"application/json", body:JSON.stringify(o)});
const rdbOf = (rows)=>({status:200, contentType:"text/plain", body:F.rdb(rows)});

async function mock(page, scenario){
  const leaflet = readFileSync(LEAFLET);
  await page.route("**://cdnjs.cloudflare.com/**", r =>
    scenario==="noleaflet" ? r.abort()
      : r.fulfill({status:200, contentType:"application/javascript", body:leaflet}));

  for(const pat of ["**://tile.openstreetmap.org/**", "**://*.tile.openstreetmap.org/**"]){
    await page.route(pat, r =>
      scenario==="notiles" ? r.abort()
        : r.fulfill({status:200, contentType:"image/png", body:F.PNG_1PX}));
  }
  await page.route("**://fonts.googleapis.com/**", r=>r.fulfill({status:200, contentType:"text/css", body:""}));
  await page.route("**://nominatim.openstreetmap.org/search**",  r=>r.fulfill(json(F.GEOCODE)));
  await page.route("**://nominatim.openstreetmap.org/reverse**", r=>r.fulfill(json(F.REVERSE)));
  await page.route("**://overpass**", r =>
    scenario==="overpassdown" ? r.fulfill({status:504, contentType:"text/plain", body:"gateway timeout"})
      : r.fulfill(json(F.OVERPASS)));
  await page.route("**://api.open-meteo.com/**", r=>r.fulfill(json(F.meteo())));
  await page.route("**://waterservices.usgs.gov/nwis/iv/**", r=>r.fulfill(json(F.IV)));

  await page.route("**://waterservices.usgs.gov/nwis/site/**", r => {
    const bbox = r.request().url().includes("bBox=");
    if(scenario==="scaled")  return r.fulfill(rdbOf(bbox ? [F.SITE_LITTLE] : [F.SITE_LITTLE, F.SITE_BEAVERKILL]));
    if(scenario==="noarea")  return r.fulfill(rdbOf([F.SITE_LITTLE_NOAREA]));
    return r.fulfill(rdbOf(bbox ? [F.SITE_BEAVERKILL, F.SITE_LITTLE] : [F.SITE_BEAVERKILL, F.SITE_WBD]));
  });
}

/* Walks the app the way a person does: open Where, search an address,
   read the access list, pick the top entry. Returns what it saw. */
async function walk(browser, scenario){
  const page = await browser.newPage();
  const errors = [], violations = [];
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  page.on("console", m => {
    const t = m.text();
    if(/Content Security Policy|Refused to/i.test(t)) violations.push(t);
    // a mocked 504 is the point of the overpassdown scenario, not a defect
    else if(m.type()==="error" && !/favicon|ERR_|504/.test(t)) errors.push("console: " + t);
  });
  await mock(page, scenario);

  const seen = {};
  await page.goto(`http://127.0.0.1:${PORT}/`, {waitUntil:"networkidle"});
  seen.leaflet = await page.evaluate(()=>typeof L!=="undefined");

  await page.click("#tab-where");
  seen.mapRendered = await page.waitForSelector(".leaflet-container",{timeout:5000}).then(()=>true,()=>false);
  seen.mapCard = (await page.$eval("#mapCard", n=>n.textContent)).replace(/\s+/g," ").trim();

  await page.fill("#findQ", "Roscoe NY");
  await page.click(".findbtn[type=submit]");
  await page.waitForSelector(".wbtn.apt", {timeout:12000});
  if(scenario==="notiles") await page.waitForTimeout(4000);

  seen.names = await page.$$eval(".wbtn.apt .wn", ns=>ns.map(n=>n.childNodes[0].textContent.trim()));
  seen.kinds = await page.$$eval(".wbtn.apt .akind", ns=>ns.map(n=>n.textContent.trim()));
  seen.markers = await page.evaluate(()=>document.querySelectorAll(".acc-i").length);
  seen.card = (await page.$eval("#accessCard", n=>n.textContent)).replace(/\s+/g," ").trim();
  seen.mapNote = await page.$eval("#mapNote", n=>n.textContent.trim()).catch(()=>"");

  await page.click(".wbtn.apt");
  await page.waitForFunction(()=>document.querySelector("#waterMeta")
    && document.querySelector("#waterMeta").textContent.includes("Seasonal curves"), {timeout:8000});

  seen.spot  = await page.$eval("#reading .rd-water h2", n=>n.textContent.trim());
  const meta = (await page.$eval("#waterMeta", n=>n.textContent)).replace(/\s+/g," ");
  seen.meta  = meta;
  seen.bands = (meta.match(/ideal ([\d]+)[–-]([\d]+) cfs · blown above (\d+)/)||[]).slice(1).map(Number);
  seen.uncalibrated = meta.includes("uncalibrated");
  seen.plays = await page.$$eval("#panel-plays .play", n=>n.length);
  seen.hatch = await page.$$eval("#panel-hatch .hrow", n=>n.length);
  seen.shop  = await page.$$eval("#panel-shop .sitem", n=>n.length);

  // a water from the book must clear the synthesized spot
  await page.click('#waterMeta .wbtn[data-w="penns"]');
  await page.waitForTimeout(400);
  seen.afterBook = await page.$eval("#reading .rd-water h2", n=>n.textContent.trim());
  seen.spotCleared = await page.evaluate(()=>state.spot===null);

  seen.tabOrder = await page.$$eval(".tab", ts=>ts.map(t=>t.textContent.trim()));
  await page.click("#tab-onriver");
  seen.onRiverChips = await page.$$eval("#panel-onriver .rchip", n=>n.length);
  seen.onRiverGroups = await page.$$eval("#panel-onriver .rlab", ns=>ns.map(n=>n.textContent.trim().split(" — ")[0]));
  seen.strayControls = await page.evaluate(()=>!!document.getElementById("controls"));

  if(scenario==="diary") await diaryPass(page, seen);

  seen.errors = errors; seen.violations = violations;
  await page.close();
  return seen;
}

/* The diary is the one thing the angler types rather than taps, and
   the only input that outlives the tab. So it is driven twice: once
   through the form, and once again after a reload. */
async function diaryPass(page, seen){
  const chip = (field, value) => `#panel-diary .dchip[data-f="${field}"][data-v="${value}"]`;

  await page.click("#tab-diary");
  await page.waitForSelector("#dSave");
  seen.diaryEmpty = await page.$eval("#panel-diary", n=>n.textContent.includes("Nothing logged yet"));

  // a day with nothing said about it is not a day the engine can use
  await page.click("#dSave");
  seen.needsOutcome = await page.$eval("#panel-diary .dsaved", n=>n.textContent.trim());

  await page.click(chip("outcome","hot"));
  await page.click(chip("methods","streamer"));
  await page.fill("#dFlies", "Olive sculpin, size 4");
  await page.fill("#dNotes", "Fish were hard on the far bank all afternoon.");
  await page.click("#dSave");
  await page.waitForSelector("#panel-diary .dentry");

  seen.entryText = (await page.$eval("#panel-diary .dentry", n=>n.textContent)).replace(/\s+/g," ").trim();
  seen.stored = await page.evaluate(()=>{
    const j = JSON.parse(localStorage.getItem("riffle.diary.v1")||"[]");
    return {n:j.length, outcome:j[0]&&j[0].outcome, methods:j[0]&&j[0].methods,
            flies:j[0]&&j[0].flies, water:j[0]&&j[0].water};
  });
  // the conditions stay prefilled from the reading; what you said about the day does not
  seen.formReset = await page.$$eval(
    "#panel-diary .dchip[aria-pressed=true]",
    ns=>ns.map(n=>n.dataset.f).filter(f=>!f.startsWith("cond.")).length);
  seen.formKeepsCond = await page.$$eval(
    "#panel-diary .dchip[aria-pressed=true][data-f^='cond.']", ns=>ns.length);

  // one hot streamer day is a nudge; a run of them is a lean, and it caps
  seen.oneDay = await page.evaluate(()=>{ const m=buildContext().mem.tech.streamer; return m?m.pct:null; });
  for(const back of [3, 7, 11]){
    const d = new Date(Date.now() - back*86400000);
    const iso = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    await page.fill("#dDate", iso);
    await page.click(chip("outcome","hot"));
    await page.click(chip("methods","streamer"));
    await page.click("#dSave");
    await page.waitForTimeout(60);
  }
  // ...and a blank on the dry fly reads the other way
  await page.click(chip("outcome","blank"));
  await page.click(chip("methods","dry"));
  await page.click("#dSave");
  await page.waitForTimeout(60);

  seen.pcts = await page.evaluate(()=>{
    const t = buildContext().mem.tech;
    return {streamer: t.streamer?t.streamer.pct:null, dry: t.dry?t.dry.pct:null};
  });
  seen.readout = (await page.$$eval("#panel-diary .mrow .mname", ns=>ns.map(n=>n.textContent.trim())));

  // the engine, with the book and without it
  seen.rank = await page.evaluate(()=>{
    const ctx = buildContext();
    const withBook = recommend(ctx).picked;
    const bare = recommend(Object.assign({}, ctx, {mem:{days:0, rows:[], tech:{}, hatch:{}}})).picked;
    const s = withBook.find(p=>p.key==="streamer"||p.key==="gl-streamer");
    const b = bare.find(p=>p.key==="streamer"||p.key==="gl-streamer");
    return {moved: !!(s&&b) && s.score>b.score*1.02,
            ranked: withBook.map(p=>p.key), bareRanked: bare.map(p=>p.key)};
  });
  seen.playsNote = await page.$$eval("#panel-plays .fromdiary", ns=>ns.map(n=>n.textContent.trim()));

  /* A hatch the calendar has finished with, that the angler says is
     still coming off. The window stretches; it never opens in a month
     the bug was never in. */
  seen.stretch = await page.evaluate(()=>{
    for(const iso of ["2026-05-20","2026-04-15","2026-06-10","2026-09-08","2026-07-01"]){
      const [y,m,dd]=iso.split("-").map(Number);
      state.when = new Date(y, m-1, dd, 14, 0);
      const ctx = buildContext();
      const pool = HATCHES.filter(hx => hx.waters==="all" ? ctx.w.sp==="trout" : hx.waters.includes(hatchKeyOf(ctx.w)));
      const cand = pool.map(hx=>{
        const sh = hx.waters==="all" ? ctx.w.shift : 0;
        const s=hx.win[0]+sh, e=hx.win[2]+sh;
        const off = (ctx.day<s||ctx.day>e) ? Math.min(Math.abs(ctx.day-s), Math.abs(ctx.day-e)) : -1;
        return {hx, off};
      }).filter(o=>o.off>0 && o.off<=6)[0];
      if(!cand) continue;

      const before = hatchIntensity(cand.hx, ctx);
      const far = HATCHES.find(hx => {
        const sh = hx.waters==="all" ? ctx.w.shift : 0;
        const s=hx.win[0]+sh, e=hx.win[2]+sh;
        return (ctx.day<s||ctx.day>e) && Math.min(Math.abs(ctx.day-s), Math.abs(ctx.day-e))>40
            && (hx.waters==="all" ? ctx.w.sp==="trout" : hx.waters.includes(hatchKeyOf(ctx.w)));
      });
      const w = ctx.w;
      state.diary.unshift(normEntry({date:iso, waterId:w.id, hatchKey:hatchKeyOf(w), water:w.name,
        lat:w.lat, lon:w.lon, outcome:"steady", methods:["dry"],
        hatches:[cand.hx.id].concat(far?[far.id]:[])}));
      const after = buildContext();
      return {date:iso, bug:cand.hx.name, off:cand.off, before,
              after: hatchIntensity(cand.hx, after),
              farBug: far?far.name:null,
              farAfter: far?hatchIntensity(far, after):null,
              listed: activeHatches(after).some(o=>o.hx.id===cand.hx.id)};
    }
    return null;
  });

  // and it all survives the tab being closed
  await page.reload({waitUntil:"networkidle"});
  await page.click("#tab-diary");
  await page.waitForSelector("#panel-diary .dentry");
  seen.afterReload = await page.$$eval("#panel-diary .dentry", ns=>ns.length);
  // and they speak only for the water they were logged on
  seen.reloadPct = await page.evaluate(()=>{
    const here = buildContext().mem.tech.streamer;
    state.waterId="penns"; state.spot=null;
    const there = buildContext().mem.tech.streamer;
    return {elsewhere: here?here.pct:null, penns: there?there.pct:null};
  });

  // a day on another water, at another time of year, must not speak for this one
  seen.outOfRange = await page.evaluate(()=>{
    state.diary = [normEntry({date:"2025-01-04", waterId:"penns", hatchKey:"penns", water:"Penns Creek",
                              lat:40.85, lon:-77.35, outcome:"hot", methods:["streamer"]})];
    state.when = new Date();
    return buildContext().mem.days;
  });
}

/* ---------- what each scenario must prove ---------- */
const SCENARIOS = {
  happy: (s)=>{
    ok(s.leaflet, "Leaflet loads from the CDN");
    ok(s.mapRendered, "the map renders");
    eq(s.names, ["Cooks Falls Access","Riverside Trail","Beaverkill Lot","Read the pin itself"],
       "access is listed best-first, private lot and waterless lot excluded");
    eq(s.kinds, ["Boat launch","Trailhead","Parking","Pin"], "each entry is labelled by kind");
    ok(s.markers===3, "every access point is on the map", s.markers);
    ok(s.card.includes("Check before you park"), "the list carries the verify-access note");
    ok(s.spot==="Cooks Falls Access", "picking an access point re-reads the water there", s.spot);
    ok(s.meta.includes("Beaverkill"), "the panel names the water it borrowed from");
    ok(s.meta.includes("01420500"), "the panel names the gauge it read");
    ok(!s.uncalibrated, "bands from the water's own gauge are not flagged uncalibrated");
    ok(s.plays>0 && s.hatch>0 && s.shop>0, "plays, hatch and shop list all render for a spot",
       {plays:s.plays, hatch:s.hatch, shop:s.shop});
    eq(s.tabOrder, ["Where","Plays","Shop list","Hatch","On river","Diary"],
       "Where leads the tabs and the Diary closes them");
    ok(s.onRiverChips>0, "the condition chips live on the On river tab", s.onRiverChips);
    eq(s.onRiverGroups, ["Barometer","Flow","Clarity","Sky"], "all four condition groups moved with it");
    ok(!s.strayControls, "nothing is left under the dashboard");
  },
  scaled: (s)=>{
    // Little Beaver Kill drains 23.4 mi² against the Beaverkill's 241
    eq(s.bands, [15,49,146], "flow bands rescale by the drainage-area ratio");
    ok(!s.uncalibrated, "a scaled band is not flagged uncalibrated");
    ok(s.meta.includes("drainage area"), "the panel says the bands were scaled");
  },
  noarea: (s)=>{
    eq(s.bands, [150,500,1500], "with no drainage area the template's bands are used as-is");
    ok(s.uncalibrated, "and are flagged uncalibrated");
  },
  overpassdown: (s)=>{
    ok(s.card.includes("did not answer"), "an Overpass failure is stated plainly");
    eq(s.names, ["Read the pin itself"], "the pin is still readable without an access list");
    ok(s.plays>0, "and the reading still builds", s.plays);
  },
  noleaflet: (s)=>{
    ok(!s.leaflet && !s.mapRendered, "no map when the library is blocked");
    ok(s.mapCard.includes("did not load"), "the map card says so");
    ok(s.names.length>1 && s.plays>0, "address search still drives the whole app");
  },
  diary: (s)=>{
    ok(s.diaryEmpty, "an empty book says so rather than showing a blank panel");
    ok(/how the day went/i.test(s.needsOutcome), "a day with no outcome is refused", s.needsOutcome);
    ok(s.stored.n===1 && s.stored.outcome==="hot", "the day is written to storage", s.stored);
    eq(s.stored.methods, ["streamer"], "with the method that caught");
    ok(s.stored.flies==="Olive sculpin, size 4", "and the flies that caught", s.stored.flies);
    ok(s.stored.water==="Penns Creek", "logged against the water on screen", s.stored.water);
    ok(/Olive sculpin/.test(s.entryText) && /Hot/.test(s.entryText), "and reads back as a day", s.entryText);
    ok(s.formReset===0, "the form clears what you said for the next day", s.formReset);
    ok(s.formKeepsCond===3, "but keeps the conditions prefilled from the reading", s.formKeepsCond);
    ok(s.oneDay>0 && s.oneDay<=15, "one hot day nudges the streamer, no more than 15%", s.oneDay);
    ok(s.pcts.streamer===15, "four of them lean on it as hard as the cap allows", s.pcts);
    ok(s.pcts.dry<0, "and a blank on the dry fly reads the other way", s.pcts);
    ok(s.readout.some(r=>/Streamer/.test(r)), "the readout names what it is moving", s.readout);
    ok(s.rank.moved, "the streamer play scores higher with the book than without it", s.rank);
    ok(s.playsNote.length>0 && /your book|day/i.test(s.playsNote.join(" ")),
       "and the play card says which days moved it", s.playsNote);
    ok(s.stretch, "a hatch just outside its window was found to test the stretch on");
    ok(s.stretch && s.stretch.before===0, "the calendar alone gives it nothing", s.stretch);
    ok(s.stretch && s.stretch.after>0 && s.stretch.listed,
       "a logged sighting stretches the window and puts it back on the panel", s.stretch);
    ok(s.stretch && s.stretch.farAfter===0,
       "but a bug months out of season stays off it", s.stretch);
    ok(s.afterReload===5, "every day survives the tab being closed", s.afterReload);
    ok(s.reloadPct.penns>=12, "and still lean the plays hard on the next visit", s.reloadPct);
    ok(s.reloadPct.elsewhere===null, "on the water they were logged on, and no other", s.reloadPct);
    ok(s.outOfRange===0, "a day on another water in another season speaks for neither", s.outOfRange);
  },
  notiles: (s)=>{
    ok(s.mapRendered, "the map still initialises without tiles");
    ok(s.mapNote.includes("blocked"), "blank tiles are explained", s.mapNote);
    ok(s.plays>0, "and everything else still works");
  },
};

/* ---------- run ---------- */
console.log("\n  subresource integrity");
{
  const want = readFileSync(INDEX,"utf8").match(/integrity="(sha512-[^"]+)"/)[1];
  const got  = "sha512-" + createHash("sha512").update(readFileSync(LEAFLET)).digest("base64");
  ok(want===got, `the pinned Leaflet hash matches leaflet ${JSON.parse(readFileSync(resolve(HERE,"node_modules/leaflet/package.json"),"utf8")).version}`,
     {want, got});
}

const picked = process.argv.slice(2).filter(a=>SCENARIOS[a]);
const names = picked.length ? picked : Object.keys(SCENARIOS);

await new Promise(r=>server.listen(PORT,r));
const browser = await chromium.launch({executablePath:chromePath(), args:["--no-sandbox"]});
try{
  for(const name of names){
    console.log(`\n  ${name}`);
    const seen = await walk(browser, name);
    SCENARIOS[name](seen);
    ok(seen.violations.length===0, "no Content-Security-Policy violations", seen.violations);
    ok(seen.errors.length===0, "no console or page errors", seen.errors);
    ok(seen.spotCleared && seen.afterBook==="Penns Creek",
       "choosing a water from the book clears the spot", seen.afterBook);
  }
} finally {
  await browser.close();
  server.close();
}

console.log(`\n  ${checks-failures}/${checks} checks passed\n`);
process.exit(failures ? 1 : 0);
