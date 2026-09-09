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
import { scriptHash, policyHash } from "./seal.mjs";

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
const perms = readFileSync(TOML,"utf8").match(/Permissions-Policy = "([^"]+)"/)[1];

const server = http.createServer((_req,res)=>{
  res.writeHead(200, {"Content-Type":"text/html; charset=utf-8",
    "Content-Security-Policy":csp, "Permissions-Policy":perms});
  res.end(readFileSync(INDEX));
});

const json = (o)=>({status:200, contentType:"application/json", body:JSON.stringify(o)});
const rdbOf = (rows)=>({status:200, contentType:"text/plain", body:F.rdb(rows)});

async function mock(page, scenario, statCalls=[]){
  const leaflet = readFileSync(LEAFLET);
  await page.route("**://cdnjs.cloudflare.com/**", async r => {
    if(scenario==="noleaflet") return r.abort();
    // a slow riverbank connection to the CDN
    if(scenario==="slowmap") await new Promise(x=>setTimeout(x, CDN_LAG));
    r.fulfill({status:200, contentType:"application/javascript", body:leaflet});
  });

  for(const pat of ["**://tile.openstreetmap.org/**", "**://*.tile.openstreetmap.org/**"]){
    await page.route(pat, r =>
      scenario==="notiles" ? r.abort()
        : r.fulfill({status:200, contentType:"image/png", body:F.PNG_1PX}));
  }
  await page.route("**://fonts.googleapis.com/**", r=>r.fulfill({status:200, contentType:"text/css", body:""}));

  /* /api/shops is the app's own endpoint. Left unmocked it 404s, which is
     what an un-keyed deploy looks like — so every other scenario proves
     the OpenStreetMap fallback. The `places` scenario stands it up. */
  await page.route("**/api/shops**", r => {
    if(scenario!=="places") return r.fulfill({status:404, contentType:"application/json", body:"{}"});
    return r.fulfill(json({configured:true, shops:[
      {id:"places/1", name:"Cross Current Outfitters", kind:"fishing", kindLabel:"Fly and tackle", pri:0,
       where:"123 River Rd, Starlight", site:"https://crosscurrentoutfitters.example/",
       tel:"(570) 555-0134", map:"https://www.google.com/maps/search/?api=1&query=Cross%20Current",
       lat:41.91, lon:-75.34, dist:12000},
      {id:"places/2", name:"West Branch Angler", kind:"fishing", kindLabel:"Fly and tackle", pri:0,
       where:"150 Faulkner Rd, Hancock", site:"https://westbranchangler.example/", tel:null,
       map:"https://www.google.com/maps/search/?api=1&query=West%20Branch%20Angler",
       lat:42.015, lon:-75.38, dist:4000},
    ]}));
  });
  await page.route("**://nominatim.openstreetmap.org/search**",  r=>r.fulfill(json(F.GEOCODE)));
  await page.route("**://nominatim.openstreetmap.org/reverse**", r=>r.fulfill(json(F.REVERSE)));
  /* Anyone may edit an OpenStreetMap node's name. The security scenario
     serves one that has been edited into an attack. */
  const overpass = scenario==="security"
    ? (()=>{ const p=JSON.parse(JSON.stringify(F.OVERPASS));
             p.elements[0].tags.name = XSS; return p; })()
    : F.OVERPASS;
  /* One endpoint, two questions: the access query and the fly-shop
     query, told apart by what they ask for. */
  await page.route("**://overpass**", async r => {
    if(scenario==="overpassdown") return r.fulfill({status:504, contentType:"text/plain", body:"gateway timeout"});
    // the query travels form-encoded, so match the tag name, not the quotes
    const asked = r.request().postData() || "";
    const isShop = /shop/.test(asked);
    if(isShop){
      /* Record what the query was ABOUT, not just that one happened. The
         walk deliberately moves the centre — search a town, then pick an
         access point on it — and each centre is a query the app is right
         to make. What must never happen is the same centre asked twice,
         a near pass and then a wide one. Only the around() clause can
         tell those apart. */
      const m = /around:(\d+),(-?[\d.]+),(-?[\d.]+)/.exec(decodeURIComponent(asked));
      shopCalls.push({url:r.request().url(),
                      centre: m ? `${(+m[2]).toFixed(2)},${(+m[3]).toFixed(2)}` : "?",
                      radius: m ? +m[1] : 0});
      // the primary mirror is wedged; the backup has to rescue the lookup
      if(scenario==="slowshops" && /overpass-api\.de/.test(r.request().url())){
        await new Promise(x=>setTimeout(x, 9000));
        return r.abort();
      }
      // a wide Overpass query is sometimes just slow; that is not a failure
      if(scenario==="slowbutok") await new Promise(x=>setTimeout(x, 7000));
    }
    return r.fulfill(json(isShop ? F.SHOPS : overpass));
  });
  await page.route("**://api.open-meteo.com/**", r=>r.fulfill(json(F.meteo())));
  /* Elevation shares a host with the pressure reading, and Playwright gives
     the last-registered route precedence — so this must come after the
     general one or the calendar silently loses its elevation term.
     ELEV_FT is metres in, feet out: 1,463 m is Bozeman at 4,800 ft. */
  await page.route("**://api.open-meteo.com/v1/elevation**", r =>
    scenario==="noelevation" ? r.fulfill(json({}))
      : r.fulfill(json({elevation:[F.ELEV_M]})));
  await page.route("**://waterservices.usgs.gov/nwis/iv/**", r=>r.fulfill(json(F.IV)));
  /* Daily percentiles — a river's own flow bands. The yakima scenario serves
     them; everywhere else the record is absent, which is the fall-through to
     the analogue that existed before. */
  await page.route("**://waterservices.usgs.gov/nwis/stat/**", r => {
    const u=r.request().url();
    statCalls.push(u);
    /* The real service rejects a request that names percentiles, so the
       mock does too — otherwise the bug that started all this passes. */
    if(!/statTypeCd=all\b/.test(u))
      return r.fulfill({status:400, contentType:"text/plain", body:"invalid statTypeCd"});
    if(scenario==="yakima")   return r.fulfill({status:200, contentType:"text/plain", body:F.yakimaStats()});
    if(scenario==="michigan") return r.fulfill({status:200, contentType:"text/plain", body:F.pmStats()});
    if(scenario==="meanonly") return r.fulfill({status:200, contentType:"text/plain", body:F.meanOnlyStats()});
    return r.fulfill({status:404, contentType:"text/plain", body:"no statistics"});
  });
  /* Canada's gauges. Two collections, both GeoJSON; realtime is matched
     first because the stations pattern would otherwise swallow it. */
  await page.route("**://api.weather.gc.ca/collections/hydrometric-stations/**", r =>
    scenario==="canadadown" ? r.fulfill({status:503, contentType:"text/plain", body:"unavailable"})
      : r.fulfill(json(F.ECCC_STATIONS)));
  await page.route("**://api.weather.gc.ca/collections/hydrometric-realtime/**", r =>
    scenario==="canadadown" ? r.fulfill({status:503, contentType:"text/plain", body:"unavailable"})
      : r.fulfill(json(F.ECCC_REALTIME)));

  await page.route("**://waterservices.usgs.gov/nwis/site/**", r => {
    const bbox = r.request().url().includes("bBox=");
    if(scenario==="michigan"||scenario==="meanonly")
      return r.fulfill(rdbOf(bbox ? F.MI_SITES : [F.SITE_PM_UP, F.SITE_BEAVERKILL]));
    if(scenario==="scaled")  return r.fulfill(rdbOf(bbox ? [F.SITE_LITTLE] : [F.SITE_LITTLE, F.SITE_BEAVERKILL]));
    if(scenario==="noarea")  return r.fulfill(rdbOf([F.SITE_LITTLE_NOAREA]));
    if(scenario==="yakima")  return r.fulfill(rdbOf([F.SITE_YAKIMA, F.SITE_BEAVERKILL]));
    return r.fulfill(rdbOf(bbox ? [F.SITE_BEAVERKILL, F.SITE_LITTLE] : [F.SITE_BEAVERKILL, F.SITE_WBD]));
  });
}

const XSS = `<img src=x onerror="window.__xss=(window.__xss||0)+1">`;
const F_ECCC_CFS = F.ECCC_CFS;
let shopCalls = [];        // which mirrors the shop query actually reached
const CDN_LAG = 1500;

/* Chrome and Chromium word this refusal differently and the wording is not
   API, so match on what it says rather than how it says it. Both known
   phrasings are pinned below, because a matcher that quietly stops matching
   would turn the security scenario green by accident. */
const isHandlerRefusal = (t)=>
  /inline event handler/i.test(t) && /Content Security Policy|script-src/i.test(t);

const REFUSAL_WORDINGS = [
  // Chromium, as shipped in the Playwright browser pool
  `Refused to execute inline event handler because it violates the following Content Security Policy directive: "script-src 'self' 'sha256-x' https://cdnjs.cloudflare.com".`,
  // Google Chrome, as shipped on the GitHub runner image
  `Executing inline event handler violates the following Content Security Policy directive 'script-src 'self' 'sha256-x' https://cdnjs.cloudflare.com'. The action has been blocked.`,
];

/* Walks the app the way a person does: open Where, search an address,
   read the access list, pick the top entry. Returns what it saw. */
