import { chromium } from "playwright-core";
import { readFileSync, readdirSync } from "node:fs";
import http from "node:http";
import * as F from "./fixtures.mjs";
const ROOT="/home/user/Fly-Fishing-App", PORT=8877;
const dir=readdirSync("/opt/pw-browsers").filter(d=>/^chromium-\d+$/.test(d)).sort().pop();
const csp=readFileSync(ROOT+"/netlify.toml","utf8").match(/Content-Security-Policy = "([^"]+)"/)[1];
const server=http.createServer((_q,r)=>{r.writeHead(200,{"Content-Type":"text/html; charset=utf-8","Content-Security-Policy":csp});r.end(readFileSync(ROOT+"/index.html"));});
await new Promise(r=>server.listen(PORT,r));
const b=await chromium.launch({executablePath:`/opt/pw-browsers/${dir}/chrome-linux/chrome`,args:["--no-sandbox"]});
const page=await b.newPage();
const leaflet=readFileSync(ROOT+"/test/node_modules/leaflet/dist/leaflet.js");
await page.route("**://cdnjs.cloudflare.com/**",r=>r.fulfill({status:200,contentType:"application/javascript",body:leaflet}));
for(const p of ["**://tile.openstreetmap.org/**","**://*.tile.openstreetmap.org/**"]) await page.route(p,r=>r.fulfill({status:200,contentType:"image/png",body:F.PNG_1PX}));
await page.route("**://fonts.googleapis.com/**",r=>r.fulfill({status:200,contentType:"text/css",body:""}));
await page.route("**://api.open-meteo.com/**",r=>r.fulfill({status:200,contentType:"application/json",body:JSON.stringify(F.meteo())}));
await page.route("**://waterservices.usgs.gov/**",r=>r.fulfill({status:200,contentType:"application/json",body:JSON.stringify(F.IV)}));
await page.goto(`http://127.0.0.1:${PORT}/`,{waitUntil:"networkidle"});

const PLACES = [
  ["Roscoe NY (in the book)",      41.9337,  -74.9143],
  ["State College PA (edge)",      40.7934,  -77.8600],
  ["Asheville NC",                 35.5951,  -82.5515],
  ["Bozeman MT",                   45.6770, -111.0429],
  ["Boise ID",                     43.6150, -116.2023],
  ["San Francisco CA",             37.7749, -122.4194],
  ["Anchorage AK",                 61.2181, -149.9003],
];
const out = await page.evaluate(places=>places.map(([name,lat,lon])=>{
  const t = templateFor(lat, lon);
  return {name, template:t.w.name, miles: Math.round(t.dist/1609.34), type:t.w.type, sp:t.w.sp};
}), PLACES);
console.log("what the book hands a pin, by distance from the nearest water it knows:\n");
for(const o of out) console.log(`  ${o.name.padEnd(28)} -> ${o.template.padEnd(22)} ${String(o.miles).padStart(5)} mi  (${o.type})`);

// and what the reading actually claims for a far pin
const far = await page.evaluate(()=>{
  const tmpl = templateFor(45.677, -111.0429);
  const spot = spotProfile({lat:45.677, lon:-111.0429, name:"Gallatin River", place:"Bozeman, MT"},
                           tmpl.w, tmpl.dist, null, NaN);
  state.spot = spot; state.when = new Date(2026, 4, 20, 14, 0);   // 20 May
  const ctx = buildContext();
  const res = recommend(ctx);
  return {
    note: spot.note,
    temp: ctx.temp, cfs: ctx.cfs, call: ctx.acc.call,
    hatches: activeHatches(ctx).slice(0,4).map(o=>o.hx.name),
    topPlay: res.picked[0] && res.picked[0].title,
  };
});
console.log("\na pin on the Gallatin at Bozeman, 20 May:");
console.log("  note   :", far.note.replace(/\s+/g," "));
console.log("  reading:", far.temp.toFixed(0)+"°F,", far.cfs, "cfs —", far.call);
console.log("  hatches:", far.hatches.join(", "));
console.log("  top play:", far.topPlay);
await b.close(); server.close();
