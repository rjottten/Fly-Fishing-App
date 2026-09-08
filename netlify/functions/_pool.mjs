/* The rules for pooled days — no Netlify, no network, no I/O.
 *
 * Everything here is a pure function so it can be argued with in a test
 * rather than in production. The handler beside this file does the
 * storage; this file decides what is allowed to count and how much.
 *
 * The premise: a stranger's day is evidence, not testimony. It is worth
 * something, it is worth less than your own day on your own river, and
 * it is worth nothing at all until other people have said the same.
 */

/* The vocabulary is closed on purpose. There is no free-text field in a
   pooled day — not because free text is hard to sanitise, but because
   the ranking engine never reads it, so sending it would be collecting
   personal writing for no purpose. Nothing to inject into, nothing to
   leak. `flies` and `notes` stay on the angler's own device. */
export const OUTCOME_V = {blank:-1, slow:-0.35, steady:0.55, hot:1};
export const METHODS = ["dry","drydropper","nymph","tightline","swing","streamer"];
export const FLOWS   = ["verylow","low","normal","pushy","high","blown"];
export const CLARITY = ["gin","clear","green","stained","muddy"];
export const SKY     = ["bright","partly","overcast"];

export const MAX_BACKDATE_DAYS = 14;   // you log days you fished, not a season at once
export const QUORUM            = 3;    // contributors before a bucket may move a play
export const POOL_MAX          = 0.08; // hardest the pool may push a play — half your own book
export const REP_FLOOR         = 0.15; // a brand-new contributor still counts a little
export const REP_CEIL          = 1.0;

const isoRe = /^\d{4}-\d{2}-\d{2}$/;
const uniq  = (a)=>[...new Set(a)];

export function dayNumber(iso){
  const [y,m,d]=iso.split("-").map(Number);
  return Math.floor(Date.UTC(y, m-1, d)/86400000);
}

/* Schema first. Anything not in the vocabulary is dropped rather than
   rejected, so one mistyped method does not throw away a real day —
   but the fields the engine actually reads must be present and legal. */
export function validate(raw, now = new Date()){
  if(!raw || typeof raw!=="object") return {ok:false, why:"not an object"};

  const date = String(raw.date||"");
  if(!isoRe.test(date)) return {ok:false, why:"date must be YYYY-MM-DD"};
  const today = Math.floor(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())/86400000);
  const day   = dayNumber(date);
  if(Number.isNaN(day))            return {ok:false, why:"date is not a date"};
  if(day > today)                  return {ok:false, why:"date is in the future"};
  if(today - day > MAX_BACKDATE_DAYS) return {ok:false, why:`date is more than ${MAX_BACKDATE_DAYS} days ago`};

  if(!(raw.outcome in OUTCOME_V))  return {ok:false, why:"outcome is not one of the four"};

  const waterKey = String(raw.waterKey||"").trim().slice(0, 64);
  if(!/^[a-z0-9:_.,-]{2,64}$/i.test(waterKey)) return {ok:false, why:"waterKey is not a key"};

  const lat = Number(raw.lat), lon = Number(raw.lon);
  if(!Number.isFinite(lat) || !Number.isFinite(lon) ||
     lat < -90 || lat > 90 || lon < -180 || lon > 180) return {ok:false, why:"lat/lon out of range"};

  /* Numbers a thermometer or a gauge could actually produce. This is not
     a claim that they are true — only that they are not nonsense. */
  const temp = Number.isFinite(Number(raw.temp)) ? Number(raw.temp) : null;
  const cfs  = Number.isFinite(Number(raw.cfs))  ? Number(raw.cfs)  : null;
  if(temp!==null && (temp < 25 || temp > 95))     return {ok:false, why:"water temperature is not a river"};
  if(cfs!==null  && (cfs  < 0  || cfs > 1e6))     return {ok:false, why:"flow is not a river"};

  const methods = uniq((Array.isArray(raw.methods)?raw.methods:[]).filter(m=>METHODS.includes(m))).slice(0,6);
  const hatches = uniq((Array.isArray(raw.hatches)?raw.hatches:[])
                    .filter(h=>typeof h==="string" && /^[a-z0-9-]{2,32}$/.test(h))).slice(0,8);
  const c = raw.cond && typeof raw.cond==="object" ? raw.cond : {};
  const cond = {
    flow:    FLOWS.includes(c.flow)     ? c.flow    : null,
    clarity: CLARITY.includes(c.clarity)? c.clarity : null,
    sky:     SKY.includes(c.sky)        ? c.sky     : null,
  };

  return {ok:true, entry:{
    date, waterKey, outcome: raw.outcome, methods, hatches, cond, temp, cfs,
    // coordinates are rounded to about a kilometre: enough to place the
    // report on a river, not enough to publish anyone's home pool
    lat: Math.round(lat*100)/100,
    lon: Math.round(lon*100)/100,
  }};
}