async function walk(browser, scenario){
  /* Two scenarios need a real position: security, to prove the header allows
     one at all, and outofbook, which has to be standing somewhere the book
     does not cover for the device-location path to be worth testing. */
  const GEO = {
    security: {latitude:41.9337, longitude:-74.9143},   // Roscoe, NY
    outofbook:{latitude:45.6770, longitude:-111.0429},  // Bozeman, MT
  }[scenario];
  /* Half of what this app decides is a function of the clock — which light
     window it is, whether a hatch is on its hours, whether it is dark enough
     to swim a mouse. Left to the container the browser runs in UTC, which is
     a timezone no user of a Northeast fly-fishing app is ever in, and 23:00
     in July then reads as evening rather than night. Pin it to the water. */
  const TZ = {timezoneId:"America/New_York"};
  const ctx = await browser.newContext(GEO
    ? Object.assign({permissions:["geolocation"], geolocation:GEO}, TZ)
    : Object.assign({}, TZ));
  const page = await ctx.newPage();
  const errors = [], violations = [], refusals = [], statCalls = [];
  page.on("pageerror", e => errors.push("pageerror: " + e.message));
  page.on("console", m => {
    const t = m.text();
    // the security scenario fires a handler at the policy on purpose; the
    // refusal it earns is the evidence, not a defect
    if(scenario==="security" && isHandlerRefusal(t)) refusals.push(t);
    else if(/Content Security Policy|Refused to/i.test(t)) violations.push(t);
    // a mocked 504 is the point of the overpassdown scenario, not a defect
    /* /api/shops 404s when the app is served as plain files, which is how
       this harness serves it and how an un-deployed copy behaves. The
       fallback to OpenStreetMap is the tested behaviour; the browser's
       note about it is not a defect. */
    else if(m.type()==="error" && !/favicon|ERR_|504|404|503/.test(t)) errors.push("console: " + t);
  });
  await mock(page, scenario, statCalls);

  const seen = {};
  shopCalls = [];
  if(scenario==="slowmap"){
    /* The reading must not wait on the map library. Measured from the
       first byte to the first play card, while the CDN sits on Leaflet. */
    const t0 = Date.now();
    await page.goto(`http://127.0.0.1:${PORT}/`, {waitUntil:"commit"});
    await page.waitForSelector("#panel-fish .play", {state:"attached", timeout:15000});
    seen.playsAt = Date.now()-t0;
    seen.leafletYet = await page.evaluate(()=>typeof L!=="undefined");
  }
  await page.goto(`http://127.0.0.1:${PORT}/`, {waitUntil:"networkidle"});
  seen.leaflet = await page.evaluate(()=>typeof L!=="undefined");

  /* What the app's own locate() settled on, read before the walk clicks
     anything — by the end of the walk it has searched, picked a spot and
     chosen a water, and whatever geolocation decided is long gone. */
  if(GEO){
    await page.waitForFunction(()=>state.geo!==null, {timeout:8000}).catch(()=>{});
    seen.settledOnLoad = await page.evaluate(()=>({
      geo: !!state.geo, water: water().name, sp: water().sp, spot: !!state.spot,
    }));
  }
  /* The app opens on Plan and the day picker is the first thing on it, so
     it has to be filled by the first paint — not by whatever redraw happens
     to come along next. */
  /* The book list is gone, so the river card IS the water picker. If it
     only ever drew around a pin, a browser that has just been told where
     it is would show no picker at all until the angler searched. It takes
     its centre from the location too — and it must do that without a pin,
     because a pin costs an access lookup and a second shop query on load. */
  if(GEO){
    seen.pickerOnLoad = await page.evaluate(()=>({
      rows: document.querySelectorAll("#riverCard .rvbtn").length,
      pin: !!state.pin,
      head: (document.querySelector("#riverCard h3")||{}).textContent||"",
    }));
  }
  seen.firstPaint = await page.evaluate(()=>{
    const w=document.getElementById("whenbar");
    return {open:(document.querySelector('.tab[aria-selected="true"]')||{}).textContent,
            chips: w ? w.querySelectorAll("#planChips .rchip").length : 0};
  });

  /* Which tab the app opens on, before anything has been clicked. Plan is
     first because the reading is worth nothing until it knows where you
     are, and the map has to come up on its own for that to be true. */
  seen.opensOn = await page.evaluate(()=>({
    tab: (()=>{ const t=[...document.querySelectorAll(".tab")].find(x=>x.getAttribute("aria-selected")==="true");
                return t ? t.textContent.trim() : null; })(),
    panels: [...document.querySelectorAll(".panel")].filter(p=>!p.hidden).map(p=>p.id),
    stateTab: state.tab,
    mapBox: !!document.querySelector("#map"),
    searchBox: !!document.querySelector("#findQ"),
    playsBuilt: document.querySelectorAll("#panel-fish .play").length,
  }));
  seen.mapWithoutClick = await page.waitForSelector(".leaflet-container", {timeout:6000})
    .then(()=>true, ()=>false);

  /* An OSM name reaching innerHTML as markup leaves an inline handler in
     the tree for as long as that render lives — which can be a fraction
     of the walk. The gate card did exactly this and only the CSP stopped
     it, so watch every insertion from here on rather than looking in the
     two places the bug was first expected. */
  if(scenario==="security") await page.evaluate(()=>{
    window.__inlineHits=[];
    const name=(n)=>{ const p=[]; let e=n;
      while(e && e!==document.body){ p.unshift(e.id?"#"+e.id:(e.className?e.tagName+"."+String(e.className).split(" ")[0]:e.tagName)); e=e.parentElement; }
      return p.join(" > "); };
    new MutationObserver(ms=>{
      for(const m of ms) for(const n of m.addedNodes){
        if(n.nodeType!==1) continue;
        const bad = (n.matches && n.matches("[onerror],[onload],[onclick]")) ? n
                  : (n.querySelector && n.querySelector("[onerror],[onload],[onclick]"));
        if(bad) window.__inlineHits.push(name(bad));
      }
    }).observe(document.body, {childList:true, subtree:true});
  });

  await page.click("#tab-plan");
  seen.mapRendered = await page.waitForSelector(".leaflet-container",{timeout:5000}).then(()=>true,()=>false);
  seen.mapCard = (await page.$eval("#mapCard", n=>n.textContent)).replace(/\s+/g," ").trim();

  await page.fill("#findQ", "Roscoe NY");
  await page.click(".findbtn[type=submit]");
  await page.waitForSelector(".wbtn.apt", {timeout:12000});
  if(scenario==="notiles") await page.waitForTimeout(4000);

  /* The rivers around the searched point — the only water picker on Plan
     now that the book list is gone. It re-sorts around where the angler
     pointed, not around the device location. */
  await page.waitForSelector("#riverCard .rvbtn", {timeout:10000});
  seen.nearHead = await page.$eval("#riverCard h3", n=>n.textContent.trim());
  seen.nearFirst = await page.$$eval("#riverCard .rvbtn .wn",
    ns=>ns.slice(0,3).map(n=>n.childNodes[0].textContent.trim()));
  seen.nearOrdered = await page.$$eval("#riverCard .rvbtn .wd",
    ns=>ns.map(n=>parseInt(n.textContent,10)||0));
  seen.nearBook = await page.$$eval("#riverCard .rvbtn",
    ns=>ns.filter(n=>/^book:/.test(n.dataset.k)).map(n=>n.dataset.k));

  seen.names = await page.$$eval(".wbtn.apt .wn", ns=>ns.map(n=>n.childNodes[0].textContent.trim()));
  seen.kinds = await page.$$eval(".wbtn.apt .akind", ns=>ns.map(n=>n.textContent.trim()));
  seen.markers = await page.evaluate(()=>document.querySelectorAll(".acc-i").length);
  seen.card = (await page.$eval("#accessCard", n=>n.textContent)).replace(/\s+/g," ").trim();
  seen.mapNote = await page.$eval("#mapNote", n=>n.textContent.trim()).catch(()=>"");

  await page.click(".wbtn.apt");
  // how the reading was built now travels with the reading, in the dashboard
  await page.waitForFunction(()=>document.querySelector("#conditions")
    && document.querySelector("#conditions").textContent.includes("Seasonal curves"), {timeout:8000});

  seen.spot  = await page.$eval("#planbar .pb-id h2", n=>n.textContent.trim());
  const meta = (await page.$eval("#conditions .rd-meta", n=>n.textContent)).replace(/\s+/g," ");
  seen.meta  = meta;
  seen.bands = (meta.match(/ideal ([\d]+)[–-]([\d]+) cfs · blown above (\d+)/)||[]).slice(1).map(Number);
  seen.uncalibrated = meta.includes("uncalibrated");
  seen.plays = await page.$$eval("#panel-fish .play", n=>n.length);
  seen.hatch = await page.$$eval("#panel-fish .hrow", n=>n.length);
  seen.shop  = await page.$$eval("#panel-shop .sitem", n=>n.length);

  // a water from the book must clear the synthesized spot
  await page.click('#riverCard .rvbtn[data-k="book:willo"]');
  await page.waitForTimeout(400);
  seen.afterBook = await page.$eval("#planbar .pb-id h2", n=>n.textContent.trim());
  seen.spotCleared = await page.evaluate(()=>state.spot===null);

  /* Conditions lead Fish, the call follows them, the hatch closes the tab,
     and the nearest waters sit directly under the map on Plan. */
  seen.layout = await page.evaluate(()=>{
    const plan=document.getElementById("panel-plan");
    const fish=document.getElementById("panel-fish");
    const cond=document.getElementById("conditions");
    const map=document.getElementById("mapCard");
    const near=document.getElementById("riverCard");
    const tactic=document.getElementById("tactic");
    const hatch=document.getElementById("hatchIntro");
    const when=document.getElementById("whenbar");
    const tabs=document.querySelector(".tabs");
    const after=(a,b)=> !!a && !!b && (a.compareDocumentPosition(b)&Node.DOCUMENT_POSITION_FOLLOWING)>0;
    return {
      condInFish: !!cond && fish.contains(cond),
      condFirstInFish: fish.firstElementChild && fish.firstElementChild.id==="conditions",
      condHasGauges: !!cond && !!cond.querySelector(".gauges"),
      condHasBaro: !!cond && !!cond.querySelector(".baro"),
      condHasGaugeId: !!cond && /Gauge \d/.test(cond.textContent),
      condHasNote: !!cond && !!cond.querySelector(".rd-note") && cond.querySelector(".rd-note").textContent.length>40,
      tacticAfterCond: after(cond, tactic) && !!fish.querySelector("#tactic .acc-call"),
      hatchInFish: !!hatch && fish.contains(hatch) && after(tactic, hatch),
      nearUnderMap: !!near && plan.contains(near) && after(map, near),
      whenOnPlan: !!when && plan.contains(when) && !!when.querySelector("#planChips"),
      whenFirstOnPlan: !!when && plan.firstElementChild===when,
      whenNotAboveTabs: !when || after(tabs, when),
      ladderOnFish: !!fish.querySelector("#ladderCard") && after(tactic, fish.querySelector("#ladderCard")),
      ladderNotOnPlan: !plan.querySelector("#ladderCard"),
      strayReading: !!document.getElementById("reading"),
      gaugesInPlan: !!plan.querySelector(".gauges"),
      callInPlan: !!plan.querySelector(".acc-call"),
      builtCard: /How this reading was built/.test(document.body.textContent),
      reportCond: (()=>{ const r=document.getElementById("panel-report"), c=document.getElementById("conditionsReport");
        return !!c && r.contains(c) && r.firstElementChild.id==="reportConditions" && !!c.querySelector(".gauges"); })(),
      oneConditionsId: document.querySelectorAll("#conditions").length===1,
    };
  });

  seen.tabOrder = await page.$$eval(".tab", ts=>ts.map(t=>t.textContent.trim()));
  await page.click("#tab-report");
  seen.onRiverChips = await page.$$eval("#onriver .rchip", n=>n.length);
  seen.onRiverGroups = await page.$$eval("#onriver .rlab", ns=>ns.map(n=>n.textContent.trim().split(" — ")[0]));
  // the Report tab carries both halves: what you can see, and what came of it
  seen.reportHasBoth = await page.evaluate(()=>{
    const r=document.getElementById("panel-report");
    return !!r.querySelector("#onriver .refine") && !!r.querySelector("#diary #dSave");
  });
  seen.strayControls = await page.evaluate(()=>!!document.getElementById("controls"));

  await shopPass(page, seen);
  await calendarPass(page, seen);
  if(scenario==="trip") await tripPass(page, seen);
  if(scenario==="yakima") await yakimaPass(page, seen);
  if(scenario==="canada"||scenario==="canadadown") await canadaPass(page, seen);
  /* This one picks a river and leaves the app on it, so it runs only where
     that is the point — otherwise it changes the water out from under the
     scenarios that follow. */
  if(scenario==="elevation"||scenario==="noelevation") await elevationPass(page, seen);
  await reachPass(page, seen);

  if(scenario==="diary") await diaryPass(page, seen);
  if(scenario==="plan")  await planPass(page, seen);
  if(scenario==="security") await securityPass(page, seen);
  if(scenario==="outofbook") await outOfBookPass(page, seen);
  if(scenario==="plays") await playsPass(page, seen);
  if(scenario==="named") await namedPass(page, seen);
  if(scenario==="michigan"||scenario==="meanonly") await michiganPass(page, seen);

  seen.errors = errors; seen.violations = violations; seen.refusals = refusals;
  seen.statCalls = statCalls;
  await page.close(); await ctx.close();
  return seen;
}

/* The shop list is worth nothing at home, so it carries the counters it
   can be handed across. Those names and website tags are world-writable
   OpenStreetMap strings, which is why one of them is an attack. */
async function shopPass(page, seen){
  const t0=Date.now();
  await page.click("#tab-shop");
  await page.waitForFunction(()=>{
    const c=document.getElementById("shopsCard");
    return c && !/Looking up/.test(c.textContent);
  }, {timeout:12000}).catch(()=>{});

  seen.shops = await page.evaluate(()=>{
    const card=document.getElementById("shopsCard");
    if(!card) return null;
    const rows=[...card.querySelectorAll(".shoprow")];
    return {
      head: (card.querySelector("h3")||{}).textContent || "",
      names: rows.map(r=>r.querySelector(".sn").childNodes[0].textContent.trim()),
      links: rows.map(r=>[...r.querySelectorAll(".shoplinks a")].map(a=>a.getAttribute("href"))),
      labels: rows.map(r=>[...r.querySelectorAll(".shoplinks a")].map(a=>a.textContent.trim())),
      miles: rows.map(r=>r.querySelector(".wd").textContent.trim()),
      firstOnTab: document.getElementById("panel-shop").firstElementChild.classList.contains("hint"),
      askFirst: /Ask the shop one question/.test(document.getElementById("panel-shop").firstElementChild.textContent),
      beforeList: !!card.compareDocumentPosition(document.querySelector("#panel-shop .shopcard"))
                  && (card.compareDocumentPosition(document.querySelector("#panel-shop .shopcard"))&Node.DOCUMENT_POSITION_FOLLOWING)>0,
      guide: /hiring a local guide/i.test(document.getElementById("panel-shop").textContent),
      photo: /Take a photo of this/i.test(document.getElementById("panel-shop").textContent),
      note: card.textContent.match(/\d+ more (?:is|are) (?:mapped|listed) further out/)?.[0] || "",
      knownMarks: rows.map(r=>!!r.querySelector(".knownmark")),
      sortLabel: (document.getElementById("shopSort")||{}).textContent?.trim() || "",
      ql: (typeof shopQL!=="undefined") ? shopQL(41.9337,-74.9143,40000) : "",
      findMore: !!card.querySelector('a[href*="q="]'),
      // ranking and URL vetting are data concerns; the cap is a rendering one
      all: (typeof state!=="undefined" ? state.shops.list : []).map(x=>({name:x.name, site:x.site, tel:x.tel, known:!!x.known, report:x.report||null})),
    };
  });
  seen.shopMs = Date.now()-t0;
  seen.shopCalls = shopCalls.slice();
}

/* The book is 27 Northeast rivers, and the westernmost of them are Lake
   Erie steelhead tributaries. A pin far enough west takes one of those as
   its nearest water, which is how a Montana trout river came to be read as
   a steelhead run with egg patterns ranked first. Distance has to switch
   the modeled half of the app off, not quietly reassign the fishery. */
async function outOfBookPass(page, seen){
  seen.book = await page.evaluate(()=>{
    const at=(lat,lon)=>{ const t=templateFor(lat,lon);
      return {name:t.w.name, miles:Math.round(t.dist/1609.34), sp:t.w.sp,
              latGap:Math.round(t.latGap*10)/10, lives:anyHatchLives(lat,lon)}; };
    const read=(lat,lon,name,sp)=>{
      const t=templateFor(lat,lon,sp);
      state.spot=spotProfile({lat,lon,name,sp}, t.w, t.dist, null, NaN, t.latGap);
      state.when=new Date(2026,5,20,14,0);                 // 20 June: salmonfly and green drake country
      const ctx=buildContext();
      const ah=activeHatches(ctx);
      return {out:ctx.outOfBook, isGL:ctx.isGL, sp:ctx.w.sp, shift:ctx.w.shift,
              hatches:ah.length, bugs:ah.map(o=>o.hx.id),
              plays:recommend(ctx).picked.length};
    };
    const out={
      nearest:{bozeman:at(45.677,-111.043), boise:at(43.615,-116.202)},
      /* The case this scenario was built around. It used to be the proof that
         the app knew when to stay quiet; now it is the proof that it knows
         what lives there. */
      montana: read(45.677,-111.043,"Gallatin River","trout"),
      oregon:  read(45.180,-121.080,"Deschutes River","trout"),
      roscoe:  read(41.9337,-74.9143,"Beaverkill","trout"),
      michigan:read(43.9000, -85.8500,"Pere Marquette River","trout"),
      /* Somewhere no insect in the table reaches. The gate still exists; it
         is just answered by the species now, so it takes a different ocean
         to trip it. */
      offmap:  read(51.08,-1.49,"River Test","trout"),
    };
    state.spot=null; state.when=new Date();
    return out;
  });

  // and what the angler is shown where nothing in the table lives
  seen.bookUI = await page.evaluate(()=>{
    const t=templateFor(51.08,-1.49,"trout");
    state.spot=spotProfile({lat:51.08,lon:-1.49,name:"River Test",sp:"trout"}, t.w, t.dist, null, NaN, t.latGap);
    draw();
    const fish=document.getElementById("panel-fish");
    return {
      gate: !!fish.querySelector(".gate h2") && fish.querySelector(".gate h2").textContent,
      says: /outside the book/i.test(fish.textContent),
      plays: fish.querySelectorAll(".play").length,
      tactic: !!fish.querySelector("#tactic"),
      ladder: !!fish.querySelector("#ladderCard"),
      tempCell: (fish.querySelector(".gauges .g .val")||{}).textContent,
      shopHead: (document.querySelector("#panel-shop .shop-intro h2")||{}).textContent,
      eggs: /egg/i.test(fish.textContent),
    };
  });
  await page.evaluate(()=>{ state.spot=null; draw(); });
}

