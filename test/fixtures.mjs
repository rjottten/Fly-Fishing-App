/* Canned upstream payloads, shaped like the real services.
   Riffle talks to five of them; none are reachable from CI, and
   none should be hammered by a test suite anyway. */

/* A stretch of the Beaverkill, as Overpass returns way geometry. */
export const RIVER = [
  {lat:41.9450, lon:-74.9720}, {lat:41.9455, lon:-74.9680}, {lat:41.9460, lon:-74.9600},
];

/* Five features around Roscoe, NY. Two must be filtered out:
   the posted lot (access=private) and the village lot (no water
   within 400 m of it). */
export const OVERPASS = {elements:[
  {type:"node", id:1, lat:41.9450, lon:-74.9721, tags:{leisure:"slipway", name:"Cooks Falls Access"}},
  {type:"way",  id:2, center:{lat:41.9455, lon:-74.9725}, tags:{amenity:"parking", name:"Beaverkill Lot"}},
  {type:"way",  id:3, center:{lat:41.9452, lon:-74.9722}, tags:{amenity:"parking", name:"Posted Lot", access:"private"}},
  {type:"way",  id:4, center:{lat:41.9600, lon:-74.9000}, tags:{amenity:"parking", name:"Village Lot"}},
  {type:"node", id:5, lat:41.9440, lon:-74.9700, tags:{highway:"trailhead", name:"Riverside Trail"}},
  {type:"way",  id:9, tags:{waterway:"river", name:"Beaverkill"}, geometry:RIVER},
]};

/* Shops around Roscoe, as Overpass returns them for the shop query.
   Four must survive and two must not: the unnamed outdoor shop is a
   map note rather than a counter, and the shop whose website tag has
   been edited into a javascript: URL must render with no link at all. */
/* How these places are really tagged in OpenStreetMap, which is the
   thing that broke the shop list: the fly shops an angler drives to on
   the West Branch are lodges and guide services, and OSM files them as
   tourism=hotel, as shop=outdoor, or as a named node with no shop tag
   at all. Asking only for shop=fishing found none of them. */
export const SHOPS = {elements:[
  // a lodge that is unmistakably a fly shop, tagged as a hotel
  {type:"node", id:21, lat:42.0150, lon:-75.3800, tags:{tourism:"hotel", name:"West Branch Angler",
    website:"https://westbranchangler.example", phone:"+1 607-467-5525"}},
  // a guide service with no shop tag whatsoever — the Starlight case
  {type:"node", id:22, lat:41.9100, lon:-75.3400, tags:{name:"Cross Current Outfitters",
    website:"crosscurrentoutfitters.example"}},
  // a general outdoor shop, named like nothing in particular
  {type:"node", id:23, lat:42.0500, lon:-75.4200, tags:{shop:"outdoor", name:"Deposit Hardware & Supply"}},
  // named like a fly shop, mapped as a way
  {type:"way",  id:24, center:{lat:41.9500, lon:-75.2000}, tags:{shop:"outdoor", name:"Border Water Tackle"}},
  // not a fly shop, and must not be mistaken for one
  {type:"node", id:25, lat:42.0200, lon:-75.3900, tags:{amenity:"restaurant", name:"Flying Pizza"}},
  {type:"node", id:11, lat:41.9330, lon:-74.9150, tags:{shop:"fishing", name:"Beaverkill Angler",
    website:"https://beaverkillangler.example", phone:"+1 607-498-5001",
    "addr:housenumber":"12", "addr:street":"Stewart Ave", "addr:city":"Roscoe"}},
  {type:"way",  id:12, center:{lat:41.9400, lon:-74.9300}, tags:{shop:"outdoor", name:"Catskill Outfitters",
    "contact:website":"catskilloutfitters.example"}},
  {type:"node", id:13, lat:41.9100, lon:-74.8000, tags:{shop:"fishing", name:"Willowemoc Fly Shop"}},
  {type:"node", id:14, lat:41.9200, lon:-74.8500, tags:{shop:"outdoor"}},
  {type:"node", id:15, lat:41.9350, lon:-74.9200, tags:{shop:"fishing", name:"Poisoned Tackle",
    website:"javascript:window.__xss=(window.__xss||0)+1"}},
  {type:"node", id:16, lat:41.9000, lon:-74.7000, tags:{shop:"sports", sport:"fishing", name:"Sullivan Sports"}},
]};

export const GEOCODE = [
  {display_name:"Roscoe, Sullivan County, New York, USA", lat:"41.9337", lon:"-74.9143"},
];
export const REVERSE = {display_name:"Roscoe, Sullivan County, New York"};

/* USGS site service speaks RDB: comment lines, a header row, a
   format row (5s / 16d / 8n), then data. */
export const rdb = (rows) => [
  "# USGS site service",
  "agency_cd\tsite_no\tstation_nm\tdec_lat_va\tdec_long_va\tdrain_area_va",
  "5s\t15s\t50s\t16d\t16d\t8n",
  ...rows,
].join("\n");

export const SITE_BEAVERKILL = "USGS\t01420500\tBEAVER KILL AT COOKS FALLS NY\t41.9450\t-74.9750\t241";
export const SITE_LITTLE     = "USGS\t01420990\tLITTLE BEAVER KILL AT LEW BEACH NY\t41.9900\t-74.8000\t23.4";
export const SITE_LITTLE_NOAREA = "USGS\t01420990\tLITTLE BEAVER KILL AT LEW BEACH NY\t41.9900\t-74.8000\t";
export const SITE_WBD        = "USGS\t01426500\tW BR DELAWARE R AT HALE EDDY NY\t42.0114\t-75.3883\t595";

export const IV = {value:{timeSeries:[
  {variable:{variableCode:[{value:"00060"}]}, values:[{value:[{value:"412"}]}]},
  {variable:{variableCode:[{value:"00010"}]}, values:[{value:[{value:"12.5"}]}]},
]}};

/* Falling pressure over the last twelve hours. */
export function meteo(){
  const now=Date.now(), time=[], surface_pressure=[];
  for(let i=-12;i<=2;i++){
    time.push(new Date(now+i*3600e3).toISOString().slice(0,13)+":00");
    surface_pressure.push(1015-i*0.4);
  }
  return {hourly:{time, surface_pressure}};
}

export const PNG_1PX = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==",
  "base64");
