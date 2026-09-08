/* The Shop tab's source of fly shops.
 *
 * It exists to hold the API key, which must not be in a page anyone can
 * view source on, and to be cached — fly shops do not move, so the CDN
 * answer below means the 27 waters and everywhere people commonly pin
 * resolve to a handful of upstream calls a month rather than one per
 * page view. That is what keeps a metered API close to free.
 *
 * With no key configured it says so plainly and the client falls back to
 * OpenStreetMap, so this ships dark and lights up the moment a key is
 * added in Netlify's UI. No redeploy, no code change.
 */
import { PLACES_URL, FIELD_MASK, searchBody, normalise } from "./_places.mjs";

const DAY = 86400;

const json = (body, status, cache) => new Response(JSON.stringify(body), {
  status,
  headers: {
    "content-type": "application/json",
    /* Netlify's durable CDN cache, keyed by this URL. The client rounds
       the coordinates it asks with, so nearby anglers share an answer. */
    ...(cache ? {"netlify-cdn-cache-control": `public, durable, s-maxage=${30*DAY}, stale-while-revalidate=${60*DAY}`,
                 "cache-control": "public, max-age=3600"} : {"cache-control":"no-store"}),
  },
});

export default async (req) => {
  const u = new URL(req.url);
  const lat = Number(u.searchParams.get("lat"));
  const lon = Number(u.searchParams.get("lon"));
  const radius = Math.min(50000, Math.max(1000, Number(u.searchParams.get("r")) || 40000));
  if(!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat)>90 || Math.abs(lon)>180){
    return json({error:"lat and lon required"}, 400, false);
  }

  const key = process.env.PLACES_API_KEY;
  if(!key) return json({configured:false, shops:[]}, 200, false);

  try{
    const c = new AbortController();
    const t = setTimeout(()=>c.abort(), 8000);
    const res = await fetch(PLACES_URL, {
      method:"POST", signal:c.signal,
      headers:{"content-type":"application/json", "X-Goog-Api-Key":key, "X-Goog-FieldMask":FIELD_MASK},
      body: JSON.stringify(searchBody(lat, lon, radius)),
    });
    clearTimeout(t);
    if(!res.ok) return json({configured:true, error:`upstream ${res.status}`, shops:[]}, 200, false);
    const body = await res.json();
    const shops = normalise(body, lat, lon, radius);
    /* Only a real answer is worth caching for a month. An empty one may
       be a bad day upstream rather than an empty county. */
    return json({configured:true, shops}, 200, shops.length>0);
  }catch(e){
    return json({configured:true, error:"unreachable", shops:[]}, 200, false);
  }
};

export const config = { path: "/api/shops" };