/* The four condition-driven plays added alongside the hatch ones answer
   a question the calendar cannot: what to do when nothing is coming off,
   when the river is up, when it is too clear, and after dark. None of
   them can be checked by reading the source — a play is only correct if
   it appears under the conditions it is for and stays out of the way
   otherwise, and that is a property of the whole scoring engine, not of
   the builder. So the engine is driven directly, one condition set at a
   time, and asked what it would have said. */
async function playsPass(page, seen){
  seen.plays4 = await page.evaluate(()=>{
    const keep={water:state.waterId, when:state.when, ov:state.ov, live:state.live, spot:state.spot};
    state.spot=null; state.plan=null;

    const at=(o)=>{
      state.waterId = o.water;
      state.when = new Date(2026, o.mo-1, o.d, o.h, 0);
      state.ov = {flow:o.flow||null, clarity:o.clarity||null, sky:o.sky||null, baro:null};
      state.live = o.tempF!=null ? {gauge:water().gauge, tempF:o.tempF, cfs:null} : null;
      const ctx = buildContext(), r = recommend(ctx);
      return {all:(r.all||[]).map(p=>p.key), top:r.picked.map(p=>p.key),
              lw:ctx.lw.k, fs:ctx.fs.k, clarity:ctx.clarity.k, temp:Math.round(ctx.temp)};
    };

    const out = {
      /* every play the engine knows, and the diary's map of them — an
         unmapped key is not an error anywhere, it just silently stops
         the angler's own days from ever moving that play again */
      keys: PLAYS.map(p=>p.key),
      unmapped: PLAYS.map(p=>p.key).filter(k=>!METHOD_OF_PLAY[k]),

      // mouse: a warm July night on a river big enough to swim one
      mouseNight: at({water:"bkill", mo:7, d:15, h:23, tempF:64, flow:"normal"}),
      mouseNoon:  at({water:"bkill", mo:7, d:15, h:13, tempF:64, flow:"normal"}),
      mouseWinter:at({water:"bkill", mo:1, d:15, h:23, tempF:38, flow:"normal"}),
      mouseSmall: at({water:"willo", mo:7, d:15, h:23, tempF:64, flow:"normal"}),

      // high water: the flow is the whole trigger
      highUp:   at({water:"bkill", mo:5, d:10, h:12, tempF:54, flow:"high",   clarity:"stained"}),
      highBlown:at({water:"bkill", mo:5, d:10, h:12, tempF:54, flow:"blown",  clarity:"muddy"}),
      highNorm: at({water:"bkill", mo:5, d:10, h:12, tempF:54, flow:"normal", clarity:"clear"}),

      // scuds: the limestone and the tailwater carry them, the freestone does not
      scudLime: at({water:"spring", mo:2, d:10, h:12, tempF:48, flow:"low", clarity:"clear"}),
      scudTail: at({water:"wbd",    mo:2, d:10, h:12, tempF:42, flow:"low", clarity:"clear"}),
      scudFree: at({water:"bkill",  mo:2, d:10, h:12, tempF:38, flow:"low", clarity:"clear"}),

      // sight fishing: low, clear, and bright enough to see into
      sightLow:  at({water:"spring", mo:8, d:20, h:13, tempF:58, flow:"verylow", clarity:"gin",   sky:"bright"}),
      sightMuddy:at({water:"spring", mo:8, d:20, h:13, tempF:58, flow:"verylow", clarity:"muddy", sky:"bright"}),
      sightHigh: at({water:"spring", mo:8, d:20, h:13, tempF:58, flow:"high",    clarity:"gin",   sky:"bright"}),
      sightDark: at({water:"spring", mo:8, d:20, h:23, tempF:58, flow:"verylow", clarity:"gin",   sky:"bright"}),

      /* A steelhead trib has its own four plays and none of these. A scud
         play on the Salmon River would be a trout play wearing a hat. */
      gl: at({water:"salmonr", mo:11, d:5, h:12, flow:"low", clarity:"clear"}),
    };

    state.waterId=keep.water; state.when=keep.when; state.ov=keep.ov;
    state.live=keep.live; state.spot=keep.spot;
    return out;
  });
}

/* RIVERS is the half of this app that is knowledge rather than lookup: the
   rivers people actually fish, with a name, a point and what swims in them.
   It carries no gauge, no bands and no curve — those are resolved from USGS
   the moment a river is picked — so what has to hold is that nothing crept
   in that nobody can source, and that every row is somewhere the app can
   still say something true. */
async function namedPass(page, seen){
  seen.named = await page.evaluate(()=>{
    const invented = RIVERS.filter(r=>r.gauge||r.flow||r.wade||r.temps||r.shift!=null);
    const incomplete = RIVERS.filter(r=>!r.name||!r.place||!isFinite(r.lat)||!isFinite(r.lon)||!r.sp);
    const badSp = RIVERS.filter(r=>!["trout","steelhead","both"].includes(r.sp)).map(r=>r.name);
    const dupes = RIVERS.map(r=>r.name+"|"+r.place).filter((n,i,a)=>a.indexOf(n)!==i);
    const offMap = RIVERS.filter(r=>r.lat<24||r.lat>66||r.lon<-170||r.lon>-52).map(r=>r.name);
    const states = new Set(RIVERS.map(r=>r.place.split(", ").pop()));
    /* A river in the list has to resolve to a template of its own fishery,
       or picking it hands an angler the wrong calendar. */
    const wrongSp = RIVERS.map(r=>({r, t:templateFor(r.lat,r.lon, r.sp==="steelhead"?"steelhead":"trout").w}))
      .filter(o=>o.t.sp !== (o.r.sp==="steelhead"?"steelhead":"trout")).map(o=>o.r.name);
    return {count:RIVERS.length, invented:invented.map(r=>r.name), incomplete:incomplete.map(r=>r.name),
            badSp, dupes, offMap, wrongSp, states:[...states].sort(), nStates:states.size,
            both:RIVERS.filter(r=>r.sp==="both").length};
  });
}

/* Baldwin, Michigan. Under the old model this was the whole failure in one
   place: the nearest of the 27 was a Lake Erie steelhead creek 298 miles
   away, so the pin inherited a steelhead fishery and was then gated out for
   being too far — wrong analogue, and no reading either way. It is the
   worked example for the whole path: type a town, get the rivers that are
   actually there, pick one, and have its gauge be what the plays read. */
async function michiganPass(page, seen){
  seen.pheno = await page.evaluate(()=>{
    /* The shift is computed now. The 27 hand-written values were written
       river by river with no formula in mind, so they are the only
       independent check this file has on the formula that replaced them. */
    const tr=WATERS.filter(w=>w.sp==="trout");
    const err=tr.map(w=>({name:w.name, hand:w.shift, calc:bioShift(w.lat,w.type)}))
                .map(o=>({...o, off:Math.abs(o.calc-o.hand)}));
    return {worst: err.reduce((a,b)=>b.off>a.off?b:a, err[0]),
            mean: +(err.reduce((s,o)=>s+o.off,0)/err.length).toFixed(2),
            over4: err.filter(o=>o.off>4).map(o=>o.name),
            baldwin: bioShift(43.90,"freestone"), letort: bioShift(40.19,"limestone"),
            /* Which insects reach each place. There is no geographic gate left
               to test — the species answer it — so what matters is that four
               different places get four different sets. */
            lives:(()=>{
              const at=(la,lo)=>HATCHES.filter(h=>h.waters==="all"&&inRange(h,la,lo)).map(h=>h.id);
              return {baldwin:at(43.90,-85.85), driftless:at(43.60,-90.85),
                      ozark:at(36.30,-93.20), bozeman:at(45.68,-111.04)};
            })()};
  });

  await page.click("#tab-plan");
  await page.waitForSelector("#findQ");
  await page.evaluate(()=>{ state.spot=null; });
  await page.evaluate(()=>setPin(43.9022, -85.8517, "Baldwin, Lake County, Michigan"));
  await page.waitForSelector("#riverCard .rvbtn", {timeout:10000});

  seen.mi = await page.evaluate(()=>({
    head: (document.querySelector("#riverCard h3")||{}).textContent,
    rivers: [...document.querySelectorAll("#riverCard .rvbtn .wn")].map(n=>n.childNodes[0].textContent.trim()),
    keys: [...document.querySelectorAll("#riverCard .rvbtn")].map(b=>b.dataset.k),
    subs: [...document.querySelectorAll("#riverCard .rvbtn .wt")].map(n=>n.textContent.trim()),
    src: state.rivers.src, n: state.rivers.list.length,
  }));

  await page.click("#riverCard .rvbtn");
  await page.waitForFunction(()=>!!state.spot, {timeout:10000}).catch(()=>{});
  seen.miPick = await page.evaluate(()=>{
    const w=water(), ctx=buildContext();
    return {name:w.name, place:w.place, sp:w.sp, gauge:w.gauge, both:!!w.both,
            tmpl:w.spot.template.name, tmplSp:w.spot.template.sp,
            latGap:w.latGap, shift:w.shift, beyond:!!w.beyond, out:ctx.outOfBook,
            hatches:activeHatches(ctx).length, plays:recommend(ctx).picked.length,
            saysGauge:/USGS \d/.test(w.note||""),
            saysOwnCalendar:/this river's own/.test(w.note||""),
            namesElsewhere:/Catskill|Beaverkill|baseline/i.test(w.note||"")};
  });
  seen.miBands = await page.evaluate(()=>{
    const w=water(), keep=state.live;
    state.live={gauge:w.gauge, cfs:620, tempF:63, at:new Date()};
    const ctx=buildContext();
    const out={source:w.spot?w.spot.bandSource:null, ideal:w.flow.ideal,
               state:ctx.fs.k, cfs:ctx.cfs,
               plays:recommend(ctx).picked.map(p=>p.key), note:w.note||""};
    state.live=keep;
    return out;
  });

  // and in May, when the calendar has to be doing real work
  seen.miMay = await page.evaluate(()=>{
    const keep=state.when;
    state.when=new Date(2026,4,20,14,0);
    const ctx=buildContext();
    const out={hatches:activeHatches(ctx).length, plays:recommend(ctx).picked.map(p=>p.key)};
    state.when=keep;
    return out;
  });
  // the fishery is the angler's call, never the app's
  await page.waitForSelector("#rvSp", {timeout:8000});
  await page.click("#rvSp");
  await page.waitForFunction(()=>water().sp==="steelhead", {timeout:10000}).catch(()=>{});
  seen.miGL = await page.evaluate(()=>{
    const w=water(), ctx=buildContext();
    return {sp:w.sp, name:w.name, tmplSp:w.spot.template.sp, isGL:ctx.isGL,
            plays:recommend(ctx).picked.map(p=>p.key)};
  });
  /* Each river's chart is its own. The same insect has to carry different
     dates on the Pere Marquette than on the Letort, and nothing an angler
     reads may describe one river as an offset from another. */
  await page.evaluate(()=>{ state.rivers.sp=null; });
  await page.click("#riverCard .rvbtn");
  await page.waitForFunction(()=>water().sp==="trout", {timeout:10000}).catch(()=>{});
  seen.miHatch = await page.evaluate(()=>{
    const readAt=()=>{
      state.when=new Date(2026,4,20,14,0);
      const ctx=buildContext(), res=recommend(ctx);
      const wrap=document.createElement("div");
      wrap.innerHTML=hatchHTML(res,ctx);
      const wins={};
      for(const hx of HATCHES) wins[hx.id]=hx.win[0]+shiftOf(hx,ctx);
      return {river:ctx.w.name, text:wrap.textContent.replace(/\s+/g," ").trim(),
              intro:(wrap.querySelector("#hatchIntro p")||{}).textContent||"",
              dated:[...wrap.querySelectorAll(".hwin")].map(n=>n.textContent.trim()),
              wins};
    };
    const keep=state.when, keepSpot=state.spot, keepId=state.waterId;
    const pm=readAt();
    state.spot=null; state.waterId="letort";
    const letort=readAt();
    state.when=keep; state.spot=keepSpot; state.waterId=keepId;
    return {pm, letort};
  });
  await page.evaluate(()=>{ state.spot=null; state.pin=null; state.rivers={status:"idle",list:[],key:null}; draw(); });
}

/* Two things this app cannot check by reading its own source: that the
   data it renders is text rather than markup, and that the headers the
   deploy actually sends let its own features work. Both are only true
   for as long as something drives a browser and looks. */
