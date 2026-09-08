/* Turning a places provider's answer into the shape the Shop tab already
   speaks. Pure — no network, no Netlify — so the parsing can be argued
   with in a test, which matters here: the sandbox this was written in
   cannot reach Google any more than it can reach Overpass.
 *
 * Why a places API at all: OpenStreetMap is a geographic database, not a
 * business directory. It maps boat launches and trailheads well because
 * those are features of the landscape. A fly shop is a business, and in
 * rural country it is only in OSM if a volunteer happened to map that
 * storefront — which for Cross Current Outfitters, and for most of the
 * West Branch, nobody has. Four rounds of query fixes could not conjure
 * a record that was never there.
 */

export const PLACES_URL = "https://places.googleapis.com/v1/places:searchText";

/* Only the fields the card renders. The field mask is also the bill, so
   asking for reviews or photos here would be paying for pixels nobody
   draws. */
export const FIELD_MASK = [
  "places.id","places.displayName","places.formattedAddress",
  "places.location","places.websiteUri","places.nationalPhoneNumber",
  "places.businessStatus",
].join(",");

export function searchBody(lat, lon, radiusM){
  return {
    textQuery: "fly fishing shop",
    maxResultCount: 20,
    locationBias: {circle:{center:{latitude:lat, longitude:lon},
                           radius: Math.min(50000, Math.max(1000, radiusM))}},
  };
}

/* The same name test the OSM path uses, for the same reason: a place
   called an outfitter or an angler is a fly shop whatever a directory
   filed it under. Here it also rejects the sporting-goods chains a text
   search drags in. */
export const FLYISH = /fly\s*-?\s*(fish|shop|rod)|angler|outfitt|tackle|trout|drift\s*-?\s*boat/i;

export function safeUrl(u){
  const raw=String(u||"").trim();
  if(!raw) return null;
  try{
    const url=new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : "https://"+raw);
    return (url.protocol==="http:"||url.protocol==="https:") ? url.href : null;
  }catch(e){ return null; }
}
export function safeTel(t){
  const raw=String(t||"").trim();
  /* A leading parenthesis is how half of America writes a phone number,
     and requiring a digit or a plus first silently dropped every one of
     them. The characters allowed after are unchanged, and the href still
     strips everything but digits and +. */
  return /^[0-9+(][0-9+()\-. ]{5,24}$/.test(raw) ? raw : null;
}

const R=6371000, rad=Math.PI/180;
export function metres(a,b,c,d){
  const dLat=(c-a)*rad, dLon=(d-b)*rad;
  const s=Math.sin(dLat/2)**2 + Math.cos(a*rad)*Math.cos(c*rad)*Math.sin(dLon/2)**2;
  return 2*R*Math.asin(Math.sqrt(s));
}

/* A text search for "fly fishing shop" is a ranking, not a filter: it
   will return the nearest big-box sporting goods store if there is
   nothing better. Anything that does not read as a fly shop by name is
   dropped rather than shown, because a wrong shop wastes a drive. */
export function normalise(json, lat, lon, radiusM){
  const out=[];
  for(const p of (json && json.places) || []){
    const name=String(p.displayName && p.displayName.text || "").trim();
    if(!name) continue;
    if(p.businessStatus && p.businessStatus!=="OPERATIONAL") continue;
    if(!FLYISH.test(name)) continue;
    const la=p.location && Number(p.location.latitude);
    const lo=p.location && Number(p.location.longitude);
    if(!Number.isFinite(la) || !Number.isFinite(lo)) continue;
    const dist=metres(lat, lon, la, lo);
    if(dist > radiusM*1.15) continue;              // the bias is a hint, not a fence
    out.push({
      id: "places/"+String(p.id||name),
      name, kind:"fishing", kindLabel:"Fly and tackle", pri:0,
      where: String(p.formattedAddress||"").split(",").slice(0,2).join(",").trim() || null,
      site: safeUrl(p.websiteUri),
      tel:  safeTel(p.nationalPhoneNumber),
      map:  `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(name)}&query_place_id=${encodeURIComponent(String(p.id||""))}`,
      lat: la, lon: lo, dist,
    });
  }
  out.sort((a,b)=>a.dist-b.dist);
  const seen=new Set(), uniq=[];
  for(const sh of out){
    const k=sh.name.toLowerCase();
    if(seen.has(k)) continue;
    seen.add(k); uniq.push(sh);
  }
  return uniq;
}
