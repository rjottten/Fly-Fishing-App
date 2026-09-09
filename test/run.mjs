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

async function mock(page, scenario){
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
      shopCalls.push(r.request().url());
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
  await page.route("**://waterservices.usgs.gov/nwis/iv/**", r=>r.fulfill(json(F.IV)));

  await page.route("**://waterservices.usgs.gov/nwis/site/**", r => {
    const bbox = r.request().url().includes("bBox=");
    if(scenario==="michigan") return r.fulfill(rdbOf(bbox ? F.MI_SITES : [F.SITE_PM_UP, F.SITE_BEAVERKILL]));
    if(scenario==="scaled")  return r.fulfill(rdbOf(bbox ? [F.SITE_LITTLE] : [F.SITE_LITTLE, F.SITE_BEAVERKILL]));
    if(scenario==="noarea")  return r.fulfill(rdbOf([F.SITE_LITTLE_NOAREA]));
    return r.fulfill(rdbOf(bbox ? [F.SITE_BEAVERKILL, F.SITE_LITTLE] : [F.SITE_BEAVERKILL, F.SITE_WBD]));
  });
}

const XSS = `<img src=x onerror="window.__xss=(window.__xss||0)+1">`;
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
  const errors = [], violations = [], refusals = [];
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
    else if(m.type()==="error" && !/favicon|ERR_|504|404/.test(t)) errors.push("console: " + t);
  });
  await mock(page, scenario);

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

  // the book re-sorts around the searched point, not the device location
  seen.nearHead = await page.$eval("#nearWaters h3", n=>n.textContent.trim());
  seen.nearFirst = await page.$$eval("#nearWaters .wbtn .wn",
    ns=>ns.slice(0,3).map(n=>n.childNodes[0].textContent.trim()));
  seen.nearOpen = await page.$$eval("#nearWaters .wbtn", ns=>ns.length);
  await page.click("#nearMore");
  seen.nearOrdered = await page.$$eval("#nearWaters .wbtn .wd",
    ns=>ns.map(n=>parseInt(n.textContent,10)));
  /* Read the total off the app rather than pinning an integer here: the
     book grows, and a test that has to be edited every time it does is a
     test that gets edited without being read. */
  seen.waterRows = await page.evaluate(()=>WATERS.length + NAMED.length);
  await page.click("#nearLess");
  seen.nearCollapsed = await page.$$eval("#nearWaters .wbtn", ns=>ns.length);
  await page.click("#nearMore");        // open, so the water switch below can reach Penns

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
  await page.click('#nearWaters .wbtn[data-w="penns"]');
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
    const near=document.getElementById("nearWaters");
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
  await reachPass(page, seen);

  if(scenario==="diary") await diaryPass(page, seen);
  if(scenario==="plan")  await planPass(page, seen);
  if(scenario==="security") await securityPass(page, seen);
  if(scenario==="outofbook") await outOfBookPass(page, seen);
  if(scenario==="plays") await playsPass(page, seen);
  if(scenario==="named") await namedPass(page, seen);
  if(scenario==="michigan") await michiganPass(page, seen);

  seen.errors = errors; seen.violations = violations; seen.refusals = refusals;
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
      note: card.textContent.match(/\d+ more (?:is|are) mapped further out/)?.[0] || "",
      ql: (typeof shopQL!=="undefined") ? shopQL(41.9337,-74.9143,40000) : "",
      findMore: !!card.querySelector('a[href*="q="]'),
      // ranking and URL vetting are data concerns; the cap is a rendering one
      all: (typeof state!=="undefined" ? state.shops.list : []).map(x=>({name:x.name, site:x.site, tel:x.tel})),
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
              latGap:Math.round(t.latGap*10)/10, east:inEast(lat,lon)}; };
    const read=(lat,lon,name)=>{
      const t=templateFor(lat,lon);
      state.spot=spotProfile({lat,lon,name}, t.w, t.dist, null, NaN, t.latGap);
      state.when=new Date(2026,4,20,14,0);                 // 20 May, peak hatch season
      const ctx=buildContext();
      return {miles:ctx.templateMiles, out:ctx.outOfBook, isGL:ctx.isGL, sp:ctx.w.sp,
              hatches:activeHatches(ctx).length, plays:recommend(ctx).picked.length};
    };
    const out={
      nearest:{bozeman:at(45.677,-111.043), boise:at(43.615,-116.202)},
      montana: read(45.677,-111.043,"Gallatin River"),
      roscoe:  read(41.9337,-74.9143,"Beaverkill"),
      edge:    read(40.7934,-77.86,"Spring Creek"),
    };
    state.spot=null; state.when=new Date();
    return out;
  });

  // and what the angler is actually shown out there
  seen.bookUI = await page.evaluate(()=>{
    const t=templateFor(45.677,-111.043);
    state.spot=spotProfile({lat:45.677,lon:-111.043,name:"Gallatin River"}, t.w, t.dist, null, NaN);
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

/* The named waters are the half of the book that is deliberately not
   written down: a name and a point, with the gauge, the bands and the
   calendar all resolved at the moment you tap one. That only stays
   honest if two things hold — that no entry smuggles in numbers nobody
   verified, and that the water it borrows its calendar from is the same
   kind of fishery it is. Both are checked here, and the second is
   checked on the entry that would have got it wrong. */
async function namedPass(page, seen){
  seen.named = await page.evaluate(()=>{
    const ids=new Set(WATERS.map(w=>w.id));
    const invented = NAMED.filter(w=>w.gauge||w.flow||w.wade||w.temps||w.shift!=null);
    const incomplete = NAMED.filter(w=>!w.name||!w.place||!isFinite(w.lat)||!isFinite(w.lon)||!w.sp);
    const collide = NAMED.filter(w=>ids.has(w.id));
    const dupes = NAMED.map(w=>w.name).filter((n,i,a)=>a.indexOf(n)!==i);

    /* Every named water has to sit inside the book's reach of a written
       water of its own species, or the hatch chart it borrows is fiction. */
    const reach = NAMED.map(w=>{
      const {w:t, dist} = templateFor(w.lat, w.lon, w.sp);
      return {name:w.name, tmpl:t.name, sp:t.sp, mi:Math.round(dist/1609.34)};
    });

    /* Oatka Creek is a western New York trout stream 29 miles from Oak
       Orchard, a steelhead tributary, and 139 from the nearest written
       trout water. Nearest-of-all would hand it a steelhead calendar. */
    const oatka = NAMED.find(w=>/Oatka/.test(w.name));
    return {
      count: NAMED.length, invented:invented.map(w=>w.name), incomplete:incomplete.map(w=>w.name),
      collide:collide.map(w=>w.id), dupes,
      worst: reach.reduce((a,b)=>b.mi>a.mi?b:a, reach[0]),
      wrongSp: reach.filter(r=>r.sp!=="trout").map(r=>r.name),
      blind:  oatka ? templateFor(oatka.lat, oatka.lon).w : null,
      keyed:  oatka ? templateFor(oatka.lat, oatka.lon, oatka.sp).w : null,
    };
  });

  // and the row itself, tapped the way a person taps it
  await page.click("#tab-plan");
  await page.waitForSelector("#nearWaters .wbtn");
  await page.evaluate(()=>{ state.nearAll=true; draw(); });
  await page.waitForSelector('#nearWaters .wbtn[data-named]');
  seen.namedUI = await page.evaluate(()=>({
    rows: document.querySelectorAll('#nearWaters .wbtn[data-named]').length,
    label: !!document.querySelector('#nearWaters .wbtn[data-named] .wt'),
    note: /read live/i.test(document.getElementById("nearWaters").textContent),
  }));
  const row = await page.$('#nearWaters .wbtn[data-named]');
  seen.namedUI.rowName = (await row.$eval(".wn", n=>n.childNodes[0].textContent.trim()));
  await row.click();
  await page.waitForFunction(()=>!!state.spot, {timeout:10000}).catch(()=>{});
  seen.namedPick = await page.evaluate(()=>{
    const w=water();
    return {name:w.name, sp:w.sp, isSpot:!!w.spot, gauge:w.gauge,
            tmpl:w.spot&&w.spot.template.name, tmplSp:w.spot&&w.spot.template.sp,
            saysGauge:/USGS \d/.test(w.note||""), saysBorrowed:/modeled on/.test(w.note||""),
            beyond:!!w.beyond};
  });
  await page.evaluate(()=>{ state.spot=null; state.nearAll=false; draw(); });
}

/* Baldwin, Michigan. Under the old model this was the whole failure in one
   place: the nearest of the 27 was a Lake Erie steelhead creek 298 miles
   away, so the pin inherited a steelhead fishery and was then gated out for
   being too far — wrong analogue, and no reading either way. It is the
   worked example for every part of the new path: pick a location, get the
   rivers that are actually there, choose one, and have its gauge be what
   the plays read. */
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
            east:{baldwin:inEast(43.90,-85.85), driftless:inEast(43.60,-90.85),
                  ozark:inEast(36.30,-93.20), bozeman:inEast(45.68,-111.04),
                  gallatinLon:inEast(43.90,-111.04)}};
  });

  await page.click("#tab-plan");
  await page.waitForSelector("#findQ");
  await page.evaluate(()=>{ state.spot=null; });
  await page.evaluate(()=>setPin(43.9022, -85.8517, "Baldwin, Lake County, Michigan"));
  await page.waitForSelector("#riverCard .rvbtn", {timeout:10000});

  seen.mi = await page.evaluate(()=>({
    head: (document.querySelector("#riverCard h3")||{}).textContent,
    rivers: [...document.querySelectorAll("#riverCard .rvbtn .wn")].map(n=>n.childNodes[0].textContent.trim()),
    gauges: [...document.querySelectorAll("#riverCard .rvbtn")].map(b=>b.dataset.g),
    subs: [...document.querySelectorAll("#riverCard .rvbtn .wt")].map(n=>n.textContent.trim()),
    glOffered: !!document.getElementById("rvSp"),
    glText: (document.getElementById("rvSp")||{}).textContent,
  }));

  // pick the top river and see what the plays are actually reading
  await page.click("#riverCard .rvbtn");
  await page.waitForFunction(()=>!!state.spot, {timeout:10000}).catch(()=>{});
  seen.miPick = await page.evaluate(()=>{
    const w=water(), ctx=buildContext();
    return {name:w.name, sp:w.sp, gauge:w.gauge, tmpl:w.spot.template.name, tmplSp:w.spot.template.sp,
            latGap:w.latGap, shift:w.shift, beyond:!!w.beyond, out:ctx.outOfBook,
            hatches:activeHatches(ctx).length, plays:recommend(ctx).picked.length,
            saysGauge:/USGS 041/.test(w.note||""), saysShift:/day/.test(w.note||"")};
  });
  // and in May, when the calendar has to be doing real work
  seen.miMay = await page.evaluate(()=>{
    const keep=state.when;
    state.when=new Date(2026,4,20,14,0);
    const ctx=buildContext();
    const out={hatches:activeHatches(ctx).length, plays:recommend(ctx).picked.map(p=>p.key),
               top:(activeHatches(ctx)[0]||{}).hx, temp:Math.round(ctx.temp)};
    state.when=keep;
    return {hatches:out.hatches, plays:out.plays, top:out.top?out.top.name:null, temp:out.temp};
  });
  // the fishery is the angler's call, never the app's
  await page.click("#rvSp");
  await page.waitForFunction(()=>water().sp==="steelhead", {timeout:10000}).catch(()=>{});
  seen.miGL = await page.evaluate(()=>{
    const w=water();
    return {sp:w.sp, tmplSp:w.spot.template.name && w.spot.template.sp, gauge:w.gauge};
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
    ok(s.nearHead==="Nearest waters to Roscoe", "the book re-sorts around the point you searched", s.nearHead);
    eq(s.nearFirst, ["Beaverkill","Willowemoc Creek","East Branch Delaware"],
       "and lists the Catskill waters around Roscoe first");
    ok(s.nearOpen<=9, "only the near end of the book is open, so the map is not buried", s.nearOpen);
    ok(s.nearOrdered.length===s.waterRows && s.nearOrdered.every((d,i,a)=>i===0||d>=a[i-1]),
       "and one tap opens every water Riffle knows, nearest first",
       {shown:s.nearOrdered.length, known:s.waterRows});
    ok(s.nearCollapsed===s.nearOpen, "and another folds it back", {open:s.nearOpen, back:s.nearCollapsed});
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
    eq(s.tabOrder, ["Plan","Fish","Shop","Report"],
       "four tabs: Plan leads them and Report closes them");
    ok(s.onRiverChips>0, "the condition chips live on the Report tab", s.onRiverChips);
    eq(s.onRiverGroups, ["Barometer","Flow","Clarity","Sky"], "all four condition groups moved with them");
    ok(s.reportHasBoth, "which carries what you can see and what came of it, in one place", s.reportHasBoth);
    ok(!s.strayControls, "nothing is left under the dashboard");
    ok(s.shops.all.length===8 && !s.shops.all.some(x=>!x.name),
       "every shop that reads as a fly shop is ranked, and an unnamed one is not a shop",
       s.shops.all.map(x=>x.name));
    ok(s.shops.names.length===3 && s.shops.names[0]==="Beaverkill Angler",
       "the nearest three are listed, nearest first — past that it is a directory", s.shops.names);
    ok(/5 more are mapped further out/.test(s.shops.note),
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
    ok(s.shopCalls.length===1,
       "the counters cost one query, not a near one and then a wide one", s.shopCalls.length);
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
    ok(s.stored.water==="Penns Creek", "logged against the water on screen", s.stored.water);
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
    ok(s.reloadPct.penns>=12, "and still lean the plays hard on the next visit", s.reloadPct);
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
  outofbook: (s)=>{
    /* The analogue is chosen on climate now, so Bozeman gets a trout freestone
       at nearly its own latitude rather than the least-far river of any kind.
       That is the right analogue — and it is still not a reading, because the
       gate is about which insects live there, not how far the analogue sits. */
    ok(s.book.nearest.bozeman.sp==="trout" && s.book.nearest.bozeman.latGap<1.5,
       "Montana matches a trout river at its own latitude, not the least-far one",
       s.book.nearest.bozeman);
    ok(s.book.nearest.bozeman.east===false,
       "and it is still outside the range of the book's insects", s.book.nearest.bozeman);
    ok(s.book.montana.out===true, "so that pin is marked outside the book", s.book.montana);
    ok(s.book.montana.sp!=="steelhead" && s.book.montana.isGL===false,
       "and does not inherit the fishery of whichever river happened to be least far", s.book.montana);
    ok(s.book.montana.hatches===0 && s.book.montana.plays===0,
       "no hatch chart and no plays, in the middle of May", s.book.montana);
    ok(s.book.roscoe.out===false && s.book.roscoe.plays>0 && s.book.roscoe.hatches>0,
       "a water in the book still reads in full", s.book.roscoe);
    ok(s.book.edge.out===false && s.book.edge.plays>0,
       "and so does one a few miles off it", s.book.edge);
    ok(/Outside the book/.test(s.bookUI.gate) && s.bookUI.says,
       "the Fish tab says so in place of the plays", s.bookUI);
    ok(s.bookUI.plays===0 && !s.bookUI.eggs,
       "with nothing ranked, and no egg patterns anywhere on it", s.bookUI);
    ok(!s.bookUI.tactic && !s.bookUI.ladder,
       "no wade call either — those thresholds are the other river's", s.bookUI);
    ok(s.bookUI.tempCell==="\u2014",
       "and a modeled temperature is left blank rather than shown as a reading", s.bookUI.tempCell);
    ok(/No list for this water/.test(s.bookUI.shopHead),
       "the shop list says why it is empty", s.bookUI.shopHead);

    /* Same bug, other door: the device-location path never asked the
       distance question, so this browser — sitting in Bozeman — opened
       on a Lake Erie steelhead tributary with its run and chart intact. */
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
    ok(s.shopCalls.length===2 && /kumi/.test(s.shopCalls[1]||""),
       "a silent first mirror hands the query to the second", s.shopCalls);
    ok(s.shops.names.length===3, "and the shops still arrive", s.shops.names);
    ok(s.shopMs < 9000, `without waiting out the wedged host (${s.shopMs} ms)`, s.shopMs);
  },
  places: (s)=>{
    /* OpenStreetMap is a map of the landscape, not a business directory.
       The shops on this river are in a directory and not in the map, so
       the directory answers first where one is configured. */
    eq(s.shops.names, ["West Branch Angler","Cross Current Outfitters"],
       "the directory's shops are what the tab lists, nearest first");
    ok(!s.shops.all.some(x=>/Beaverkill Angler/.test(x.name)),
       "and OpenStreetMap is not asked at all when it answers", s.shops.all.map(x=>x.name));
    ok(s.shops.links[0].some(h=>/google\.com\/maps/.test(h)),
       "each carries somewhere to go", s.shops.links[0]);
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
    ok(n.count>=40, "the named waters roughly triple what the list reaches", n.count);
    eq(n.invented, [], "and not one of them carries a gauge, band or curve nobody verified");
    eq(n.incomplete, [], "every one has a name, a place, a point and a fishery");
    eq(n.collide, [], "and none of them shadows a water in the written book");
    eq(n.dupes, [], "no river is listed twice");

    ok(n.worst.mi<=250, "the furthest one is still inside the book's reach", n.worst);
    eq(n.wrongSp, [], "and every one borrows from a trout water, not a steelhead run");

    /* The bug this rule exists for, pinned on the entry that has it. */
    ok(n.blind && n.blind.sp==="steelhead",
       "nearest-of-all would put Oatka Creek on a steelhead river", n.blind && n.blind.name);
    ok(n.keyed && n.keyed.sp==="trout",
       "asking for its own fishery gets a trout one instead", n.keyed && n.keyed.name);

    ok(s.namedUI.rows>0, "the read-live rows are in the same list as the book", s.namedUI);
    ok(s.namedUI.note, "with a line saying what read-live means", s.namedUI);

    ok(s.namedPick.isSpot, "tapping one reads it as a spot rather than a book water", s.namedPick);
    ok(s.namedPick.name===s.namedUI.rowName,
       "and it reads the river whose row was tapped", {got:s.namedPick.name, row:s.namedUI.rowName});
    ok(s.namedPick.sp==="trout" && s.namedPick.tmplSp==="trout",
       "on a trout calendar, borrowed from a trout river", s.namedPick);
    ok(!s.namedPick.beyond, "inside the book, so the plays and the hatch chart stay on", s.namedPick);
    ok(s.namedPick.saysGauge, "the card names the gauge it actually found", s.namedPick);
    ok(s.namedPick.saysBorrowed, "and which written water it borrowed from", s.namedPick);

    ok(s.violations.length===0, "no Content-Security-Policy violations", s.violations);
    ok(s.errors.length===0, "no console or page errors", s.errors);
  },

  michigan: (s)=>{
    const p=s.pheno;
    // the formula against the 27 values it replaced
    ok(p.mean<=1.5, "the computed shift lands within a day and a half of the hand-written 27", p.mean);
    ok(p.worst.off<=4, "and never more than four days off any one of them", p.worst);
    eq(p.over4, [], "no river the formula gets badly wrong");
    ok(p.baldwin>=7 && p.baldwin<=12,
       "Baldwin runs a week to a fortnight behind the Beaverkill", p.baldwin);
    ok(p.letort<=-9, "and the Letort runs well ahead of it", p.letort);

    // the gate is a range now, not a radius
    ok(p.east.baldwin && p.east.driftless && p.east.ozark,
       "Michigan, the Driftless and the Ozarks are all inside the book's insects", p.east);
    ok(!p.east.bozeman && !p.east.gallatinLon,
       "Montana is not, at any latitude", p.east);

    // the list, from USGS, for a town nobody wrote down
    ok(/Baldwin/.test(s.mi.head), "the card names the place you searched", s.mi.head);
    ok(s.mi.rivers.length>=3, "and lists the gauged rivers around it", s.mi.rivers);
    ok(s.mi.rivers[0]==="Pere Marquette River",
       "nearest first, with the river's name and not the gauge's", s.mi.rivers);
    ok(new Set(s.mi.rivers).size===s.mi.rivers.length,
       "one row per river, not one per gauge", s.mi.rivers);
    ok(!s.mi.rivers.some(n=>/Unnamed Drain/i.test(n)),
       "and a three-square-mile ditch is not a fishery", s.mi.rivers);
    ok(s.mi.subs.every(t=>/^USGS \d/.test(t)), "every row shows the gauge behind it", s.mi.subs);
    ok(s.mi.glOffered && /Great Lakes run/i.test(s.mi.glText||""),
       "a Great Lakes run is offered here, not assumed", s.mi);

    // what picking one actually reads
    ok(s.miPick.name==="Pere Marquette River",
       "picking a river reads that river", s.miPick);
    ok(s.miPick.gauge===s.mi.gauges[0],
       "on the gauge that row named, not whichever was nearest the pin", s.miPick);
    ok(s.miPick.sp==="trout" && s.miPick.tmplSp==="trout",
       "as trout water, borrowed from a trout river", s.miPick);
    ok(s.miPick.latGap<=1.6,
       "matched to a river at nearly its own latitude", s.miPick);
    ok(s.miPick.shift>=7 && s.miPick.shift<=12,
       "with the calendar moved for that latitude", s.miPick);
    ok(!s.miPick.beyond && !s.miPick.out,
       "and it is a reading, not a gate — this is the case that used to fail", s.miPick);
    ok(s.miPick.saysGauge && s.miPick.saysShift,
       "the card says which gauge it read and how far it moved the calendar", s.miPick);

    ok(s.miMay.hatches>0 && s.miMay.plays.length===3,
       "in May it has a hatch chart and three ranked plays", s.miMay);
    ok(!s.miMay.plays.some(k=>k.startsWith("gl-")),
       "none of them a steelhead play", s.miMay.plays);

    ok(s.miGL.sp==="steelhead" && s.miGL.gauge===s.mi.gauges[0],
       "and saying it is a run re-reads the same gauge as steelhead water", s.miGL);

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
    ok(seen.spotCleared && seen.afterBook==="Penns Creek",
       "choosing a water from the book clears the spot", seen.afterBook);
  }
} finally {
  await browser.close();
  server.close();
}

console.log(`\n  ${checks-failures}/${checks} checks passed\n`);
process.exit(failures ? 1 : 0);