async function securityPass(page, seen){
  // the marker tooltips are built lazily, on open
  await page.evaluate(()=>{ accLayer.eachLayer(l=>{ if(l.openTooltip) l.openTooltip(); }); });
  await page.waitForTimeout(400);

  seen.sec = await page.evaluate(()=>{
    const tip=document.querySelector(".leaflet-tooltip");
    return {
      fired: window.__xss||0,
      tooltipHasImg: !!(tip && tip.querySelector("img")),
      tooltipShowsText: !!(tip && tip.textContent.includes("<img src=x")),
      cardHasImg: !!document.querySelector("#accessCard img"),
      cardShowsText: (document.querySelector("#accessCard")||{}).textContent?.includes("<img src=x") || false,
      /* Everything the watcher below caught over the whole walk. A snapshot
         taken here would miss it: the app re-renders onto another water
         before this runs, and the offending card is gone by then. */
      inlineHandlers: window.__inlineHits || [],
    };
  });

  /* The watcher above only sees a card the walk happens to render, and the
     too-warm gate — where the unescaped name actually was — needs the water
     at 65 F or more. That is a function of the month and the hour, so CI
     missed this bug for as long as it ran in the evening. Drive the gate
     directly instead, at a temperature that always opens it. */
  seen.gate = await page.evaluate((xss)=>{
    const base = buildContext();
    const out = {};
    for(const [name, temp] of [["marginal", 66], ["stop", 70]]){
      const html = gateCard(Object.assign({}, base, {
        isGL:false, temp, w:Object.assign({}, base.w, {name:xss}),
      }));
      const box = document.createElement("div");
      box.innerHTML = html;                       // detached: nothing can load
      out[name] = {
        rendered: /class="gate"/.test(html),
        hasElement: !!box.querySelector("img,[onerror],[onload],[onclick]"),
        showsText: box.textContent.includes("<img src=x"),
      };
    }
    return out;
  }, XSS);

  /* Defence in depth: even a sink nobody has found yet must not be able
     to run a handler, because script-src no longer allows inline script. */
  seen.cspBlocks = await page.evaluate(()=>{
    window.__depth = 0;
    const d=document.createElement("div");
    d.innerHTML = `<img src=x onerror="window.__depth=1">`;
    document.body.appendChild(d);
    return new Promise(r=>setTimeout(()=>{ d.remove(); r(window.__depth); }, 400));
  });

  // and the app's own geolocation must survive the Permissions-Policy
  seen.geo = await page.evaluate(()=>new Promise(res=>{
    if(!navigator.geolocation) return res("no api");
    navigator.geolocation.getCurrentPosition(
      p=>res("allowed"), e=>res("blocked:"+e.code), {timeout:5000});
  }));
}

/* Planning a day. The gauge is not a forecast, so the further out
   the planned day sits the less of it survives into the reading —
   and the diary, which is keyed to the time of year rather than the
   clock, takes over. */
async function planPass(page, seen){
  await page.click("#tab-plan");
  await page.waitForSelector("#whenbar .pb-when");

  seen.plan = await page.evaluate(()=>{
    const iso=(d)=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
    const at=(n)=>{ const d=new Date(); d.setDate(d.getDate()+n); return d; };
    const read=()=>{ const c=buildContext(); return {
      lead:c.lead, temp:c.temp, cfs:c.cfs, tempSrc:c.tempSource, flowSrc:c.flowSource,
      carryFlow:+c.carry.flow.toFixed(3), baro:c.baro.source, day:c.day}; };

    state.plan=null; state.when=plannedWhen();
    const now=read();
    const out={now};
    for(const n of [1,3,10,16]){
      state.plan={date:iso(at(n)), hour:10};
      state.when=plannedWhen();
      out["d"+n]=read();
    }
    // the model alone, for the same planned day, with the gauge taken away
    const keep=state.live; state.live=null;
    state.plan={date:iso(at(16)), hour:10};
    state.when=plannedWhen();
    out.bare=read();
    state.live=keep;
    state.plan=null; state.when=plannedWhen();
    return out;
  });

  // the picker itself, driven the way a person drives it
  await page.click("#planChips .rchip:not(.auto)");        // "Tomorrow"
  await page.waitForSelector("#planNow");
  seen.planUI = {
    lead: await page.evaluate(()=>buildContext().lead),
    lead1: await page.$eval("#whenbar .pb-lead", n=>n.textContent.replace(/\s+/g," ").trim()),
    date: await page.$eval("#planDate", n=>n.value),
  };
  await page.click("#planNow");
  seen.planUI.backToNow = await page.evaluate(()=>({lead:buildContext().lead, plan:state.plan}));
}

/* The diary is the one thing the angler types rather than taps, and
   the only input that outlives the tab. So it is driven twice: once
   through the form, and once again after a reload. */
async function diaryPass(page, seen){
  const chip = (field, value) => `#diary .dchip[data-f="${field}"][data-v="${value}"]`;

  await page.click("#tab-report");
  await page.waitForSelector("#dSave");
  seen.diaryEmpty = await page.$eval("#diary", n=>n.textContent.includes("Days you save show up here"));
  seen.noReadout = await page.$eval("#diary", n=>!/telling the plays/i.test(n.textContent));

  // a day with nothing said about it is not a day the engine can use
  await page.click("#dSave");
  seen.needsOutcome = await page.$eval("#diary .dsaved", n=>n.textContent.trim());

  await page.click(chip("outcome","hot"));
  await page.click(chip("methods","streamer"));
  await page.fill("#dFlies", "Olive sculpin, size 4");
  await page.fill("#dNotes", "Fish were hard on the far bank all afternoon.");
  await page.click("#dSave");
  await page.waitForSelector("#diary .dentry");

  seen.entryText = (await page.$eval("#diary .dentry", n=>n.textContent)).replace(/\s+/g," ").trim();
  seen.stored = await page.evaluate(()=>{
    const j = JSON.parse(localStorage.getItem("riffle.diary.v1")||"[]");
    return {n:j.length, outcome:j[0]&&j[0].outcome, methods:j[0]&&j[0].methods,
            flies:j[0]&&j[0].flies, water:j[0]&&j[0].water};
  });
  // the conditions stay prefilled from the reading; what you said about the day does not
  seen.formReset = await page.$$eval(
    "#diary .dchip[aria-pressed=true]",
    ns=>ns.map(n=>n.dataset.f).filter(f=>!f.startsWith("cond.")).length);
  seen.formKeepsCond = await page.$$eval(
    "#diary .dchip[aria-pressed=true][data-f^='cond.']", ns=>ns.length);

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

  /* The engine, with the book and without it. Read off every play that
     scored rather than the three on the card: in a month the streamer is
     not a top-three play the book still has to be moving it. */
  seen.rank = await page.evaluate(()=>{
    const ctx = buildContext();
    const withBook = recommend(ctx);
    const bare = recommend(Object.assign({}, ctx, {mem:{days:0, rows:[], tech:{}, hatch:{}}}));
    const find = (r)=>r.all.find(p=>p.key==="streamer"||p.key==="gl-streamer");
    const s = find(withBook), b = find(bare);
    return {found: !!(s&&b),
            moved: !!(s&&b) && s.score>b.score*1.02,
            ranked: withBook.picked.map(p=>p.key), bareRanked: bare.picked.map(p=>p.key)};
  });
  seen.playsNote = await page.$$eval("#panel-fish .fromdiary", ns=>ns.map(n=>n.textContent.trim()));

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

  /* Export builds a blob: URL and clicks it. The deploy CSP is strict
     enough that this is worth proving here rather than discovering on
     the live site, where a blocked download is silent. */
  const dl = page.waitForEvent("download", {timeout:5000}).catch(()=>null);
  await page.click("#dExport");
  const got = await dl;
  seen.exported = got ? got.suggestedFilename() : null;

  // and it all survives the tab being closed
  await page.reload({waitUntil:"networkidle"});
  await page.click("#tab-report");
  await page.waitForSelector("#diary .dentry");
  seen.afterReload = await page.$$eval("#diary .dentry", ns=>ns.length);
  // and they speak only for the water they were logged on
  seen.reloadPct = await page.evaluate(()=>{
    const here = buildContext().mem.tech.streamer;
    state.waterId="willo"; state.spot=null;         // the water the walk logged them on
    const there = buildContext().mem.tech.streamer;
    return {elsewhere: here?here.pct:null, logged: there?there.pct:null};
  });

  // a day on another water, at another time of year, must not speak for this one
  seen.outOfRange = await page.evaluate(()=>{
    state.diary = [normEntry({date:"2025-01-04", waterId:"penns", hatchKey:"penns", water:"Penns Creek",
                              lat:40.85, lon:-77.35, outcome:"hot", methods:["streamer"]})];
    state.when = new Date();
    return buildContext().mem.days;
  });
}

/* The book's reach has two doors, and the distance question has to be asked
   at both. The pin path asks it. The device-location path did not, and a
   curated water is never "outside the book" — it IS the book — so a phone
   in Bozeman opened straight onto a Lake Erie steelhead tributary 1,554
   miles off, run and hatch chart intact. Same bug, other door.

   This drives the real thing: a browser whose geolocation is in Montana,
   the app's own locate() on load, and then whatever water it settled on. */
async function reachPass(page, seen){
  seen.reach = await page.evaluate(()=>{
    const out={};
    /* Colder water to go to instead, asked from a point the book does not
       cover. Unbounded, this offered Northeast rivers from anywhere. */
    const keepId=state.waterId, keepSpot=state.spot, keepWhen=state.when;
    state.when=new Date(new Date().getFullYear(), 6, 20, 14, 0);
    const ctx=buildContext();
    const far=Object.assign({}, ctx, {temp:70, w:Object.assign({}, ctx.w, {id:"__x", lat:45.68, lon:-111.04})});
    out.refugesFromMontana = refuges(far).map(o=>o.w.name+" ("+o.d+" mi)");
    const near=Object.assign({}, ctx, {temp:70, w:Object.assign({}, ctx.w, {id:"__x", lat:40.85, lon:-77.35})});
    out.refugesFromPenns = refuges(near).map(o=>o.d);
    state.waterId=keepId; state.spot=keepSpot; state.when=keepWhen;
    return out;
  });
}

/* Whether the calendar is right where the fish are, measured the only way
   that means anything: against hatches these rivers are known for. The
   engine keys on the PEAK — that is what the intensity curve is built
   around — so peak error in days is the number, not window edges.

   Truth here is the hatch each river is famous for, at the date anglers
   fish it. It is hand-written and coarse to a week; the test allows for
   that by asking about the mean across ten cases rather than any one. */
const HATCH_TRUTH = [
  // river,          lat,     lon,      type,       ft,    hatch,                      peak
  ["Beaverkill NY",  41.94,  -74.97,  "freestone", 1150, "Hendrickson & Red Quill", [4,28]],
  ["Madison MT",     45.48, -111.53,  "freestone", 4900, "Salmonfly",               [6,28]],
  ["Deschutes OR",   44.75, -121.25,  "freestone", 1400, "Salmonfly",               [5,25]],
  ["Big Hole MT",    45.72, -112.75,  "freestone", 5100, "Salmonfly",               [6,20]],
  ["Madison MT",     45.48, -111.53,  "freestone", 4900, "Western Green Drake",     [7, 5]],
  ["Frying Pan CO",  39.36, -106.82,  "tailwater", 7800, "Western Green Drake",     [8, 5]],
  ["Madison MT",     45.48, -111.53,  "freestone", 4900, "Pale Morning Dun",        [7,10]],
  ["Bow R AB",       51.03, -114.05,  "tailwater", 3400, "Pale Morning Dun",        [7,15]],
  ["Green R UT",     40.91, -109.42,  "tailwater", 5500, "Pale Morning Dun",        [7,10]],
  ["Au Sable MI",    44.66,  -84.70,  "freestone", 1100, "Hexagenia (Hex)",         [7, 5]],
];

/* Elevation has to reach the spot, the calendar and the Plan card — and
   when the lookup fails, the calendar has to fall back to latitude rather
   than to sea level, which would drag every date nine days early. */
async function elevationPass(page, seen){
  /* Pick a river first — elevation is a property of a chosen point, and the
     walk has not chosen one by here. */
  /* The list fills in as USGS answers, and the written waters arrive first,
     so waiting on the card alone picks a book river every time. */
  const ready = await page.waitForFunction(
    ()=>(state.rivers&&state.rivers.list||[]).some(r=>!r.book),
    {timeout:15000}).then(()=>true,()=>false);
  if(ready){
    /* A river that is one of the 27 reads as itself and clears the spot, so
       elevation never comes into it. Ask the app to read one it has to
       synthesize — the same call the button makes. */
    const picked = await page.evaluate(()=>{
      const r=(state.rivers&&state.rivers.list||[]).find(x=>!x.book);
      if(!r) return null;
      window.__pick=r.name;
      chooseRiver(r.key);
      return r.name;
    });
    seen.elevPicked = picked;
    await page.waitForFunction(()=>state.spot!==null, {timeout:12000}).catch(()=>{});
    await page.waitForTimeout(700);
  }
  seen.elev = await page.evaluate(()=>{
    const sp=state.spot;
    const gd=HATCHES.find(x=>x.name==="Western Green Drake");
    const w=water();
    const at=(ft)=>{ const t=Object.assign({}, w, {elevFt:ft});
                     return gd.anchor?speciesShift(gd.anchor,t):t.shift; };
    return {
      picked: window.__pick||null,
      onSpot: sp ? sp.elevFt : null,
      known: !!sp && typeof sp.elevFt==="number" && isFinite(sp.elevFt),
      card: (document.querySelector("#riverCard")||{}).textContent||"",
      /* the term is real: a thousand feet is about ten days */
      lowVsHigh: at(8000) - at(3000),
      unknownIsAnchorNotZero: at(NaN) !== at(0),
    };
  });
}

async function calendarPass(page, seen){
  seen.cal = await page.evaluate((truth)=>{
    const DOY=(m,d)=>{const t=[0,31,59,90,120,151,181,212,243,273,304,334];return t[m-1]+d;};
    const rows=truth.map(([name,lat,lon,type,ft,hatch,pk])=>{
      const h=HATCHES.find(x=>x.name===hatch);
      if(!h) return {name, hatch, missing:true};
      const w={lat,lon,type,elevFt:ft,shift:bioShift(lat,type)};
      const anchored=h.anchor?speciesShift(h.anchor,w):w.shift;
      const target=DOY(pk[0],pk[1]);
      return {name, hatch, anchored:Math.abs(h.win[1]+anchored-target),
              latOnly:Math.abs(h.win[1]+w.shift-target), lives:inRange(h,lat,lon)};
    });
    const mean=(k)=>rows.reduce((a,r)=>a+(r[k]||0),0)/rows.length;
    return {rows, meanAnchored:+mean("anchored").toFixed(1), meanLatOnly:+mean("latOnly").toFixed(1),
            missing:rows.filter(r=>r.missing).map(r=>r.hatch),
            notLiving:rows.filter(r=>!r.missing && !r.lives).map(r=>r.name+": "+r.hatch)};
  }, HATCH_TRUTH);
}