/* A fortnight of one water is the unit the engine reasons in, so it is
   the unit the pool aggregates in too. */
export function bucketOf(waterKey, iso){
  const [y] = iso.split("-").map(Number);
  const jan1 = Math.floor(Date.UTC(y,0,1)/86400000);
  const fortnight = Math.floor((dayNumber(iso) - jan1)/14);
  return `${waterKey}/${y}-f${String(fortnight).padStart(2,"0")}`;
}

/* An objective number the whole bucket can be checked against. A river
   has one flow on one day; reports that disagree wildly about it are
   either lying or logged against the wrong water, and either way they
   should not be trusted about what the fish did. */
export function medianOf(values){
  const v = values.filter(Number.isFinite).sort((a,b)=>a-b);
  if(!v.length) return null;
  const m = v.length>>1;
  return v.length%2 ? v[m] : (v[m-1]+v[m])/2;
}

export function plausibility(entry, sameDay){
  const others = sameDay.filter(o=>o.date===entry.date);
  if(others.length < QUORUM || entry.cfs===null) return {factor:1, why:"nothing to check against yet"};
  const med = medianOf(others.map(o=>o.cfs));
  if(med===null || med<=0) return {factor:1, why:"no flow reported by anyone else"};
  /* Rivers vary along their length and gauges disagree, so the bar is
     wide: within half to double the day's median passes untouched. */
  const ratio = entry.cfs/med;
  if(ratio>=0.5 && ratio<=2)  return {factor:1,   why:"agrees with the day"};
  if(ratio>=0.2 && ratio<=5)  return {factor:0.4, why:"well off the day's median"};
  return {factor:0, why:"contradicts every other report of that day"};
}

/* Reputation is agreement, measured after the fact. Everyone starts near
   the floor and earns upward slowly; someone whose days never match what
   the water did for anybody else decays back toward nothing. It needs no
   account — only a stable id — and it is the defence that works against
   the adversary this app actually has, which is not a bot but a person
   with a reason to skew the record. */
export function updateReputation(rep, agreed){
  const r = Number.isFinite(rep) ? rep : REP_FLOOR;
  const next = agreed ? r + (REP_CEIL - r)*0.18 : r*0.55;
  return Math.min(REP_CEIL, Math.max(0, next));
}

export function agreesWithBucket(entry, agg){
  const m = agg && agg.methods && agg.methods[entry.methods[0]];
  if(!m || m.n < QUORUM) return null;             // nothing settled to agree with yet
  const mine = OUTCOME_V[entry.outcome];
  const theirs = m.sum/m.n;
  return Math.abs(mine - theirs) <= 0.85;         // same broad verdict
}

/* The aggregate is the product. Raw rows exist to compute reputation and
   to be deletable; this is what the app reads. */
export function emptyAgg(){ return {n:0, contributors:[], methods:{}, hatches:{}}; }

export function foldInto(agg, entry, contributorId, weight){
  const a = {n:agg.n+1, contributors:agg.contributors.slice(),
             methods:{...agg.methods}, hatches:{...agg.hatches}};
  if(!a.contributors.includes(contributorId)) a.contributors.push(contributorId);
  const w = Math.max(0, Math.min(1, weight));
  const v = OUTCOME_V[entry.outcome];
  for(const k of entry.methods){
    const cur = a.methods[k] || {n:0, w:0, sum:0};
    a.methods[k] = {n:cur.n+1, w:cur.w+w, sum:cur.sum + w*v};
  }
  for(const h of entry.hatches){
    const cur = a.hatches[h] || {n:0, w:0};
    a.hatches[h] = {n:cur.n+1, w:cur.w+w};
  }
  return a;
}

/* What the app is allowed to read back. Below quorum a bucket reports
   nothing at all — one person, however sincere, moves no plays. */
export function publish(agg){
  const people = (agg.contributors||[]).length;
  if(people < QUORUM) return {ready:false, people, methods:{}, hatches:{}};
  const methods={};
  for(const [k,m] of Object.entries(agg.methods||{})){
    if(m.w<=0) continue;
    const ev = m.sum/m.w;                                  // -1 .. +1
    const conf = 1-Math.exp(-m.w/2.5);                     // more days, more weight
    methods[k] = {days:m.n, ev, mult: 1 + POOL_MAX*ev*conf};
  }
  const hatches={};
  for(const [h,x] of Object.entries(agg.hatches||{})){
    if(x.w>0) hatches[h] = {days:x.n, seen: 1-Math.exp(-x.w/2.5)};
  }
  return {ready:true, people, methods, hatches};
}
