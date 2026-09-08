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

/* ---------- the harness ----------
   Every header the deploy sets on "/*" is served here too, not just the
   CSP. A header that quietly turns off a browser feature the app uses
   looks fine locally and is broken in production, which is exactly the
   kind of thing only the real policy catches.                          */
function deployHeaders(){
  const toml = readFileSync(TOML,"utf8");
  const block = toml.split(/\[\[headers\]\]/).find(b=>/for\s*=\s*"\/\*"/.test(b));
  if(!block) throw new Error('netlify.toml has no [[headers]] block for "/*"');
  const out = {};
  for(const line of block.split("\n")){
    const m = line.match(/^\s{4}([A-Za-z-]+)\s*=\s*"(.*)"\s*$/);
    if(m) out[m[1]] = m[2];
  }
  return out;
}
const headers = deployHeaders();
const csp = headers["Content-Security-Policy"];

const server = http.createServer((_req,res)=>{
  res.writeHead(200, Object.assign({"Content-Type":"text/html; charset=utf-8"}, headers));
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
  // captured before any tab is touched: what a cold open shows
  seen.defaultTab = await page.evaluate(()=>{
    const t=document.querySelector('.tab[aria-selected="true"]');
    const shown=[...document.querySelectorAll(".panel")].filter(p=>!p.hidden).map(p=>p.id);
    return {tab:t&&t.id, shown};
  });

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
  seen.readingInFish = await page.evaluate(()=>!!document.querySelector("#panel-fish > #reading"));
  seen.readingOnce = await page.evaluate(()=>document.querySelectorAll(".reading").length);

  await page.click("#tab-onriver");
  seen.onRiverChips = await page.$$eval("#refineHost .rchip", n=>n.length);
  seen.onRiverGroups = await page.$$eval("#refineHost .rlab", ns=>ns.map(n=>n.textContent.trim().split(" — ")[0]));
  seen.strayControls = await page.evaluate(()=>!!document.getElementById("controls"));

  /* --- the log: file a report, then prove it reaches Fish and the plays --- */
  seen.logEmpty = await page.$eval("#logHost", n=>n.textContent.replace(/\s+/g," ").trim());
  seen.checkRows = await page.$$eval("#checkHost .ckrow .ckname", ns=>ns.map(n=>n.textContent.trim()));

  const shownTemp = await page.$eval("#reading .g .val", n=>parseInt(n.textContent,10));
  const filedTemp = shownTemp + 3;
  await page.fill("#logWho", "Tester");
  await page.fill("#logTemp", String(filedTemp));
  await page.click('#checkHost .rchip[data-k="flow"][data-v="off"]');
  await page.click('#checkHost .rchip[data-k="clarity"][data-v="ok"]');
  await page.click("#playHost .rchip");
  await page.click('#ratingRow .rchip[data-v="5"]');
  await page.fill("#logFly", "Frenchie #14");
  await page.fill("#logHours", "3");
  await page.fill("#logLanded", "4");
  await page.fill("#logLearn", "They held on the inside seam all afternoon.");
  await page.click('#crowdRow .rchip[data-v="few"]');
  await page.fill("#logOthers", "Two swinging wets, one fish between them.");
  await page.click("#logSave");
  await page.waitForSelector("#logHost .lentry", {timeout:5000});

  seen.logEntry  = await page.$eval("#logHost .lentry", n=>n.textContent.replace(/\s+/g," ").trim());
  seen.logWorks  = await page.$eval("#logHost .lworks", n=>n.textContent.replace(/\s+/g," ").trim());
  seen.logStored = await page.evaluate(()=>JSON.parse(localStorage.getItem("riffle.log.v1")||"[]").length);
  seen.formCleared = await page.$eval("#logLearn", n=>n.value);

  await page.click("#tab-fish");
  seen.fishTemp  = await page.$eval("#reading .g .val", n=>parseInt(n.textContent,10));
  seen.filedTemp = filedTemp;
  seen.checkBand = await page.$eval("#reading .checked", n=>n.textContent.replace(/\s+/g," ").trim());

  await page.click("#tab-plays");
  seen.playLede = await page.$eval("#panel-plays .playlede", n=>n.textContent.replace(/\s+/g," ").trim());
  seen.logChips = await page.$$eval("#panel-plays .chip", ns=>ns.filter(n=>/^log /.test(n.textContent.trim())).length);

  /* pooling: a log from somebody else merges, and merges only once */
  await page.click("#tab-onriver");
  seen.pooled = await page.evaluate(()=>{
    const mine = logFor(water());
    const theirs = JSON.parse(JSON.stringify(mine)).map(e=>
      Object.assign({}, e, {id:e.id+"-x", by:"Someone else"}));
    const first  = mergeEntries(theirs);
    const second = mergeEntries(theirs);
    return {first, second, total:logFor(water()).length};
  });

  /* a pasted log is somebody else's data: wrong types and markup and all */
  seen.hostile = await page.evaluate(()=>{
    mergeEntries([{
      id:"junk1", at:new Date().toISOString(), loc:{key:logKey(water()), name:"x"},
      by:"<img src=x onerror='window.__pwned=1'>",
      fished:{rating:"5", play:"euro", label:"L".repeat(300), landed:"lots"},
      learned:42, others:{level:"bogus", note:"fine"},
    }]);
    draw();
    const e=state.log.find(x=>x.id==="junk1");
    return {ratingType:typeof e.fished.rating, rating:e.fished.rating,
            label:e.fished.label.length, landed:e.fished.landed, learned:e.learned,
            level:e.others.level, injected:!!document.querySelector("#logHost img"),
            pwned:!!window.__pwned};
  });

  seen.errors = errors; seen.violations = violations;
  await page.close();
  return seen;
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
    eq(s.tabOrder, ["Fish","Where","Plays","Shop list","Hatch","On river"],
       "Fish leads the tabs and On river closes them");
    ok(s.readingInFish && s.readingOnce===1, "the dashboard lives on the Fish tab and nowhere else",
       {inFish:s.readingInFish, count:s.readingOnce});
    eq(s.defaultTab, {tab:"tab-fish", shown:["panel-fish"]}, "Fish is the default tab and the only one open");
    ok(s.onRiverChips>0, "the condition chips live on the On river tab", s.onRiverChips);
    eq(s.onRiverGroups, ["Barometer","Flow","Clarity","Sky"], "all four condition groups moved with it");
    ok(!s.strayControls, "nothing is left under the dashboard");
    eq(s.checkRows, ["Water temp","Flow","Clarity","Barometer","Wade call"],
       "every number on Fish can be confirmed on On river");
    ok(s.logEmpty.includes("Empty"), "the log starts empty for a location", s.logEmpty);
    ok(s.logStored===1, "filing a report writes it to storage", s.logStored);
    ok(s.formCleared==="", "and empties the form behind it", s.formCleared);
    ok(/Tester/.test(s.logEntry) && /inside seam/.test(s.logEntry)
       && /Two swinging wets/.test(s.logEntry) && /called off: flow/.test(s.logEntry),
       "the entry carries who, what was learned, who else was out and what was called wrong", s.logEntry);
    ok(/5\.0/.test(s.logWorks), "and rolls up into what has worked here", s.logWorks);
    ok(s.fishTemp===s.filedTemp, "a thermometer reading becomes the water temperature on Fish",
       {shown:s.fishTemp, filed:s.filedTemp});
    ok(/1 report/.test(s.checkBand) && /Flow/.test(s.checkBand),
       "and the Fish tab says who checked it", s.checkBand);
    ok(/moving the ranking/.test(s.playLede), "the plays say the log is steering them", s.playLede);
    ok(s.logChips===1, "and the play that worked is marked", s.logChips);
    eq(s.pooled, {first:1, second:0, total:2},
       "somebody else's log merges once and never twice");
    eq(s.hostile, {ratingType:"number", rating:5, label:80, landed:null, learned:"",
                   level:null, injected:false, pwned:false},
       "a pasted entry is coerced, bounded and never rendered as markup");
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

/* The deploy's Permissions-Policy can switch off a browser feature the app
   depends on. "Use my location" is the one that matters, so it is proven
   against the real header rather than assumed. */
async function geolocationWorks(browser){
  const ctx = await browser.newContext({
    permissions:["geolocation"], geolocation:{latitude:41.945, longitude:-74.972},
  });
  const page = await ctx.newPage();
  const blocked = [];
  page.on("console", m=>{ if(/permissions policy/i.test(m.text())) blocked.push(m.text()); });
  await mock(page, "happy");
  await page.goto(`http://127.0.0.1:${PORT}/`, {waitUntil:"domcontentloaded"});
  const got = await page.evaluate(()=>new Promise(res=>
    navigator.geolocation.getCurrentPosition(
      p=>res({ok:true, lat:Math.round(p.coords.latitude)}),
      e=>res({ok:false, code:e.code, message:e.message}))));
  await ctx.close();
  return {got, blocked};
}

const picked = process.argv.slice(2).filter(a=>SCENARIOS[a]);
const names = picked.length ? picked : Object.keys(SCENARIOS);

await new Promise(r=>server.listen(PORT,r));
const browser = await chromium.launch({executablePath:chromePath(), args:["--no-sandbox"]});
try{
  console.log("\n  deploy headers");
  {
    const pp = headers["Permissions-Policy"] || "";
    ok(/geolocation=\(self\)/.test(pp),
       "the deploy lets the page use geolocation for itself", pp);
    ok(/camera=\(\)/.test(pp) && /microphone=\(\)/.test(pp),
       "and still denies what the app never asks for", pp);
    const {got, blocked} = await geolocationWorks(browser);
    ok(got.ok, "\"Use my location\" resolves behind the real headers", got);
    ok(blocked.length===0, "no Permissions-Policy violation is logged", blocked);
  }

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