/* North of the 49th there is no USGS. The gauge, its units and its
   silences all differ, and none of that may reach the rest of the app:
   a Canadian river has to read like any other river. */
async function canadaPass(page, seen){
  seen.canada = await page.evaluate(async ()=>{
    const out = {};
    out.inCanada = {calgary: inCanada(51.03,-114.05), roscoe: inCanada(41.93,-74.91)};
    const g = await nearestGauge(51.03, -114.05);
    out.gauge = g ? {id:g.id, name:g.name, ca:!!g.ca, dist:Math.round(g.dist)} : null;
    out.live = g ? await tryLive(g.id) : null;
    /* the discontinued station in the fixture must not be the answer */
    out.pickedDiscontinued = !!(g && /999/.test(g.id));
    /* and a USGS id must still route to USGS */
    out.usgsStillWorks = !!(await tryLive("01420500"));
    /* read it the way the dashboard does, through the whole engine */
    if(g && out.live){
      const keep=state.live, keepSpot=state.spot;
      state.spot = await buildSpot({lat:51.03, lon:-114.05, name:"Bow River", place:"Calgary, AB",
                                    sp:"trout", gauge:g, pickedGauge:g.id});
      state.live = Object.assign({}, out.live, {gauge:state.spot.gauge});
      const ctx=buildContext();
      out.shown = {cfs:ctx.cfs, flowSource:ctx.flowSource, tempSource:ctx.tempSource};
      state.live=keep; state.spot=keepSpot;
    }
    return out;
  });
}

/* A big western river matched to a small eastern one. The match is right —
   latitude and river type are what make one river a reading for another —
   but its FLOW is not transferable, and the app used to say so with total
   confidence in both directions. */
async function yakimaPass(page, seen){
  seen.yak = await page.evaluate(async ()=>{
    const out={};
    const read=async (stats)=>{
      const spot=await buildSpot({lat:46.95, lon:-120.55, name:"Yakima River",
                                  place:"Ellensburg, WA", sp:"trout"});
      const keepS=state.spot, keepL=state.live;
      state.spot=spot; state.live={gauge:spot.gauge, cfs:1850, tempF:55, at:new Date()};
      const ctx=buildContext();
      const out={template:spot.spot.template.name, gauge:spot.gauge,
                 bandSource:spot.spot.bandSource, ideal:spot.flow.ideal,
                 blown:spot.flow.blown, wadeMax:spot.wade.max,
                 cfs:ctx.cfs, state:ctx.fs.k, label:ctx.fs.label,
                 note:(spot.note||"").match(/Flow bands[^.]*\./)||[""]};
      state.spot=keepS; state.live=keepL;
      return out;
    };
    /* The shop half of the same river. "Popular" cannot be a star rating —
       no free service publishes those without a key — so it is whether this
       is the shop anglers name for this water, and whether it writes the
       river up. On the Yakima that is Red's, which is further away than the
       nearest counter and still the right answer. */
    /* What the reviews are worth. A 5.0 from three people must not beat a
       4.8 from six hundred, and a shop nobody has reviewed must not be
       pushed below a worse shop that happens to have been rated. */
    const S=(o)=>shopScore(Object.assign({kind:"fishing"}, o));
    out.pop = {
      thin:  S({rating:5.0, reviews:3}),
      thick: S({rating:4.8, reviews:600}),
      unrated: S({}),
      poorButRated: S({rating:3.1, reviews:400}),
      /* real numbers must be able to out-argue the hand-written list */
      knownPlain: S({known:true}),
      popularStranger: S({rating:4.9, reviews:900}),
    };
    const shops = knownShops(46.95, -120.55, 40000);
    const ranked = sortShops(shops, "known").map(x=>x.name);
    const nearest = sortShops(shops, "near").map(x=>x.name);
    const report = shopReportFor({name:"Yakima River", lat:46.95, lon:-120.55});
    return {own: await read(), ranked, nearest, report, pop: out.pop,
            noReportWhereNoneWritten: shopReportFor({name:"Beaverkill", lat:41.94, lon:-74.97})};
  });
}

/* A phone does not close its tabs. Everything the angler taps is about one
   afternoon, so coming back a fortnight later must not greet them with last
   trip's muddy water and a half-ticked shopping list — and must never take
   the diary, which is the record rather than the session. */
async function tripPass(page, seen){
  seen.trip = await page.evaluate(async ()=>{
    const dirty=()=>{
      state.ov={flow:"blown", clarity:"muddy", sky:"overcast", baro:null};
      state.checked=new Set(["f-Parachute Adams","f-Zebra Midge"]);
      state.plan={date:"2020-05-01", hour:10};          // long past
      state.diary=[normEntry({date:"2026-05-01", waterId:"bkill", hatchKey:"bkill",
        water:"Beaverkill", lat:41.94, lon:-74.97, outcome:"hot", methods:["dry"]})];
    };
    const snap=()=>({ov:Object.values(state.ov).filter(Boolean).length,
                     checked:state.checked.size, plan:!!state.plan,
                     diary:state.diary.length, swept:(state.swept||[]).length});
    const out={};

    /* Away five minutes: still the same afternoon. */
    state.trip=false; dirty();
    localStorage.setItem("riffle.seen.v1", String(Date.now()-5*60*1000));
    freshenSession(); out.brief=snap();

    /* Away two days: a different trip. */
    dirty(); state.swept=null;
    localStorage.setItem("riffle.seen.v1", String(Date.now()-48*60*60*1000));
    freshenSession(); out.stale=snap();

    /* Same gap, but held on purpose. */
    dirty(); state.swept=null; state.trip=true;
    localStorage.setItem("riffle.seen.v1", String(Date.now()-48*60*60*1000));
    freshenSession(); out.held=snap();
    state.trip=false;

    /* A day still ahead is a plan, not a leftover. */
    dirty(); state.swept=null;
    const d=new Date(Date.now()+7*86400000);
    state.plan={date:`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`, hour:10};
    localStorage.setItem("riffle.seen.v1", String(Date.now()-48*60*60*1000));
    freshenSession(); out.future=snap();

    /* Whether the river goes with the rest depends on where you are now.
       A home water fifty miles off is not worth re-picking every week; the
       one you drove four hundred miles to is last week's trip. */
    const river=(lat,lon,geoLat,geoLon)=>{
      state.trip=false; state.swept=null; state.staleGap=true;
      state.spot=spotProfile({lat,lon,name:"Test River",place:"",sp:"trout"},
                             templateFor(lat,lon,"trout").w, 0, null, NaN, 0);
      state.geo={lat:geoLat, lon:geoLon};
      const dropped=dropDistantRiver();
      return {dropped, spot:!!state.spot, note:(state.swept||[]).join(" | ")};
    };
    out.homeWater = river(46.95,-120.55, 46.99,-120.53);     // still in Ellensburg
    out.droveHome = river(46.95,-120.55, 41.50,-81.70);       // back in Ohio
    /* With no location there is nothing to judge on, so the river stays. */
    state.trip=false; state.swept=null; state.staleGap=true;
    state.spot=spotProfile({lat:46.95,lon:-120.55,name:"Test River",place:"",sp:"trout"},
                           templateFor(46.95,-120.55,"trout").w, 0, null, NaN, 0);
    state.geo=null;
    out.noLocation={dropped:dropDistantRiver(), spot:!!state.spot};
    state.spot=null; state.geo=null; state.staleGap=false; state.swept=null;

    /* And the switch survives the tab being closed. */
    state.trip=true; tripSave(); state.trip=false; tripLoad();
    out.heldPersists=state.trip;
    state.trip=false; tripSave();
    return out;
  });
}

