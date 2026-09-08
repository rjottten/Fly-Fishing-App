/* The pooling rules, argued with directly.
 *
 * These are pure functions, so they need no browser and no Netlify —
 * which matters, because the rules are the part of pooled logging that
 * can be wrong quietly. A junk day that slips through does not throw;
 * it just makes the plays a little worse for everyone.
 */
import * as P from "../netlify/functions/_pool.mjs";

let failures=0, checks=0;
function ok(cond, label, detail){
  checks++;
  if(cond){ console.log(`    ✓ ${label}`); return; }
  failures++;
  console.log(`    ✗ ${label}${detail!==undefined?`\n        got: ${JSON.stringify(detail)}`:""}`);
}

const NOW = new Date("2026-05-20T12:00:00Z");
const iso = (back)=>{ const d=new Date(NOW); d.setUTCDate(d.getUTCDate()-back); return d.toISOString().slice(0,10); };
const good = (over={})=>({
  date: iso(1), waterKey:"bkill", outcome:"hot", methods:["streamer"], hatches:["hendrickson"],
  cond:{flow:"normal", clarity:"clear", sky:"overcast"}, temp:54, cfs:400,
  lat:41.9337, lon:-74.9143, ...over,
});

console.log("\n  what a pooled day must be");
{
  const v = P.validate(good(), NOW);
  ok(v.ok, "a well-formed day is accepted", v.why);
  ok(v.entry.flies===undefined && v.entry.notes===undefined,
     "and carries no free text — the engine never reads it, so it is never collected", Object.keys(v.entry));
  ok(v.entry.lat===41.93 && v.entry.lon===-74.91,
     "coordinates are rounded to about a kilometre, not to a home pool", [v.entry.lat, v.entry.lon]);
}
{
  ok(!P.validate(good({date:iso(-2)}), NOW).ok, "a day in the future is refused");
  ok(!P.validate(good({date:iso(40)}), NOW).ok, "and so is a season logged in one sitting");
  ok(P.validate(good({date:iso(13)}), NOW).ok,  "but a fortnight back is still a day you fished");
  ok(!P.validate(good({outcome:"amazing"}), NOW).ok, "an outcome outside the four is refused");
  ok(!P.validate(good({temp:180}), NOW).ok, "a water temperature no river has is refused");
  ok(!P.validate(good({cfs:-5}), NOW).ok, "and so is a negative flow");
  ok(!P.validate(good({lat:999}), NOW).ok, "and a latitude off the planet");
  ok(!P.validate(good({waterKey:"<script>"}), NOW).ok, "a water key that is not a key is refused");
}
{
  const v = P.validate(good({methods:["streamer","telepathy","dry"], hatches:["hendrickson","../../etc/passwd"]}), NOW);
  ok(v.ok, "one mistyped field does not throw away a real day");
  ok(JSON.stringify(v.entry.methods)===JSON.stringify(["streamer","dry"]),
     "the method that is not a method is dropped", v.entry.methods);
  ok(JSON.stringify(v.entry.hatches)===JSON.stringify(["hendrickson"]),
     "and so is the hatch id that is a path", v.entry.hatches);
}
{
  const v = P.validate({...good(), flies:"<img src=x onerror=alert(1)>", notes:"my address is"}, NOW);
  ok(!("flies" in v.entry) && !("notes" in v.entry),
     "free text sent anyway is not stored — there is no field for it", v.entry);
}

console.log("\n  a river has one flow on one day");
{
  const day = iso(1);
  const others = [400,430,380].map(cfs=>({date:day, cfs}));
  ok(P.plausibility({date:day, cfs:410}, others).factor===1, "a report that agrees is untouched");
  ok(P.plausibility({date:day, cfs:1200}, others).factor===0.4, "one well off the day's median is discounted");
  ok(P.plausibility({date:day, cfs:40000}, others).factor===0,
     "one that contradicts every other report of that day counts for nothing");
  ok(P.plausibility({date:day, cfs:410}, others.slice(0,1)).factor===1,
     "and nothing is judged until there is something to judge against");
}

console.log("\n  one person moves nothing");
{
  let agg = P.emptyAgg();
  const e = P.validate(good(), NOW).entry;
  agg = P.foldInto(agg, e, "alice", 1);
  ok(P.publish(agg).ready===false, "one contributor is below quorum and publishes nothing");
  agg = P.foldInto(agg, e, "alice", 1);
  agg = P.foldInto(agg, e, "alice", 1);
  ok(P.publish(agg).ready===false, "and one contributor filing three days is still one contributor",
     P.publish(agg).people);
  agg = P.foldInto(agg, e, "bob", 1);
  agg = P.foldInto(agg, e, "carol", 1);
  const pub = P.publish(agg);
  ok(pub.ready===true && pub.people===3, "three independent people is a signal", pub.people);
  ok(pub.methods.streamer.mult > 1 && pub.methods.streamer.mult <= 1+P.POOL_MAX,
     `and it may push a play at most ${Math.round(P.POOL_MAX*100)}%`, pub.methods.streamer.mult);
}
{
  let agg = P.emptyAgg();
  const blank = P.validate(good({outcome:"blank"}), NOW).entry;
  for(const who of ["a","b","c","d","e","f","g","h"]) agg = P.foldInto(agg, blank, who, 1);
  const mult = P.publish(agg).methods.streamer.mult;
  ok(mult < 1 && mult >= 1-P.POOL_MAX,
     "a pile of blanks pushes the other way, and no harder", mult);
}
{
  ok(P.POOL_MAX*2 <= 0.16 && P.POOL_MAX < 0.15,
     "the pool is capped below your own book — strangers never outweigh your own days", P.POOL_MAX);
}

console.log("\n  reputation is agreement, measured after the fact");
{
  let r = P.REP_FLOOR;
  for(let i=0;i<8;i++) r = P.updateReputation(r, true);
  ok(r > 0.75, "someone who keeps agreeing earns their way up", r);
  ok(r <= P.REP_CEIL, "but never past the ceiling", r);
  let s = r;
  for(let i=0;i<4;i++) s = P.updateReputation(s, false);
  ok(s < 0.15, "and a run of contradictions costs it far faster than it was earned", s);
  ok(P.updateReputation(undefined, true) > P.REP_FLOOR, "a first-timer starts near the floor, not at zero");
}
{
  const agg = ["a","b","c"].reduce((g,who)=>P.foldInto(g, P.validate(good(), NOW).entry, who, 1), P.emptyAgg());
  ok(P.agreesWithBucket(P.validate(good(), NOW).entry, agg)===true,
     "a day matching the settled verdict agrees");
  ok(P.agreesWithBucket(P.validate(good({outcome:"blank"}), NOW).entry, agg)===false,
     "and one contradicting it does not");
  ok(P.agreesWithBucket(P.validate(good(), NOW).entry, P.emptyAgg())===null,
     "with nothing settled, there is nothing to agree with");
}

console.log("\n  buckets");
{
  ok(P.bucketOf("bkill","2026-05-20")===P.bucketOf("bkill","2026-05-22"),
     "two days in the same fortnight of the same water share a bucket");
  ok(P.bucketOf("bkill","2026-05-20")!==P.bucketOf("willo","2026-05-20"),
     "two waters never do");
  ok(P.bucketOf("bkill","2026-05-20")!==P.bucketOf("bkill","2026-07-20"),
     "and neither do two times of year");
}

console.log(`\n  ${checks-failures}/${checks} pooling checks passed\n`);
process.exit(failures?1:0);
