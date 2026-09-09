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
  // the query now asks for every shop nearby, so the ordinary ones must fall out here
  {type:"node", id:26, lat:42.0210, lon:-75.3910, tags:{shop:"bakery", name:"Hale Eddy Bakery"}},
  {type:"node", id:27, lat:42.0220, lon:-75.3920, tags:{shop:"hairdresser", name:"Clip Joint"}},
  {type:"node", id:28, lat:42.0230, lon:-75.3930, tags:{tourism:"motel", name:"Riverside Motel"}},
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

/* Bozeman, Montana — 1,463 m, which is 4,800 ft. Open-Meteo answers the
   elevation query in metres, and the app converts. */
export const ELEV_M = 1463;

/* Environment and Climate Change Canada, through the GeoMet OGC API.
   Both collections answer GeoJSON. Station numbers carry letters, which
   is how the app tells an ECCC gauge from a USGS one; discharge is in
   cubic metres a second, and there is no water temperature in the feed. */
export const ECCC_STATIONS = {type:"FeatureCollection", features:[
  {type:"Feature", geometry:{type:"Point", coordinates:[-114.0512, 51.0470]},
   properties:{STATION_NUMBER:"05BH004", STATION_NAME:"BOW RIVER AT CALGARY",
               PROV_TERR_STATE_LOC:"AB", STATUS_EN:"Active"}},
  {type:"Feature", geometry:{type:"Point", coordinates:[-114.1900, 51.1200]},
   properties:{STATION_NUMBER:"05BH999", STATION_NAME:"OLD GAUGE, LONG GONE",
               PROV_TERR_STATE_LOC:"AB", STATUS_EN:"Discontinued"}},
]};

/* 92.3 m³/s is 3,260 cfs — a middling summer Bow. */
export const ECCC_REALTIME = {type:"FeatureCollection", features:[
  {type:"Feature", geometry:{type:"Point", coordinates:[-114.0512, 51.0470]},
   properties:{STATION_NUMBER:"05BH004", DATETIME:"2026-07-15T18:00:00Z", DISCHARGE:92.3, LEVEL:1.44}},
]};
export const ECCC_CMS = 92.3, ECCC_CFS = Math.round(92.3*35.3147);

/* The Yakima at Umtanum: 1,594 mi² of semi-arid Washington, drawn down for
   irrigation, and matched — correctly, on latitude and river type — to a
   54 mi² Adirondack freestone. Its own daily percentiles are what make
   1,850 cfs read as the ordinary September flow it is. */
export const SITE_YAKIMA = "USGS\t12484500\tYAKIMA RIVER AT UMTANUM WA\t46.8613\t-120.4842\t1594";
export const YAKIMA_CFS = 1850;

/* USGS daily-statistics RDB, one row per calendar day. Written for whatever
   day the suite runs on, because the app asks for today's row. */
export function yakimaStats(when){
  const d = when || new Date();
  return [
    "# USGS daily statistics",
    "agency_cd\tsite_no\tparameter_cd\tmonth_nu\tday_nu\tp10_va\tp25_va\tp50_va\tp75_va\tp90_va",
    "5s\t15s\t5s\t2n\t2n\t12n\t12n\t12n\t12n\t12n",
    `USGS\t12484500\t00060\t${d.getMonth()+1}\t${d.getDate()}\t980\t1320\t1750\t2400\t3300`,
  ].join("\n");
}

/* USGS daily statistics as the service actually answers them: statTypeCd
   takes a KIND of statistic (all, mean, max, min, median) and the percentile
   columns arrive with "all". Naming percentiles is a bad request — which is
   how the flow bands quietly stayed borrowed. */
export const STAT_COLS =
  "agency_cd\tsite_no\tparameter_cd\tts_id\tloc_web_ds\tmonth_nu\tday_nu\tbegin_yr\tend_yr\tcount_nu\t" +
  "max_va\tmin_va\tmean_va\tp05_va\tp10_va\tp20_va\tp25_va\tp50_va\tp75_va\tp80_va\tp90_va\tp95_va";
const STAT_FMT =
  "5s\t15s\t5s\t3n\t15s\t2n\t2n\t4n\t4n\t8n\t12n\t12n\t12n\t12n\t12n\t12n\t12n\t12n\t12n\t12n\t12n\t12n";

/* The Pere Marquette at Scottville — a spring-fed sand river, unusually
   steady, and nothing like the Adirondack freestone it is matched to. */
export function pmStats(when){
  const d=when||new Date();
  const row=`USGS\t04122100\t00060\t12345\t\t${d.getMonth()+1}\t${d.getDate()}\t1939\t2025\t86\t` +
            `2140\t388\t712\t455\t498\t551\t574\t672\t812\t858\t968\t1090`;
  return ["# USGS daily statistics", STAT_COLS, STAT_FMT, row].join("\n");
}
export const PM_IDEAL=[574,812], PM_CFS=620;

/* A site that publishes a daily mean and no percentiles at all. Coarse, but
   still this river's water in this river's units. */
export function meanOnlyStats(when){
  const d=when||new Date();
  const cols="agency_cd\tsite_no\tparameter_cd\tmonth_nu\tday_nu\tmean_va";
  const row=`USGS\t04122100\t00060\t${d.getMonth()+1}\t${d.getDate()}\t712`;
  return ["# USGS daily statistics", cols, "5s\t15s\t5s\t2n\t2n\t12n", row].join("\n");
}

export const SITE_PM_SCOTTVILLE =
  "USGS\t04122100\tPERE MARQUETTE RIVER AT SCOTTVILLE MI\t43.9525\t-86.2803\t704";

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

/* Baldwin, Michigan — what a bBox around a town 300 miles outside the old
   250-mile gate looks like coming back from USGS. Shouted station names,
   several gauges on one river, and a headwater ditch small enough that the
   list should drop it. Site numbers here are fixture values, not a claim
   about which gauge USGS really operates where. */
export const SITE_PM      = "USGS\t04122200\tPERE MARQUETTE RIVER AT SCOTTVILLE MI\t43.9500\t-86.2800\t709";
export const SITE_PM_UP   = "USGS\t04122100\tPERE MARQUETTE RIVER NEAR BALDWIN MI\t43.8990\t-85.8500\t250";
export const SITE_BALDWIN = "USGS\t04122150\tBALDWIN RIVER NEAR BALDWIN MI\t43.8800\t-85.8600\t62";
export const SITE_LTMANI  = "USGS\t04125460\tLITTLE MANISTEE RIVER NEAR LUTHER MI\t44.0400\t-85.6800\t180";
export const SITE_DITCH   = "USGS\t04122099\tUNNAMED DRAIN AT IDLEWILD MI\t43.8900\t-85.8000\t3.1";
export const MI_SITES = [SITE_PM_UP, SITE_BALDWIN, SITE_PM, SITE_LTMANI, SITE_DITCH];

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