/* ---------- what each scenario must prove ---------- */
const SCENARIOS = {
  happy: (s)=>{
    ok(s.leaflet, "Leaflet loads from the CDN");
    ok(s.opensOn.tab==="Plan" && s.opensOn.stateTab==="plan",
       "the app opens on Plan", s.opensOn);
    eq(s.opensOn.panels, ["panel-plan"], "with only that panel shown");
    ok(s.opensOn.searchBox && s.opensOn.mapBox,
       "and the search box and map are there without a tab being clicked", s.opensOn);
    ok(s.mapWithoutClick, "the map comes up on its own", s.mapWithoutClick);
    ok(s.opensOn.playsBuilt>0,
       "and the plays are built behind it, ready for the tab", s.opensOn.playsBuilt);
    ok(s.mapRendered, "the map renders");
    eq(s.names, ["Cooks Falls Access","Riverside Trail","Beaverkill Lot","Read the pin itself"],
       "access is listed best-first, private lot and waterless lot excluded");
    eq(s.kinds, ["Boat launch","Trailhead","Parking","Pin"], "each entry is labelled by kind");
    ok(s.markers===3, "every access point is on the map", s.markers);
    ok(s.card.includes("Check before you park"), "the list carries the verify-access note");
    ok(s.spot==="Cooks Falls Access", "picking an access point re-reads the water there", s.spot);
    ok(s.meta.includes("Beaverkill"), "the dashboard names the water it borrowed from");
    ok(s.meta.includes("01420500"), "the dashboard names the gauge it read");
    ok(!s.uncalibrated, "bands from the water's own gauge are not flagged uncalibrated");
    ok(s.plays>0 && s.hatch>0 && s.shop>0, "plays, hatch and shop list all render for a spot",
       {plays:s.plays, hatch:s.hatch, shop:s.shop});
    ok(/near Roscoe/.test(s.nearHead), "the river list is built around the point you searched", s.nearHead);
    ok(s.nearFirst.includes("Beaverkill") && s.nearFirst.includes("Willowemoc Creek"),
       "and leads with the Catskill waters around Roscoe", s.nearFirst);
    ok(s.nearOrdered.length>0 && s.nearOrdered.every((d,i,a)=>i===0||d>=a[i-1]),
       "listed nearest first", s.nearOrdered);
    ok(s.nearOrdered.length<=12, "and kept short enough not to bury the map", s.nearOrdered.length);
    ok(s.nearBook.length>0,
       "with the written waters among them, so nothing is lost with the book list gone", s.nearBook);
    ok(s.layout.condInFish && s.layout.condFirstInFish, "river conditions lead the Fish tab", s.layout);
    ok(s.layout.condHasGauges && s.layout.condHasBaro, "with the gauges and the barometer in them", s.layout);
    ok(s.layout.condHasGaugeId && s.layout.condHasNote,
       "and the gauge it reads and what this river is like, in the dashboard itself", s.layout);
    ok(!s.layout.builtCard, "so there is no 'how this reading was built' card left to look up", s.layout);
    ok(s.layout.tacticAfterCond, "the wade-or-float call follows the numbers", s.layout);
    ok(s.layout.hatchInFish, "and what is hatching closes the same tab", s.layout);
    ok(s.layout.nearUnderMap, "the nearest waters sit directly under the map on Plan", s.layout);
    ok(s.firstPaint.open==="Plan" && s.firstPaint.chips>0,
       "the app opens on Plan with the day picker already filled", s.firstPaint);
    ok(s.layout.whenOnPlan && s.layout.whenFirstOnPlan && s.layout.whenNotAboveTabs,
       "the day picker leads the Plan tab and appears nowhere else", s.layout);
    ok(s.layout.reportCond, "river conditions lead the Report tab too", s.layout.reportCond);
    ok(s.layout.oneConditionsId, "and the second copy carries its own id rather than duplicating one");
    ok(s.layout.ladderOnFish && s.layout.ladderNotOnPlan,
       "the access ladder sits on Fish, under the call it explains", s.layout);
    ok(!s.layout.strayReading && !s.layout.gaugesInPlan && !s.layout.callInPlan,
       "with nothing left behind on Plan", s.layout);
    eq(s.tabOrder, ["Plan","Shop","Fish","Report"],
       "four tabs: plan the day, gear up, then fish it, then write it down");
    ok(s.onRiverChips>0, "the condition chips live on the Report tab", s.onRiverChips);
    eq(s.onRiverGroups, ["Barometer","Flow","Clarity","Sky"], "all four condition groups moved with them");
    ok(s.reportHasBoth, "which carries what you can see and what came of it, in one place", s.reportHasBoth);
    ok(!s.strayControls, "nothing is left under the dashboard");
    /* The eight the map knows are all still here; the hand-written ones
       merge in beside them rather than replacing them. */
    const MAPPED=["Beaverkill Angler","Poisoned Tackle","Catskill Outfitters","Willowemoc Fly Shop",
                  "Border Water Tackle","Cross Current Outfitters","West Branch Angler",
                  "Deposit Hardware & Supply"];
    const have=new Set(s.shops.all.map(x=>x.name.replace(/^The /,"")));
    ok(MAPPED.every(n=>have.has(n)) && !s.shops.all.some(x=>!x.name),
       "every shop that reads as a fly shop is ranked, and an unnamed one is not a shop",
       s.shops.all.map(x=>x.name));
    ok(!s.shops.all.some(x=>/^the beaverkill angler$/i.test(x.name)) ||
       !s.shops.all.some(x=>/^beaverkill angler$/i.test(x.name)),
       "and a shop the map and the book both know is listed once, not twice",
       s.shops.all.map(x=>x.name));
    /* Default order puts the shop anglers name for this water first. */
    ok(s.shops.knownMarks[0]===true,
       "the list leads with a shop known for this river, not merely the closest one",
       {names:s.shops.names, known:s.shops.knownMarks});
    ok(/Sort by nearest/.test(s.shops.sortLabel),
       "with one tap back to plain distance", s.shops.sortLabel);
    ok(/\d+ more (?:is|are) listed further out/.test(s.shops.note),
       "and the ones held back are accounted for", s.shops.note);
    ok(/Fly shops near Roscoe/.test(s.shops.head), "under the place you pointed at", s.shops.head);
    eq(s.shops.links[0],
       ["https://beaverkillangler.example/", "tel:+16074985001", "https://www.openstreetmap.org/node/11"],
       "each with its own website, its phone and its place on the map");
    const by=(n)=>s.shops.all.find(x=>x.name===n)||{};
    ok(by("Willowemoc Fly Shop").site===null && by("Willowemoc Fly Shop").tel===null,
       "a shop with neither website nor phone still gets a map link and nothing invented",
       by("Willowemoc Fly Shop"));
    ok(by("Catskill Outfitters").site==="https://catskilloutfitters.example/" && !by("Catskill Outfitters").tel,
       "a bare hostname is still made a link, and a shop with no phone simply has none",
       by("Catskill Outfitters"));
    ok(by("Cross Current Outfitters").site==="https://crosscurrentoutfitters.example/",
       "including on a guide service OSM knows only by name", by("Cross Current Outfitters"));
    ok(by("Poisoned Tackle").site===null,
       "a website tag edited into javascript: is dropped before it can reach an href", by("Poisoned Tackle"));
    ok(s.shops.links.every(l=>l.every(h=>/^(https?:|tel:)/.test(h))),
       "so every href on the tab is one the app built or vetted", s.shops.links);
    ok(s.shops.firstOnTab && s.shops.askFirst,
       "what to ask the shop leads the tab, directly under the tabs", s.shops.askFirst);
    ok(s.shops.beforeList, "and come before the list you are handing across the counter");
    ok(s.shops.guide, "the tab suggests a guide before it suggests a fly");
    /* The list came back empty for Hale Eddy and for Starlight while the
       shops plainly existed, because shop=fishing is not how OSM files a
       lodge or a guide service. The name is the second signal. */
    ok(s.shops.all.some(x=>x.name==="West Branch Angler"),
       "a fly shop mapped as a hotel is still a fly shop", s.shops.all.map(x=>x.name));
    ok(s.shops.all.some(x=>x.name==="Cross Current Outfitters"),
       "and so is a guide service with no shop tag at all", s.shops.all.map(x=>x.name));
    ok(s.shops.all.some(x=>x.name==="Border Water Tackle"),
       "and one named like tackle but tagged as an outdoor shop", s.shops.all.map(x=>x.name));
    ok(!s.shops.all.some(x=>/Flying Pizza/.test(x.name)),
       "a restaurant that merely starts with fly is not", s.shops.all.map(x=>x.name));
    /* A name regex over a 56-mile radius is a full scan and times out,
       which the angler sees as "the lookup did not answer". Overpass gets
       the indexed question; the names are matched here. */
    ok(!/name"~/.test(s.shops.ql),
       "the query asks Overpass nothing it has to scan for", s.shops.ql);
    ok(/\["shop"\]/.test(s.shops.ql) && /tourism/.test(s.shops.ql),
       "it asks by indexed tag — shops, and the lodgings fly shops hide inside", s.shops.ql);
    ok(/around:40000/.test(s.shops.ql),
       "at the 25 miles an angler means by near, widening only if that is empty", s.shops.ql.slice(0,60));
    ok(s.shops.findMore,
       "and the card always offers a way to look past OpenStreetMap, whose rural coverage is thin");
    /* A bbox+regex rewrite of this query read better, scanned less, and
       returned no shops at all for a real town. It is the around: form. */
    ok(!s.shops.all.some(x=>/Bakery|Clip Joint|Riverside Motel/.test(x.name)),
       "asking for every nearby shop does not make a bakery a fly shop",
       s.shops.all.map(x=>x.name));
    ok(/out tags center (1\d\d|[2-9]\d\d)/.test(s.shops.ql),
       "and asks for enough of them that a wide radius cannot truncate the near one",
       s.shops.ql.slice(-40));
    /* One query per centre. Counting queries outright made this a race:
       the walk moves the centre twice and a 1200 ms debounce swallowed
       the first only when the runner was quick, so the same code passed
       locally and failed in CI. What the check is for is radius
       escalation — a near pass answered, then widened anyway. */
    const byCentre = s.shopCalls.reduce((m,c)=>((m[c.centre]=(m[c.centre]||0)+1), m), {});
    const askedTwice = Object.entries(byCentre).filter(([,n])=>n>1);
    eq(askedTwice, [],
       "no centre is asked twice — a near query is never followed by a wide one");
    ok(s.shopCalls.every(c=>c.radius<=40000),
       "and the near radius is what an angler means by near", s.shopCalls.map(c=>c.radius));
    ok(s.shopMs < 1500,
       `the tab was already warm when opened (${s.shopMs} ms), not looked up on arrival`, s.shopMs);
    ok(!s.shops.photo, "and no longer opens by telling you to photograph it", s.shops.photo);
  },
  scaled: (s)=>{
    // Little Beaver Kill drains 23.4 mi² against the Beaverkill's 241
    eq(s.bands, [15,49,146], "flow bands rescale by the drainage-area ratio");
    ok(!s.uncalibrated, "a scaled band is not flagged uncalibrated");
    ok(s.meta.includes("drainage area"), "the dashboard says the bands were scaled");
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
    ok(s.noReadout, "and Report no longer explains the ranking — the play cards do that");
    ok(/how the day went/i.test(s.needsOutcome), "a day with no outcome is refused", s.needsOutcome);
    ok(s.stored.n===1 && s.stored.outcome==="hot", "the day is written to storage", s.stored);
    eq(s.stored.methods, ["streamer"], "with the method that caught");
    ok(s.stored.flies==="Olive sculpin, size 4", "and the flies that caught", s.stored.flies);
    ok(s.stored.water==="Willowemoc Creek", "logged against the water on screen", s.stored.water);
    ok(/Olive sculpin/.test(s.entryText) && /Hot/.test(s.entryText), "and reads back as a day", s.entryText);
    ok(s.formReset===0, "the form clears what you said for the next day", s.formReset);
    ok(s.formKeepsCond===3, "but keeps the conditions prefilled from the reading", s.formKeepsCond);
    ok(s.oneDay>0 && s.oneDay<=15, "one hot day nudges the streamer, no more than 15%", s.oneDay);
    /* Four hot days on the streamer put the multiplier within a point of the
       ceiling and never through it. Pinning the exact integer was pinning a
       rounding boundary — the confidence term is asymptotic, so it approaches
       15% without ever reaching it, and which side of 14.5 it lands on moves
       with the water and the date. The cap is the invariant; the lean is the
       claim. */
    ok(s.pcts.streamer>s.oneDay, "four of them lean harder than one", s.pcts);
    ok(s.pcts.streamer>=14 && s.pcts.streamer<=15,
       "as hard as the cap allows, and no harder", s.pcts);
    ok(s.pcts.dry<0, "and a blank on the dry fly reads the other way", s.pcts);
    ok(s.rank.found, "the streamer play is among those the engine scored", s.rank);
    ok(s.rank.moved, "and scores higher with the book than without it", s.rank);
    ok(s.playsNote.length>0 && /your book|day/i.test(s.playsNote.join(" ")),
       "and the play card says which days moved it", s.playsNote);
    ok(s.stretch, "a hatch just outside its window was found to test the stretch on");
    ok(s.stretch && s.stretch.before===0, "the calendar alone gives it nothing", s.stretch);
    ok(s.stretch && s.stretch.after>0 && s.stretch.listed,
       "a logged sighting stretches the window and puts it back on the panel", s.stretch);
    ok(s.stretch && s.stretch.farAfter===0,
       "but a bug months out of season stays off it", s.stretch);
    ok(/^riffle-diary-\d{4}-\d{2}-\d{2}\.json$/.test(s.exported||""),
       "the book exports as a file the deploy's CSP does not block", s.exported);
    ok(s.afterReload===5, "every day survives the tab being closed", s.afterReload);
    ok(s.reloadPct.logged>=12, "and still lean the plays hard on the next visit", s.reloadPct);
    ok(s.reloadPct.elsewhere===null, "on the water they were logged on, and no other", s.reloadPct);
    ok(s.outOfRange===0, "a day on another water in another season speaks for neither", s.outOfRange);
  },
  plan: (s)=>{
    const p=s.plan;
    ok(p.now.lead===0 && p.now.flowSrc==="live" && p.now.tempSrc==="live",
       "with no plan set the reading is today's, straight off the gauge", p.now);
    ok(p.d1.lead===1 && p.d3.lead===3 && p.d10.lead===10, "the planner reads the day you point it at", p);
    ok(p.d1.carryFlow>p.d3.carryFlow && p.d3.carryFlow>p.d10.carryFlow,
       "the gauge counts for less the further out the day is", p);
    ok(p.d1.flowSrc==="carried" && p.d3.flowSrc==="carried",
       "a day or three out, today's reading is carried forward", p);
    ok(p.d10.flowSrc==="model" && p.d10.tempSrc==="carried",
       "flow lets go of the gauge first — one storm resets a river", p);
    ok(p.d16.flowSrc==="model" && p.d16.tempSrc==="model",
       "and a fortnight out nothing of the gauge is left in either number", p);
    ok(p.d16.cfs===p.bare.cfs && p.d16.temp===p.bare.temp,
       "which is exactly what the model gives with no gauge at all", {far:p.d16, bare:p.bare});
    ok(p.d1.cfs!==p.now.cfs || p.d1.temp!==p.now.temp,
       "a planned day is not just today's numbers relabelled", p);
    ok(p.now.baro!=="ahead" && p.d1.baro==="ahead" && p.d10.baro==="ahead",
       "and pressure is never carried forward at all — it is weather, not season", p);
    ok(p.d3.day===p.now.day+3, "the hatch calendar reads the planned date, not today", p);
    ok(s.planUI.lead===1 && /^\d{4}-\d{2}-\d{2}$/.test(s.planUI.date),
       "the shortcut chips set the day", s.planUI);
    ok(/1 day out/.test(s.planUI.lead1), "and the bar says how far out it is reading", s.planUI.lead1);
    ok(s.planUI.backToNow.lead===0 && s.planUI.backToNow.plan===null,
       "and there is a way back to now", s.planUI.backToNow);
  },
  security: (s)=>{
    /* This scenario is one of the two that run with a real geolocation, so
       it is where the picker-on-load property can be checked. The book list
       is gone and the river card IS the water picker: if it only ever drew
       around a pin, a browser that has just been told where it is would show
       no picker at all until the angler searched. And it has to fill without
       a pin, because a pin costs an access lookup and a second shop query on
       load — which is exactly what CI caught. */
    ok(s.pickerOnLoad.rows>0 && !s.pickerOnLoad.pin,
       "the river picker fills from your location on first paint, with no pin dropped",
       s.pickerOnLoad);

    ok(s.sec.fired===0, "an OSM name tag full of markup does not execute", s.sec);
    ok(!s.sec.tooltipHasImg && s.sec.tooltipShowsText,
       "the map tooltip renders it as text, not as an element", s.sec);
    ok(!s.sec.cardHasImg && s.sec.cardShowsText,
       "and so does the access list", s.sec);
    eq(s.sec.inlineHandlers, [],
       "and at no point in the walk does it land in the tree as an element");
    ok(s.gate.marginal.rendered && s.gate.stop.rendered,
       "the too-warm gate opens when driven at 66 and 70 degrees", s.gate);
    ok(!s.gate.marginal.hasElement && !s.gate.stop.hasElement,
       "and names the water as text at both temperatures, not as an element", s.gate);
    ok(s.gate.marginal.showsText && s.gate.stop.showsText,
       "so the markup in the name is shown, which is the whole point", s.gate);
    ok(s.cspBlocks===0,
       "the policy blocks an inline handler even from a sink nobody has found yet", s.cspBlocks);
    ok(s.refusals.length===1 && /script-src/.test(s.refusals[0]),
       "and says so — the block came from the policy, not from luck", s.refusals);
    ok(s.geo==="allowed", "the app's own geolocation still works under the deployed headers", s.geo);
    ok(s.names.length>1 && s.plays>0, "and a poisoned access point does not break the app", s.names);
  },
  slowmap: (s)=>{
    ok(!s.leafletYet, "the plays render before the map library has even arrived", s.leafletYet);
    ok(s.playsAt < CDN_LAG, `and in ${s.playsAt} ms, not the ${CDN_LAG} ms the CDN took`, s.playsAt);
    ok(s.mapRendered, "and the map still comes up once it lands", s.mapRendered);
    ok(s.names.length>1, "with the access flow unaffected", s.names);
  },
  elevation: (s)=>{
    ok(s.elev.known, "a picked river carries its elevation",
       {river:s.elev.picked, onSpot:s.elev.onSpot});
    ok(Math.round(s.elev.onSpot)===4800,
       "converted from the metres Open-Meteo answers in", s.elev.onSpot);
    ok(/sits at 4,800 ft/.test(s.elev.card.replace(/\s+/g," ")),
       "and Plan says so, where the river was chosen", s.elev.card.slice(0,120));
    ok(s.elev.lowVsHigh>=45 && s.elev.lowVsHigh<=55,
       "five thousand feet moves a hatch about fifty days", s.elev.lowVsHigh);
    ok(s.elev.unknownIsAnchorNotZero,
       "and an unknown elevation is the anchor's own height, never sea level",
       s.elev.unknownIsAnchorNotZero);
  },
  noelevation: (s)=>{
    ok(!s.elev.known, "with the lookup answering nothing, no elevation is claimed", s.elev.onSpot);
    ok(/latitude alone/.test(s.elev.card.replace(/\s+/g," ")),
       "Plan says the dates are latitude-only and will read early on a mountain river",
       s.elev.card.slice(0,200));
    ok(s.plays>0, "and everything else still reads", s.plays);
  },
  canada: (s)=>{
    const c=s.canada;
    ok(c.inCanada.calgary && !c.inCanada.roscoe,
       "the app knows which side of the border a point is on", c.inCanada);
    ok(c.gauge && c.gauge.ca, "and asks Environment Canada for a gauge up there", c.gauge);
    ok(c.gauge && c.gauge.id==="05BH004",
       "finding the Bow at Calgary by its ECCC station number", c.gauge);
    ok(!c.pickedDiscontinued, "and skipping the discontinued station beside it", c.gauge);
    ok(c.live && c.live.cfs===F_ECCC_CFS,
       `reading 92.3 m³/s back as ${F_ECCC_CFS} cfs, because the flow bands are cubic feet`, c.live);
    ok(c.live && c.live.tempF===null,
       "with no water temperature, which that feed does not carry — so it stays modeled", c.live);
    ok(c.usgsStillWorks, "and a USGS id still goes to USGS", c.usgsStillWorks);
    /* The reading has to survive the trip to the dashboard. It is turned into
       a multiple of the water's ideal band to rank the plays on, and that
       ratio is clamped at ten — so a river far bigger than the bands borrowed
       for it used to come back a third short. Every Canadian spot is
       uncalibrated, because ECCC publishes no drainage area, so this is where
       it shows. */
    ok(c.shown && c.shown.flowSource==="live" && c.shown.cfs===F_ECCC_CFS,
       `the dashboard prints the ${F_ECCC_CFS} cfs the gauge actually read`, c.shown);
  },
  canadadown: (s)=>{
    const c=s.canada;
    ok(!c.gauge || !c.gauge.ca,
       "with Environment Canada down, no Canadian gauge is claimed", c.gauge);
    /* Falling through to USGS is deliberate — border rivers are gauged on
       both sides — so what is asserted is that the fall-through happened
       and nothing pretended to be an ECCC reading. In this run USGS answers
       with the Beaverkill because the fixture ignores the bounding box; the
       real service is asked within a quarter degree of the point. */
    ok(c.live===null || (c.live && c.live.gauge && !/[A-Za-z]/.test(c.live.gauge)),
       "and any reading that does come back is not dressed up as one", c.live);
    ok(s.plays>0, "the river still reads on modeled numbers", s.plays);
    ok(c.usgsStillWorks, "while USGS is unaffected", c.usgsStillWorks);
  },
  yakima: (s)=>{
    const y=s.yak.own;
    ok(y.template==="West Branch Ausable" || /Ausable|Battenkill|Esopus/.test(y.template),
       "the Yakima still matches an eastern freestone at its latitude — that part was right", y.template);
    ok(y.gauge==="12484500", "and reads its own gauge", y.gauge);
    ok(y.bandSource==="own",
       "but its flow bands come from its own record, not from the analogue", y.bandSource);
    /* p25 and p75 for this date; the whole point is that 1,850 is ordinary. */
    ok(y.ideal[0]===1320 && y.ideal[1]===2400,
       "the daily range USGS has recorded for this river on this date", y.ideal);
    ok(y.state==="normal",
       "so 1,850 cfs is a normal September flow — it read Blown unscaled and Very low scaled by area",
       {cfs:y.cfs, label:y.label});
    ok(y.wadeMax>2400 && y.wadeMax<12000,
       "and the wading ceiling is in this river's units, not an Adirondack creek's", y.wadeMax);
    ok(/this river's own/.test(y.note[0]), "the card says where the bands came from", y.note[0]);

    const k=s.yak;
    ok(k.ranked[0]==="Red's Fly Shop",
       "sorted by what it is known for, the Yakima's shop is Red's", k.ranked);
    ok(k.nearest[0]!=="Red's Fly Shop" && k.nearest.includes("Red's Fly Shop"),
       "sorted by distance it is not first — which is the whole reason for the other sort", k.nearest);
    ok(k.report && /redsflyfishing\.com/.test(k.report.url) && k.report.name==="Red's Fly Shop",
       "and its river report is the one the Fish tab links to", k.report);
    ok(k.noReportWhereNoneWritten===null,
       "where no shop in the book writes one up, nothing is invented", k.noReportWhereNoneWritten);

    const p=k.pop;
    ok(p.thick > p.thin,
       "a 4.8 from six hundred people beats a 5.0 from three", p);
    ok(p.unrated===p.poorButRated,
       "an unreviewed shop is not ranked below a badly reviewed one — reviews give neither anything", p);
    ok(p.popularStranger > p.knownPlain,
       "and where Google has real numbers they can out-argue the hand-written list", p);
  },
  trip: (s)=>{
    const t=s.trip;
    ok(t.brief.ov===3 && t.brief.checked===2 && t.brief.plan && !t.brief.swept,
       "back after five minutes, nothing is touched — that is still the same afternoon", t.brief);
    ok(t.stale.ov===0 && t.stale.checked===0 && !t.stale.plan,
       "back after two days, last trip's water and shopping list are gone", t.stale);
    ok(t.stale.swept===3, "and the app says what it cleared rather than changing its mind quietly", t.stale);
    ok(t.stale.diary===1, "the diary is never swept — it is the record, not the session", t.stale);
    ok(t.held.ov===3 && t.held.checked===2 && !t.held.swept,
       "held for a trip, the same two-day gap changes nothing", t.held);
    ok(t.future.plan===true,
       "a day still ahead survives — that is a plan, not a leftover", t.future);
    ok(t.heldPersists===true, "and the hold outlives the tab", t.heldPersists);
    ok(t.homeWater.dropped===false && t.homeWater.spot===true,
       "a river you are standing beside is a home water, not a leftover", t.homeWater);
    ok(t.droveHome.dropped===true && t.droveHome.spot===false,
       "the one you drove four hundred miles to does not follow you home", t.droveHome);
    ok(/miles from where you are now/.test(t.droveHome.note),
       "and the notice says why it went", t.droveHome.note);
    ok(t.noLocation.dropped===false && t.noLocation.spot===true,
       "with location off there is nothing to judge on, so the river stays", t.noLocation);
  },
  meanonly: (s)=>{
    /* Not every gauge publishes percentiles. A daily mean is coarse, but it
       is still this river's water in this river's units, which beats another
       river's absolute cubic feet by a wide margin. */
    ok(s.miBands.source==="own",
       "a site with only a daily mean still gets bands of its own", s.miBands);
    ok(s.miBands.ideal[0]<620 && s.miBands.ideal[1]>620,
       "and 620 cfs sits inside them rather than reading as high water", s.miBands);
    ok(/coarse shape/.test(s.miBands.note),
       "the card says the shape is coarse rather than implying a record it does not have",
       s.miBands.note.slice(0,240));
  },
  calendar: (s)=>{
    const c=s.cal;
    eq(c.missing, [], "every hatch the truth table names is in the book");
    eq(c.notLiving, [], "and each one's range actually covers the river it is famous on");
    /* The whole point of anchoring: a species' dates are measured from where
       that species lives, not from a river on the far side of the continent.
       If this ever stops being true, the calendar has drifted back east. */
    ok(c.meanAnchored < c.meanLatOnly - 3,
       `anchored to where each insect lives, the peak lands ${(c.meanLatOnly-c.meanAnchored).toFixed(1)} days closer on average`,
       {anchored:c.meanAnchored, latOnly:c.meanLatOnly});
    ok(c.meanAnchored <= 13, "and within a fortnight of the truth across ten known hatches", c.meanAnchored);
    const by=(n,h)=>c.rows.find(r=>r.name===n && r.hatch===h);
    /* The three the Northeast-fitted regression got worst, and why this
       exists at all: a high southern tailwater, a river ten degrees north
       of the fitting set, and a Midwest fly with its own country. */
    ok(by("Bow R AB","Pale Morning Dun").anchored <= 10,
       "the Bow's PMDs come off in July, not the middle of August", by("Bow R AB","Pale Morning Dun"));
    ok(by("Madison MT","Western Green Drake").anchored <= 7,
       "the Madison's Green Drakes in early July", by("Madison MT","Western Green Drake"));
    ok(by("Au Sable MI","Hexagenia (Hex)").anchored <= 7,
       "and the Au Sable's Hex on the Fourth of July, where it belongs", by("Au Sable MI","Hexagenia (Hex)"));
    ok(by("Frying Pan CO","Western Green Drake").anchored < by("Frying Pan CO","Western Green Drake").latOnly,
       "the Frying Pan is closer than it was, though a deep-release tailwater still reads early",
       by("Frying Pan CO","Western Green Drake"));
    /* Anchoring is not free everywhere, and the file says so rather than
       hiding it: the salmonfly windows describe the whole West at once. */
    ok(by("Madison MT","Salmonfly").anchored === by("Madison MT","Salmonfly").latOnly,
       "salmonflies are deliberately left on the latitude model", by("Madison MT","Salmonfly"));
  },
  outofbook: (s)=>{
    const b=s.book;
    /* Every insect carries a range now, so a location gets whichever ones
       live there. Montana is the case that used to be switched off. */
    ok(b.montana.out===false && b.montana.hatches>0 && b.montana.plays===3,
       "a Montana river has a hatch chart and ranked plays, in June", b.montana);
    ok(b.montana.bugs.includes("salmonfly") && b.montana.bugs.includes("pmd"),
       "with the insects that actually live there", b.montana.bugs);
    ok(!b.montana.bugs.includes("hendrickson") && !b.montana.bugs.includes("quillgordon"),
       "and not the eastern ones, which do not", b.montana.bugs);
    ok(b.montana.sp==="trout" && b.montana.isGL===false,
       "read as trout water, not as whichever river happened to be least far", b.montana);

    ok(b.oregon.bugs.includes("wmarchbrown") || b.oregon.bugs.includes("wgreendrake")
       || b.oregon.bugs.includes("salmonfly"),
       "the Deschutes gets the western fauna too", b.oregon.bugs);
    ok(b.michigan.bugs.includes("hex") || b.michigan.bugs.includes("browndrake"),
       "and a Michigan river finally gets Hex and the Brown Drake", b.michigan.bugs);
    ok(!b.roscoe.bugs.includes("salmonfly") && !b.roscoe.bugs.includes("pmd"),
       "while a Catskill river gets none of the western ones", b.roscoe.bugs);
    ok(b.roscoe.out===false && b.roscoe.plays>0 && b.roscoe.hatches>0,
       "and still reads in full", b.roscoe);

    /* Each of these charts is genuinely different from the others. */
    const sets=[b.montana.bugs, b.oregon.bugs, b.roscoe.bugs, b.michigan.bugs];
    const pairs=[[0,2],[1,2],[3,0]];
    ok(pairs.every(([i,j])=>sets[i].some(x=>!sets[j].includes(x)) && sets[j].some(x=>!sets[i].includes(x))),
       "no two of these locations get the same chart", sets.map(x=>x.length));

    /* The gate still exists — it is answered by the species now. */
    ok(b.offmap.out===true && b.offmap.hatches===0 && b.offmap.plays===0,
       "somewhere no insect in the table reaches gets no chart at all", b.offmap);
    ok(/Outside the book/.test(s.bookUI.gate) && s.bookUI.says,
       "and the Fish tab says so in place of the plays", s.bookUI);
    ok(s.bookUI.plays===0 && !s.bookUI.eggs,
       "with nothing ranked, and no egg patterns anywhere on it", s.bookUI);
    ok(!s.bookUI.tactic && !s.bookUI.ladder,
       "no wade call either — those thresholds are the other river's", s.bookUI);
    ok(s.bookUI.tempCell==="\u2014",
       "and a modeled temperature is left blank rather than shown as a reading", s.bookUI.tempCell);
    ok(/No list for this water/.test(s.bookUI.shopHead),
       "the shop list says why it is empty", s.bookUI.shopHead);

    /* Same bug, other door: a phone in Bozeman used to open on a Lake Erie
       steelhead tributary. Species ranges do not fix that — Montana hatches
       now, so "does anything live here" is true and says nothing about
       whether that river is yours. Distance is what answers this one. */
    ok(s.settledOnLoad.geo, "the browser's location was actually read", s.settledOnLoad);
    ok(s.settledOnLoad.water!=="Conneaut Creek" && s.settledOnLoad.sp!=="steelhead",
       "a phone in Montana does not open on a steelhead river 1,554 miles away",
       s.settledOnLoad);
    eq(s.reach.refugesFromMontana, [],
       "and there is no colder water 'nearby' to offer from out there");
    ok(s.reach.refugesFromPenns.length>0 && s.reach.refugesFromPenns.every(d=>d<=150),
       "while inside the book it still names real ones, at a drivable distance",
       s.reach.refugesFromPenns);
  },

  slowshops: (s)=>{
    /* The mirrors used to be tried in turn on a 30 s timeout each, so a
       queued first host cost a full minute before the second was asked. */
    ok(s.shopCalls.length===2 && /kumi/.test((s.shopCalls[1]||{}).url||""),
       "a silent first mirror hands the query to the second", s.shopCalls.map(c=>c.url));
    ok(s.shops.names.length===3, "and the shops still arrive", s.shops.names);
    ok(s.shopMs < 9000, `without waiting out the wedged host (${s.shopMs} ms)`, s.shopMs);
  },
  places: (s)=>{
    /* OpenStreetMap is a map of the landscape, not a business directory.
       The shops on this river are in a directory and not in the map, so
       the directory answers first where one is configured. */
    const dir=s.shops.all.filter(x=>!x.known || /West Branch Angler|Cross Current/.test(x.name));
    ok(dir.some(x=>x.name==="West Branch Angler") && dir.some(x=>x.name==="Cross Current Outfitters"),
       "the directory's shops are what the tab lists", dir.map(x=>x.name));
    ok(!s.shops.all.some(x=>/^Beaverkill Angler$/.test(x.name)),
       "and OpenStreetMap is not asked at all when it answers", s.shops.all.map(x=>x.name));
    /* The West Branch Angler is in the directory AND hand-written, so it
       carries the mark without being listed twice. */
    ok(s.shops.all.filter(x=>x.name==="West Branch Angler").length===1,
       "a shop in both the directory and the book appears once", s.shops.all.map(x=>x.name));
    ok(s.shops.links.some(l=>l.some(h=>/google\.com\/maps/.test(h))),
       "the directory rows carry somewhere to go", s.shops.links);
    ok(s.shops.links.every(l=>l.every(h=>/^(https?:|tel:)/.test(h))),
       "and every href is still one the app built or vetted", s.shops.links);
    ok(s.shops.guide, "the guide card is unaffected by where the shops came from");
  },
  slowbutok: (s)=>{
    /* Cutting the client off after 12 s while the query is allowed 25 s
       server-side turned a slow answer into an empty shop list. */
    ok(s.shops.names.length===3, "a slow Overpass is waited for, not abandoned", s.shops.names);
    ok(s.shopMs >= 6500, `and it really was slow (${s.shopMs} ms)`, s.shopMs);
  },
  plays: (s)=>{
    const p=s.plays4, has=(r,k)=>r.all.includes(k);
    ok(p.keys.length===17, "the book carries seventeen plays", p.keys.length);
    eq(p.unmapped, [], "and the diary can weight every one of them");

    // --- after dark ---
    ok(p.mouseNight.lw==="night", "23:00 in July reads as night", p.mouseNight.lw);
    ok(has(p.mouseNight,"mouse"), "a mouse is on the table after dark in July", p.mouseNight.all);
    ok(p.mouseNight.top.includes("mouse"),
       "and it is one of the three shown — nothing else was answering the dark", p.mouseNight.top);
    ok(!has(p.mouseNoon,"mouse"), "but not at one in the afternoon", p.mouseNoon.all);
    ok(!has(p.mouseWinter,"mouse"), "and not on a January night", p.mouseWinter.all);
    ok(!has(p.mouseSmall,"mouse"),
       "nor on a creek too small to swim one", p.mouseSmall.all);

    // --- the river up ---
    ok(has(p.highUp,"highwater"), "high water gets its own play", p.highUp.all);
    ok(p.highUp.top.includes("highwater"), "and it leads with the river up", p.highUp.top);
    ok(has(p.highBlown,"highwater"), "a blown river is still the edges, not a lost day", p.highBlown.all);
    ok(!has(p.highNorm,"highwater"), "at normal flow it stays out of the way", p.highNorm.all);

    // --- crustaceans, on the day nothing hatches ---
    ok(has(p.scudLime,"crustacean"), "February on the limestone is scud water", p.scudLime.all);
    ok(p.scudLime.top.includes("crustacean"),
       "and with no hatch on, that is what it says to fish", p.scudLime.top);
    ok(has(p.scudTail,"crustacean"), "a bottom-release tailwater grows them too", p.scudTail.all);
    ok(!has(p.scudFree,"crustacean"),
       "a Catskill freestone does not, and is not told it does", p.scudFree.all);

    // --- low and clear ---
    ok(has(p.sightLow,"sight"), "low, gin-clear and bright is sight-fishing", p.sightLow.all);
    ok(p.sightLow.top.includes("sight"), "and it is worth the top three there", p.sightLow.top);
    ok(!has(p.sightMuddy,"sight"), "you cannot hunt fish you cannot see", p.sightMuddy.all);
    ok(!has(p.sightHigh,"sight"), "and not with the river up", p.sightHigh.all);
    ok(!has(p.sightDark,"sight"), "nor in the dark", p.sightDark.all);

    // --- and none of it leaks onto a steelhead river ---
    eq(p.gl.all.filter(k=>["mouse","highwater","crustacean","sight"].includes(k)), [],
       "no trout play reaches a Great Lakes tributary");
    ok(p.gl.all.every(k=>k.startsWith("gl-")), "which still runs only its own four", p.gl.all);

    ok(s.violations.length===0, "no Content-Security-Policy violations", s.violations);
    ok(s.errors.length===0, "no console or page errors", s.errors);
  },

  named: (s)=>{
    const n=s.named;
    ok(n.count>=200, "the app knows a couple of hundred rivers, not a book of 27", n.count);
    ok(n.nStates>=25, "spread across the country rather than one corner of it", n.nStates);
    eq(n.invented, [], "and not one of them carries a gauge, band or curve nobody verified");
    eq(n.incomplete, [], "every one has a name, a place, a point and a fishery");
    eq(n.badSp, [], "and a fishery Riffle actually models");
    eq(n.dupes, [], "no river listed twice");
    eq(n.offMap, [], "none of them off the map");
    eq(n.wrongSp, [], "every one resolves to a template of its own fishery");
    ok(n.both>=30, "and the rivers that are both trout and steelhead are marked as both", n.both);
  },

  michigan: (s)=>{
    const p=s.pheno;
    ok(p.mean<=1.5, "the computed shift lands within a day and a half of the hand-written 27", p.mean);
    ok(p.worst.off<=4, "and never more than four days off any one of them", p.worst);
    eq(p.over4, [], "no river the formula gets badly wrong");
    ok(p.baldwin>=7 && p.baldwin<=12,
       "Baldwin runs a week to a fortnight behind the Beaverkill", p.baldwin);
    ok(p.letort<=-9, "and the Letort runs well ahead of it", p.letort);
    // ranges live on the species now, so each place gets its own set of insects
    const L=p.lives;
    ok(L.baldwin.includes("hex"), "Hex reaches Michigan, which is most of its June", L.baldwin.length);
    ok(!L.ozark.includes("hex"), "and not the Ozarks", L.ozark.length);
    ok(L.bozeman.includes("salmonfly") && L.bozeman.includes("pmd"),
       "Montana gets the salmonfly and the PMD", L.bozeman);
    ok(!L.bozeman.includes("hendrickson") && !L.baldwin.includes("salmonfly"),
       "and neither place gets the other's insects", {mt:L.bozeman.length, mi:L.baldwin.length});
    ok(L.baldwin.includes("midge") && L.bozeman.includes("midge") && L.ozark.includes("midge"),
       "while what really does live everywhere is written once and reaches all of them", true);
    /* Michigan, the Ozarks and Montana are three different faunas. The
       Driftless is deliberately not in that list — it shares Michigan's,
       which is the correct answer and the reason ranges beat regions. */
    const distinct=["baldwin","ozark","bozeman"].map(k=>L[k].slice().sort().join(","));
    ok(new Set(distinct).size===3,
       "Michigan, the Ozarks and Montana each get their own chart",
       {mi:L.baldwin.length, oz:L.ozark.length, mt:L.bozeman.length});
    ok(L.driftless.slice().sort().join(",")===L.baldwin.slice().sort().join(","),
       "and the Driftless shares Michigan's, because it really does", L.driftless.length)

    /* The question this whole card exists to answer. Ask anyone where you
       catch trout and steelhead near Baldwin and you get these three. */
    ok(/Trout and steelhead near Baldwin/.test(s.mi.head), "the card asks the right question", s.mi.head);
    ok(s.mi.src==="named", "and answers it from named rivers, without asking the network", s.mi.src);
    const named=s.mi.rivers.join(" | ");
    ok(/Pere Marquette/.test(named), "the Pere Marquette is on the list", named);
    ok(/Manistee/.test(named), "so is the Manistee", named);
    ok(/Muskegon/.test(named), "and the Muskegon", named);
    ok(s.mi.rivers[0]==="Pere Marquette River", "nearest first, and Baldwin's own river leads", s.mi.rivers);
    ok(s.mi.rivers.length>=6, "with the rest of the country around it", s.mi.rivers.length);
    ok(new Set(s.mi.rivers.map((n,i)=>n+s.mi.subs[i])).size===s.mi.rivers.length,
       "no river listed twice", s.mi.rivers);
    ok(s.mi.subs.filter(t=>/Trout & steelhead/.test(t)).length>=3,
       "the Michigan rivers are marked as both, which is what they are", s.mi.subs);

    ok(s.miPick.name==="Pere Marquette River" && /Baldwin/.test(s.miPick.place),
       "picking one reads that river", s.miPick);
    ok(s.miPick.sp==="trout" && s.miPick.tmplSp==="trout",
       "as trout water by default, borrowed from a trout river", s.miPick);
    ok(s.miPick.both, "and it knows the river is also a run", s.miPick);
    ok(s.miPick.gauge && /^\d{8}$/.test(String(s.miPick.gauge)),
       "with a real USGS gauge found for it at runtime", s.miPick.gauge);
    ok(s.miPick.latGap<=1.6, "matched to a river at nearly its own latitude", s.miPick);
    ok(s.miPick.shift>=7 && s.miPick.shift<=12,
       "and its calendar resolved for that latitude, a good week later than Catskill water", s.miPick);
    ok(!s.miPick.beyond && !s.miPick.out,
       "and it is a reading, not a gate — this is the case that used to fail", s.miPick);
    ok(s.miPick.saysGauge, "the card says which gauge it actually read", s.miPick);
    /* The report that started this: the Pere Marquette read 620 cfs as HIGH
       and ranked the high-water play first, because its bands were an
       Adirondack freestone's. They are its own now. */
    ok(s.miBands.source==="own",
       "the Pere Marquette's flow bands are its own record, not an analogue's", s.miBands);
    eq(s.miBands.ideal, [574,812],
       "the range USGS has recorded for this river on this date");
    ok(s.miBands.state==="normal",
       "so 620 cfs is a normal September flow, not high water", s.miBands);
    ok(!s.miBands.plays.some(k=>/highwater/.test(k)),
       "and the high-water play is not what it opens with", s.miBands.plays);
    /* The card led with a river six hundred miles away, which made the whole
       reading look like somebody else's. */
    ok(/^Flow and water temperature are read from USGS/.test(s.miBands.note),
       "the card leads with the gauge it actually reads", s.miBands.note.slice(0,90));
    ok(s.miBands.note.indexOf("USGS") < s.miBands.note.indexOf("Ausable"),
       "and names the analogue after it, for the one thing it still supplies",
       s.miBands.note.slice(0,240));
    ok(s.statCalls.length>0 && s.statCalls.every(u=>/statTypeCd=all\b/.test(u)),
       "the statistics request asks for a kind of statistic, not for percentile names",
       s.statCalls[0]);
    ok(s.miPick.saysOwnCalendar && !s.miPick.namesElsewhere,
       "and calls the hatch calendar this river's own, naming no other river", s.miPick);

    ok(s.miMay.hatches>0 && s.miMay.plays.length===3,
       "in May it has a hatch chart and three ranked plays", s.miMay);
    ok(!s.miMay.plays.some(k=>k.startsWith("gl-")), "none of them a steelhead play", s.miMay.plays);

    ok(s.miGL.sp==="steelhead" && s.miGL.isGL && s.miGL.name==="Pere Marquette River",
       "and one tap re-reads the same river as a steelhead run", s.miGL);
    ok(s.miGL.plays.every(k=>k.startsWith("gl-")),
       "which is a different set of plays entirely", s.miGL.plays);

    // --- each river's chart is its own ---
    const h=s.miHatch;
    ok(/Pere Marquette/.test(h.pm.intro), "the hatch panel names the river whose chart it is", h.pm.intro);
    ok(!/Catskill|Beaverkill|baseline|shifted/i.test(h.pm.text),
       "and describes it in no terms but its own", h.pm.intro);
    ok(!/Catskill|Beaverkill|baseline|shifted/i.test(h.letort.text),
       "on any river, including one in the book", h.letort.intro);
    ok(h.pm.dated.length>0 && h.pm.dated.every(t=>/[A-Z][a-z]{2} \d+ . [A-Z][a-z]{2} \d+/.test(t)),
       "every insect on now carries this river's own window", h.pm.dated.slice(0,3));
    const moved=Object.keys(h.pm.wins).filter(k=>h.pm.wins[k]!==h.letort.wins[k]);
    ok(moved.length>=15,
       "and the same insects sit on different dates on a different river", moved.length);
    ok(h.pm.wins["hendrickson"]>h.letort.wins["hendrickson"],
       "Michigan's Hendricksons run later than Pennsylvania's, which is the point",
       {pm:h.pm.wins["hendrickson"], letort:h.letort.wins["hendrickson"]});

    ok(s.violations.length===0, "no Content-Security-Policy violations", s.violations);
    ok(s.errors.length===0, "no console or page errors", s.errors);
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

console.log("\n  content security policy");
{
  ok(REFUSAL_WORDINGS.every(isHandlerRefusal),
     "the refusal matcher recognises both browsers' wording of a blocked handler");
  ok(!isHandlerRefusal(`Refused to load the image 'x' because it violates the following Content Security Policy directive: "img-src 'self'".`),
     "and does not swallow an unrelated policy violation");
  const want = scriptHash(), have = policyHash();
  ok(want===have,
     "the sealed script hash matches index.html — run 'npm run seal' if this fails",
     {policy:have, actual:want});
  ok(!/script-src[^;]*'unsafe-inline'/.test(csp),
     "script-src does not allow arbitrary inline script", csp.match(/script-src[^;]*/)?.[0]);
  for(const d of ["base-uri 'self'","form-action 'none'","frame-ancestors 'none'","object-src 'none'"]){
    ok(csp.includes(d), `policy keeps ${d}`);
  }
  const pp = readFileSync(TOML,"utf8").match(/Permissions-Policy = "([^"]+)"/)[1];
  ok(/geolocation=\(self\)/.test(pp), "the app's own geolocation is not disabled by policy", pp);
  ok(/camera=\(\)/.test(pp) && /microphone=\(\)/.test(pp), "camera and microphone stay off", pp);
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
    ok(seen.spotCleared && seen.afterBook==="Willowemoc Creek",
       "choosing a water from the book clears the spot", seen.afterBook);
  }
} finally {
  await browser.close();
  server.close();
}

console.log(`\n  ${checks-failures}/${checks} checks passed\n`);
process.exit(failures ? 1 : 0);
