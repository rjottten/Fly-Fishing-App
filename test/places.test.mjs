/* The places parsing, argued with directly.
 *
 * A text search for "fly fishing shop" is a ranking, not a filter — ask
 * it near a town with no fly shop and it will happily return the nearest
 * big-box sporting goods store. What this module keeps and what it drops
 * is the whole product, and it is the part neither the browser suite nor
 * the sandbox can reach Google to check.
 */
import * as P from "../netlify/functions/_places.mjs";

let failures=0, checks=0;
function ok(cond, label, detail){
  checks++;
  if(cond){ console.log(`    ✓ ${label}`); return; }
  failures++;
  console.log(`    ✗ ${label}${detail!==undefined?`\n        got: ${JSON.stringify(detail)}`:""}`);
}

const LAT=42.011, LON=-75.388;                     // Hale Eddy
const place=(over={})=>({
  id:"ChIJ_test", displayName:{text:"Cross Current Outfitters"},
  formattedAddress:"123 River Rd, Starlight, PA 18461, USA",
  location:{latitude:41.91, longitude:-75.34},
  websiteUri:"crosscurrentoutfitters.example",
  nationalPhoneNumber:"(570) 555-0134",
  businessStatus:"OPERATIONAL", ...over,
});
const run=(places,r=40000)=>P.normalise({places}, LAT, LON, r);

console.log("\n  what the directory is asked");
{
  const b=P.searchBody(LAT, LON, 40000);
  ok(b.textQuery==="fly fishing shop", "a text search, because no place category means fly shop", b.textQuery);
  ok(b.locationBias.circle.radius===40000, "biased to the water being read", b.locationBias.circle.radius);
  ok(P.searchBody(LAT,LON,900000).locationBias.circle.radius===50000,
     "and clamped to the largest circle the API accepts", P.searchBody(LAT,LON,900000).locationBias.circle.radius);
  ok(!/photo|review|rating/i.test(P.FIELD_MASK),
     "the field mask asks for nothing the card does not draw — it is also the bill", P.FIELD_MASK);
}

console.log("\n  what comes back");
{
  const [sh] = run([place()]);
  ok(sh && sh.name==="Cross Current Outfitters", "a fly shop is kept", sh);
  ok(sh.site==="https://crosscurrentoutfitters.example/", "a bare hostname becomes a link", sh.site);
  ok(sh.tel==="(570) 555-0134", "the phone survives", sh.tel);
  ok(sh.where==="123 River Rd, Starlight", "the address is trimmed to what fits a row", sh.where);
  ok(sh.kindLabel==="Fly and tackle" && sh.pri===0, "and it ranks with the tackle shops", sh);
  ok(sh.dist>0 && sh.dist<40000, "with a real distance from the water", Math.round(sh.dist));
}
{
  const names=run([
    place({displayName:{text:"West Branch Angler"}}),
    place({displayName:{text:"Baxter House River Outfitters"}}),
    place({displayName:{text:"Beaverkill Angler"}}),
    place({displayName:{text:"Al's Wild Trout"}}),
  ]).map(s=>s.name);
  ok(names.length===4, "the shops an angler would actually drive to are all kept", names);
}
{
  const names=run([
    place({displayName:{text:"Walmart Supercenter"}}),
    place({displayName:{text:"Dick's Sporting Goods"}}),
    place({displayName:{text:"Deposit Hardware"}}),
    place({displayName:{text:"Flying Pizza"}}),
  ]).map(s=>s.name);
  ok(names.length===0, "and a text search's consolation prizes are not", names);
}
{
  ok(run([place({businessStatus:"CLOSED_PERMANENTLY"})]).length===0,
     "a shop that has closed is not somewhere to send anyone");
  ok(run([place({location:null})]).length===0, "and one with no location cannot be ranked by distance");
  ok(run([place({displayName:{text:"   "}})]).length===0, "an unnamed result is not a shop");
}
{
  const far=place({displayName:{text:"Far Angler"}, location:{latitude:44.5, longitude:-75.3}});
  ok(run([far], 40000).length===0, "the bias is a hint, so anything well outside the radius is dropped");
}
{
  const dup=[place(), place({id:"ChIJ_other"})];
  ok(run(dup).length===1, "the same shop returned twice is listed once", run(dup).map(s=>s.name));
}
{
  const two=run([
    place({displayName:{text:"Far Angler"},  location:{latitude:42.30, longitude:-75.60}}),
    place({displayName:{text:"Near Angler"}, location:{latitude:42.02, longitude:-75.39}}),
  ]);
  ok(two[0].name==="Near Angler", "nearest first", two.map(s=>s.name));
}
{
  ok(run([place({websiteUri:"javascript:alert(1)"})])[0].site===null,
     "and a website that is script never reaches an href");
  ok(P.normalise(null, LAT, LON, 40000).length===0, "a broken answer is an empty list, not a throw");
  ok(P.normalise({places:"nonsense"}, LAT, LON, 40000).length===0, "and so is a surprising one");
}

console.log(`\n  ${checks-failures}/${checks} places checks passed\n`);
process.exit(failures?1:0);
