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
