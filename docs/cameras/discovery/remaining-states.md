# Camera Network discovery: remaining states

Survey date: 2026-09-30. This is research only: no application code, no registrations, no credentials used.

**Scope.** The 16 LeadCommand operating states (OH, PA, OK, NC, TN, KS, MI, VA, NV, LA, AL, KY, MD, RI, WA, CT), then CO, NY, NJ, MA, WI, UT, OR, SC, IA, NE. MN, FL, TX, CA, GA, MO, IN, IL and AZ are covered in other discovery docs.

**Method.**
- For each state I looked for the agency's developer, data-feed or open-data page first.
- Endpoints that are only visible by reading a consumer web app are marked *undocumented internal (needs terms confirmation)*. Some were read once, only to count cameras or find an image for the CORS probe. None is recommended.
- CORS was probed with `curl -sI -H 'Origin: https://example.org'` (one GET if HEAD was refused) against the metadata endpoint and one image.
- Quotes are verbatim, at most 2 sentences, and were checked against the raw page.
- Counts come from the feed itself (`returnCountOnly` or a single fetch) unless marked as the agency's own figure.

**Legend.**
- **Coverage:** FULL / PARTIAL / METRO ONLY / METADATA ONLY / NO PUBLIC FEED / UNKNOWN. For keyed sources this is the coverage *once the key exists*.
- **Enable now:** yes only when the source needs no key, account or agreement, is official and documented, and its terms don't forbid the use. Every "yes" still inherits the terms caveats in its row.

## Summary matrix

| St | Best official source | Auth | Adapter | Cameras | Coverage | Terms verdict | Enable now |
|---|---|---|---|---|---|---|---|
| **OH** | OHGO Public API (ODOT) | free key | `ohgo` | ~1,300 (ODOT figure, not verified) | FULL | permits ("public domain"; key required) | no (free key) |
| **PA** | PennDOT Data Feeds / 511PA | agreement + private circuit | none | "over 950" (PennDOT); 1,537 sites on 511PA | NO PUBLIC FEED | agreement required; site terms restrictive | no |
| **OK** | OKTraffic (ODOT) | none, but undocumented | none | 466 on 228 poles | NO PUBLIC FEED | restrictive (transportation purposes only) | no |
| **NC** | DriveNC 511 (NCDOT, IBI) | free key | `ibi511_v2` | ~1,154 sites | FULL | silent | no (free key) |
| **TN** | TDOT OpenData API (SmartWay) | key by request, no public signup | `tdot_opendata` | 661 (TDOT figure) | PARTIAL | agreement required | no |
| **KS** | KanDrive (KDOT, Castle Rock CARS) | CARS-Hub credentials | `cars` | 608 (347 are KC Scout) | NO PUBLIC FEED | agreement required | no |
| **MI** | MDOT "MiDrive Cameras" ArcGIS layer | none | `arcgis_featureserver` | 681 (live site ~804) | PARTIAL (inventory frozen 2021) | silent | **yes**, marked stale |
| **VA** | 511 Virginia (VDOT, Iteris) | agreement (Iteris video subscription / SmarterRoads) | Iteris ATIS GeoJSON | 1,647 | NO PUBLIC FEED | agreement required | no |
| **NV** | NVroads 511 (NDOT, IBI) | free key | `ibi511_v2` | 652 | FULL | silent | no (free key) |
| **LA** | 511LA (LADOTD, IBI) | free key | `ibi511_v2` | 336 | FULL | silent | no (free key) |
| **AL** | ALGO Traffic (ALDOT) | none, but undocumented | none | 635 (628 Public) | NO PUBLIC FEED | restrictive (ALDOT permission needed) | no |
| **KY** | KYTC Traffic Cameras ArcGIS layer (GoKY) | none | `arcgis_featureserver` | 256 (247 KY) | FULL | silent (disclaimer only) | **yes** |
| **MD** | MDOT SHA CHART camera export | none | `chart_json` | 552 | FULL | silent | **yes** |
| **RI** | RIDOT Rhodeways ArcGIS layer 6 | none, but undocumented | `arcgis_featureserver` | 143 | FULL | silent; needs terms confirmation | no (ask RIDOT) |
| **WA** | WSDOT Travel Information Cameras ArcGIS layer | none (AccessCode optional) | `arcgis_featureserver` (+ `wsdot_traveler`) | 1,706 incl. airport/ferry/OR | FULL | "low volume" + indemnity; silent on redistribution | **yes** |
| **CT** | CTroads (CTDOT, IBI; imagery via TrafficLand) | no camera API | none | 347 | NO PUBLIC FEED | restrictive | no |
| CO | COtrip data portal (CDOT, CARS 511x) | key after approval + ToS | `cars` / custom XML | 1,020 (1,329 views) | UNKNOWN | agreement required (ToS behind login) | no |
| NY | 511NY (NYSDOT, IBI) | free key + DAA | `ibi511_v2` | ~1,877 sites | FULL | permits with attribution, unaltered | no (free key) |
| NJ | none (511NJ internal; TRANSCOM feed has no cameras) | agreement | none | NJTA 136; 511NJ unknown | NO PUBLIC FEED | agreement required | no |
| MA | MassDOT CCTV asset layer; imagery via TrafficLand | none (metadata) / agreement (imagery) | `arcgis_featureserver` (metadata) | 308 on Mass511; 644 in-service assets | METADATA ONLY | agreement required for imagery | no |
| WI | 511WI (WisDOT, IBI) | key on approval + written consent | `ibi511_v2` | 490 | FULL (via key) | agreement required (restrictive) | no |
| UT | UDOT Traffic (IBI) | free key | `ibi511_v2` | 2,081 | FULL | silent | no (free key) |
| OR | ODOT TripCheck API | free key (auto-approved) | `odot_tripcheck` | ~1,188 (from a mirror) | FULL | permits with attribution + mirroring + disclaimer | no (free key) |
| SC | 511SC (SCDOT, Iteris) | none, but undocumented | none | 795 | NO PUBLIC FEED | restrictive (written permission) | no |
| IA | Iowa DOT Traffic Cameras ArcGIS layer | none | `arcgis_featureserver` | 860 devices / 1,259 views | FULL | permits with attribution (CC BY 4.0) | **yes** |
| NE | Nebraska 511 (NDOT, CARS) | CARS-Hub credentials | `cars` | 348 (1,053 views) | NO PUBLIC FEED | silent | no |

**Operating states with no usable public feed:** PA, OK, TN, KS, VA, AL, CT. **Operating states that are one free key away:** OH, NC, NV, LA.

## Adapter families

| Family | Serves now (no key) | Serves after operator action | Notes |
|---|---|---|---|
| `arcgis_featureserver` | KY, IA, WA, MI | RI (terms), MA (metadata only) | Generic query + per-layer field map. Paginate at `maxRecordCount` (KY/IA 1000, MI/WA 2000). ArcGIS Online hosts send `ACAO: *`. On-prem servers (WSDOT, RIDOT, MassDOT) reflect the Origin and send credentials. |
| `ibi511_v2` | none | NY, NC, NV, LA, UT (free key); WI (consent) | Arcadis IBI 511 platform. One adapter for every host; likely also GA/AZ, which are in other docs. See the platform notes below. |
| `ohgo` | none | OH | Paged envelope; supports ETag/304. |
| `odot_tripcheck` | none | OR | Azure APIM `Ocp-Apim-Subscription-Key`. Terms *require* server-side image mirroring. |
| `chart_json` | MD | none | Documented JSON export plus an XML twin. |
| `wsdot_traveler` | none | WA (optional upgrade) | Adds `IsActive`, owner and milepost to the no-key ArcGIS layer. |
| `cars` | none | KS, NE, CO (and MA) only with written access | Castle Rock CARS-Hub XML (TMDD-style CCTV ICD) behind Basic auth. |
| Iteris ATIS GeoJSON | none | VA (agreement), SC (permission) | VA and SC share one schema. |

**IBI 511 platform notes** (NY, NC, NV, LA, UT, WI; PA and CT run the platform without camera API access):
- **Endpoint:** `GET https://{host}/api/v2/get/cameras?key={key}&format=json|xml`.
- **Response:** `[{Id, Source, SourceId, Roadway, Direction, Latitude, Longitude, Location, SortOrder, Views:[{Id, Url, Status, Description, VideoUrl}]}]`. WI adds `Region` and `County`; NC adds `County`.
- **Throttle:** "Throttling is enabled. Ten calls every 60 seconds." One call returns the whole inventory.
- **Last-updated:** the platform has no last-updated field; use the image `Last-Modified`.
- **Images:** `/map/Cctv/{viewId}` is public. An unknown or unavailable view still returns HTTP 200, with a 15,136-byte placeholder PNG and no `Last-Modified`, so health checks must detect it.
- **CORS:** image responses send duplicate or comma-joined `Access-Control-Allow-Origin` plus credentials. Browsers treat that as invalid, so use `<img>` or the server proxy, never canvas/WebGL. The HLS hosts (NY, NV, LA, WI) send a clean `ACAO: *`.

**Endpoints not to use** (all undocumented or unsanctioned):
- 511NY's legacy `/api/getcameras` returned data *without* a key on 2026-09-30, although the docs require one. That is an enforcement gap.
- KanDrive HLS URLs carry a 300 s signed JWT.
- The MA CARS payload embeds a Castle Rock/TrafficLand `key=`.
- The SmartWay web app ships its own TDOT key.
- CARS `cameras_v1` / `map-features` JSON (KS, NE, CO, MA).
- OKTraffic `/api/CameraPoles`, ALGO `api.algotraffic.com/v4.0/Cameras`, the 511SC CDN GeoJSON and the 511 Virginia `/map/layers/map/cams`.
- The 511PA and CTroads `/List/GetData/Cameras` endpoints. The 511PA one also exposes staff emails.
- NYC DOT `webcams.nyctmc.org/api/cameras`.
- The NJTA HTML-embedded JSON.

---

## Priority states

### OH — Ohio

| Source (owner) | API | Auth | Cameras | Coverage | Terms | Enable now |
|---|---|---|---|---|---|---|
| OHGO Public API, run in-house by ODOT | REST JSON, OpenAPI 3 | free key | ~1,300 (ODOT figure, not verified live) | FULL | permits | no (free key) |

- **Metadata:** `GET https://publicapi.ohgo.com/api/v1/cameras?page-all=true` and `/api/v1/cameras/{id}`.
  - Filters: `region`, `map-bounds-sw`/`-ne`, `radius`, `page-size` (default 500).
  - Key goes in header `Authorization: APIKEY {key}` or query `?api-key={key}`.
  - Envelope: `links`, `lastUpdated`, `totalPageCount`, `totalResultCount`, `currentResultCount`, `results`.
- **Images:** `cameraViews[].smallUrl` / `largeUrl` → `https://itscameras.dot.state.oh.us/images/{REGION}/{NAME}.jpg`, e.g. `…/images/CLE/CLE3097.jpg`. Public, no key. The docs say "Image snapshots are updated every 5 seconds." There are no streams in the API.
- **Rate limit:** "For example we may allow 25 requests per second for a single API Key. (Subject to change)". ETag/`If-None-Match` returns 304 (/docs/cache).
- **Attribution:** none required.
- **Terms:**
  - [/docs/terms-of-use](https://publicapi.ohgo.com/docs/terms-of-use): "In order to use the API you must register for and use a unique identifier (An API Key) with every request sent to the API." And: "ODOT reserves the right to revoke or terminate your access to the API, without cause or prior notice."
  - [Home page](https://publicapi.ohgo.com/): "the data from ODOT is considered public domain and therefore freely available to anyone."
- **CORS:**
  - Metadata without a key → 401 `{"errorDescription":"API key required."}` with `ACAO: *`; HEAD → 405.
  - Image → 200 image/jpeg, ACAO absent, `Last-Modified` ~7 s old, `X-Frame-Options: deny`.
- **Fields:** status: none. Last-updated: envelope `lastUpdated`. Direction: `cameraViews[].direction` (`PTZ` = pan-tilt-zoom). Also `id`, `latitude`, `longitude`, `location`, `description`, `cameraViews[].mainRoute`.
- **Recommendation:** best keyed source in scope, so register it first. Poll `page-all=true` with `If-None-Match` every few minutes. Don't use the consumer site's internal `api.ohgo.com`.
- **Evidence:** [cameras doc](https://publicapi.ohgo.com/docs/v1/cameras) · [swagger](https://publicapi.ohgo.com/docs/v1/swagger.json) · [api-key](https://publicapi.ohgo.com/docs/api-key) · [registration](https://publicapi.ohgo.com/docs/registration) · [caching](https://publicapi.ohgo.com/docs/cache)
- **Not verified:**
  - The live count.
  - JSON casing: the swagger uses camelCase `smallUrl`; the HTML docs show PascalCase.

### PA — Pennsylvania

| Source (owner) | API | Auth | Cameras | Coverage | Terms | Enable now |
|---|---|---|---|---|---|---|
| PennDOT Data Feeds; 511PA runs on the IBI platform | RTSP/HTTP stills over a leased private circuit | agreement | "over 950" (PennDOT); 1,537 sites incl. RWIS on the 511PA list | NO PUBLIC FEED | agreement required; site restrictive | no |

- **Metadata:** no public metadata feed.
  - `/api/v2/get/cameras` exists but returns 400 "Invalid Key", and `/developers/doc` is 404, so there is no self-serve key.
  - The documented RCRS API (JSON, HTTP Basic) covers events only.
- **Images:** `https://www.511pa.com/map/Cctv/{id}` is public, but the site terms forbid republication. There are no public streams; the official route is RTSP at 192 kbps per camera over the partner circuit.
- **Access path:**
  - [Data Feed Request Form](https://paiedprod.powerappsportals.us/DataFeedRequestForm/).
  - Then a Nonexclusive Video Sharing License (4–6 weeks).
  - Then a private circuit with setup and monthly fees (60–120 days).
- **Rate limit:** "partner connections are limited to 5 mbps."
- **Attribution:** "Developers must acknowledge the Pennsylvania Department of Transportation or PennDOT as the source of the data."
- **Terms:**
  - [Developer terms PDF](https://www.pa.gov/content/dam/copapwp-pagov/en/penndot/documents/programs-and-doing-business/onlineservices/511pa_developers_corner-tcs.pdf): "Developers may not use PennDOT traffic camera images for any purpose other than to show the current traffic status. Any other use must be pre-approved in writing by PennDOT."
  - Same PDF: "Any multi-user applications must replicate the data from PennDOT Data Feeds to the Developers' servers and provide the data to users from those servers, as opposed to providing direct user access to the PennDOT Data Feeds."
  - [511PA disclaimer](https://www.511pa.com/about/disclaimer): "You must not republish material from this website (including republication on other sites), or reproduce or store material from this site in any public or private retrieval system."
- **CORS:** internal list 200, ACAO absent. Image 200 image/jpeg with duplicate ACAO + credentials, `max-age=60`.
- **Fields:** official fields are unknown (behind the agreement). The internal list has `images[].disabled`/`blocked`, `lastUpdated` (record edit time) and `direction`.
- **Recommendation:** defer. If PA becomes essential, file the request form, ask for HTTP stills without the circuit, and get written approval for the property-context use, which is outside "current traffic status".
- **Evidence:** [request data feeds](https://www.pa.gov/services/penndot/request-access-to-transportation-related-data-feeds) · [video technical requirements](https://www.pa.gov/content/dam/copapwp-pagov/en/penndot/documents/programs-and-doing-business/onlineservices/technical_requirements_to_access_video-final.pdf) · [developer resources](https://www.pa.gov/agencies/penndot/programs-and-doing-business/online-services/developer-resources-documentation-api)
- **Not verified:** the current license text (sent only on request), whether an IBI key would be issued, and PA Turnpike inclusion.

### OK — Oklahoma

| Source (owner) | API | Auth | Cameras | Coverage | Terms | Enable now |
|---|---|---|---|---|---|---|
| OKTraffic.org (ODOT; built by HBE Systems) | undocumented LoopBack JSON | none | 466 web cameras on 228 poles | NO PUBLIC FEED | restrictive | no |

- **Metadata:** `https://oktraffic.org/api/CameraPoles?filter={…mapCameras…streamDictionary…}` is undocumented internal and needs terms confirmation.
  - ODOT's ArcGIS org (470 services) and hub have no camera layer.
  - The only documented oktraffic feed is `/api/Geojsons/workzones`.
- **Images/streams:** no still-image field. Wowza HLS in `streamDictionary.streamSrc` (`https://stream.oktraffic.org/delay-stream/{id}.stream/playlist.m3u8`) returned 404 to a direct request; not pursued.
- **Terms:** [OKTraffic Website Policy](https://oktraffic.org/static/terms) (SPA; text read from the JS bundle): "The camera images being presented on this website are for transportation purposes only, unless otherwise approved. Cameras will not be used intrusively to violate personal privacy."
- **Rate limit / attribution:** none documented.
- **CORS:** API has no ACAO; HLS 404.
- **Fields (internal):** `mapCameras[].status` ("Free" / "Construction" / "Out Of Service"). `mapCameras[].recordTime` (local time, no offset). `mapCameras[].direction`.
- **Recommendation:** do not enable. Ask ODOT (oktraffic@odot.org) for approval and a documented feed. Even then there are no stills.
- **Evidence:** [site bundle](https://oktraffic.org/main.9bb3ab4bdb2ca69b468f.js) · [ODOT open data](https://gis-okdot.opendata.arcgis.com/)
- **Not verified:** why the HLS URLs return 404, and Turnpike Authority inclusion.

### NC — North Carolina

| Source (owner) | API | Auth | Cameras | Coverage | Terms | Enable now |
|---|---|---|---|---|---|---|
| DriveNC (NCDOT), Arcadis IBI TravelIQ platform | IBI 511 v2 REST (JSON/XML) | free key | ~1,154 sites | FULL | silent | no (free key) |

- **Metadata:** `https://www.drivenc.gov/api/v2/get/cameras?key={key}&format=json|xml`. The hinted `eapps.ncdot.gov/services/traffic-prod/v1/cameras` is **retired**; it now returns `{"message":"As of May 27, 2026, information about API data can be found at https://drivenc.gov/help/endpoint/event"}`. TIMS never listed cameras.
- **Images:** `https://www.drivenc.gov/map/Cctv/{viewId}` (e.g. `/map/Cctv/4020`), `max-age=60`.
- **Streams:** HLS in `Views[].VideoUrl` (`https://cfmse01.services.ncdot.gov:8887/chan-{n}_l/index.m3u8`) returned **401**. It is access-controlled; exclude it.
- **Rate limit:** "Throttling is enabled. Ten calls every 60 seconds."
- **Attribution:** not stated publicly; the key-request terms are only visible after login.
- **Terms:** [disclaimer](https://www.drivenc.gov/about/disclaimer): "Live traffic camera video is provided by NCDOT for general travel information only and may be delayed, unavailable, or inaccurate. NCDOT does not guarantee the video's accuracy or suitability for any other use."
- **CORS:** API without a key → 400 "Invalid Key", no ACAO (HEAD 405). Image → 200 image/jpeg, `ACAO: *`.
- **Fields:** `Views[].Status` ("Enabled"/"Disabled"); no last-updated field; `Direction` (None, All Directions, Northbound…, Inbound, Outbound, Both Directions); plus `County`.
- **Recommendation:** register a free key and use `ibi511_v2`. One call per poll is well under the limit.
- **Evidence:** [developers/doc](https://www.drivenc.gov/developers/doc) · [cameras endpoint help](https://www.drivenc.gov/help/endpoint/cameras) · [TIMS webservices](https://tims.ncdot.gov/tims/V2/webservices)
- **Not verified:** the key terms of service, how often `VideoUrl` is populated, and the view count versus the site count.

### TN — Tennessee

| Source (owner) | API | Auth | Cameras | Coverage | Terms | Enable now |
|---|---|---|---|---|---|---|
| TDOT OpenData API (backs SmartWay) | REST JSON (Swagger "OpenData API") | key tied to a "TDOT Api Key Holder account"; no public signup | 661 (TDOT figure) | PARTIAL: Nashville, Memphis, Knoxville and Chattanooga networks plus interstates | agreement required | no |

- **Metadata:** `GET https://www.tdot.tn.gov/opendata/api/public/RoadwayCameras` (and `/{id}`), header `apiKey: {key}`. The Swagger says: "You must input the API Key associated with your TDOT Api Key Holder account".
- **Images:** `thumbnailUrl` → `https://tnsnapshots.com/thumbs/{CAM}.flv.png`, which 301-redirects to `https://tnsnapshots.com/{CAM}.png`.
- **Streams:** untokenised HLS `https://mcleansfs1.us-east-1.skyvdn.com:443/rtplive/{CAM}/playlist.m3u8` (200, `ACAO: *`).
- **Terms:** no API terms found. The TDOT ArcGIS item licence only says "All data presented here is for informational purposes only."
- **Rate limit / attribution:** not documented.
- **CORS:** metadata without a key → 401 (Negotiate/NTLM), ACAO reflects the Origin with credentials. Image 200 image/png, ACAO absent.
- **Fields (from a 2026-06 third-party snapshot, not verified):** `active`; no last-updated field; no direction field (only in `title`/`description`).
- **Recommendation:** the operator asks TDOT ITS/SmartWay for an OpenData key plus written reuse permission. Never reuse the key embedded in the SmartWay web app. The TDOT ArcGIS server has no camera layer.
- **Evidence:** [OpenData index](https://www.tdot.tn.gov/opendata/index.html) · [swagger](https://www.tdot.tn.gov/opendata/swagger/v1/swagger.json) · [TDOT ITS page](https://www.tn.gov/tdot/traffic-operations-division/tsmo-landing-page/intelligent-transportation-systems/integrated-its-smartway-systems.html)
- **Not verified:** how to register, terms, rate limit, live field names, and the live count.

### KS — Kansas

| Source (owner) | API | Auth | Cameras | Coverage | Terms | Enable now |
|---|---|---|---|---|---|---|
| KanDrive (KDOT), Castle Rock CARS | CARS-Hub XML (Basic auth); camera JSON is internal | agreement (credentials) | 608: KC Scout 347, KDOT ITS 204, KDOT RWIS 44, Topeka 9, KTA 4 | NO PUBLIC FEED | agreement required | no |

- **Metadata:**
  - The [hub](https://kscars.kandrive.gov/hub/index.jsf) lists only event (FEU) feeds and Waze CIFS. Every hub path returns 401 `Basic realm="Hub"`.
  - The camera JSON `https://kstg.carsprogram.org/cameras_v1/api/cameras` is undocumented internal and needs terms confirmation.
- **Images:** `views[].url`, e.g. `https://kscam.carsprogram.org/KDOT_573004_IMAGE001.JPG`; KC Scout `https://www.kcscout.net/TransSuite.VCS.CameraSnapshots/{id}-LQ.jpg`.
- **Streams:** 202 HLS views carry a signed JWT (`?token=`, 300 s). Never use them.
- **Access:**
  - Hub: "to obtain access to the data provided by this service, please email KDOT#KanDrive.Contact@ks.gov."
  - Castle Rock: "These XML data feeds will be available once you request access via the CARS XML Feed Request Form and receive a login and password."
- **Terms:** [KanDrive TOU](https://kandrive.gov/help/tou.html) covers My KanDrive accounts only; nothing on data reuse.
- **Rate limit / attribution:** none documented; each record has `cameraOwner.name`.
- **CORS:** internal JSON `ACAO: *`. Images 200, ACAO absent.
- **Fields (internal):** `active`/`public`; `lastUpdated` and `views[].imageTimestamp` (epoch ms); direction only inside `name`.
- **Recommendation:** ask KDOT for CARS-Hub camera access or written permission to poll `cameras_v1`. The 347 KC Scout cameras overlap the Missouri doc.
- **Evidence:** [hub](https://kscars.kandrive.gov/hub/index.jsf) · [Castle Rock XML feeds](https://www.castlerockits.com/xml-data-feeds) · [TOU](https://kandrive.gov/help/tou.html)
- **Not verified:** whether the hub carries a camera file, the rate limit, and KDOT's image-reuse policy.

### MI — Michigan

| Source (owner) | API | Auth | Cameras | Coverage | Terms | Enable now |
|---|---|---|---|---|---|---|
| "MiDrive Cameras" ArcGIS Online layer (owner MDOT_GIS) | ArcGIS FeatureServer | none | 681 (live Mi Drive list ~804) | PARTIAL: statewide freeways, inventory frozen at `dataLastEditDate` 2021-01-14 | silent | **yes**, marked stale |

- **Metadata:** `https://services2.arcgis.com/67lKNkQ2TO1I3lhR/arcgis/rest/services/MiDrive%20Cameras/FeatureServer/0/query?where=1%3D1&outFields=*&f=json` (maxRecordCount 2000). [Item 2bb761d0…](https://www.arcgis.com/home/item.html?id=2bb761d0aec94f8c9995a83607aa79a3) is public but not shared to any open-data group.
- **Images:** `Image` → `https://micamerasimages.net/thumbs/{cam}.flv.jpg?item=1`, which 301-redirects to `/{cam}.jpg`. 3 of 3 spot checks returned 200 with fresh `Last-Modified`.
- **Streams:** none in the layer.
- **Terms:** [Mi Drive disclaimer](https://www.michigan.gov/mdot/about/mi-drive-disclaimer): "Disclaimer: MDOT provides this website for informational purposes only." and "Mi Drive traffic cameras provide live viewing and are not continuously recorded." Nothing on reuse. The item has no licence text.
- **Rate limit / attribution:** none stated.
- **CORS:** metadata 200, `ACAO: *`, `max-age=30`. Image 301 → 200 image/jpeg, ACAO absent.
- **Fields:** status: none; last-updated: none; direction: `Direction` as prose ("Traffic closest to camera is traveling North"). Also `Route`, `County`, `Lat`, `Lon`, `Location`, `Image`.
- **Recommendation:** enable as a no-key baseline flagged stale, and treat a broken image as offline. Ask MDOT for a current feed and reuse confirmation. The live `/MiDrive/camera/*` endpoints are undocumented internal; don't use them.
- **Evidence:** [item](https://www.arcgis.com/home/item.html?id=2bb761d0aec94f8c9995a83607aa79a3) · [disclaimer](https://www.michigan.gov/mdot/about/mi-drive-disclaimer) · [Mi Drive](https://mdotjboss.state.mi.us/MiDrive/map)
- **Fixture:** `apps/api/tests/fixtures/cameras/mi_mdot/midrive_cameras_query.json`
- **Not verified:** MDOT reuse policy, layer refresh cadence, and streams.

### VA — Virginia

| Source (owner) | API | Auth | Cameras | Coverage | Terms | Enable now |
|---|---|---|---|---|---|---|
| 511 Virginia (VDOT; Iteris operates it and the SmarterRoads portal) | agreement-gated feeds | agreement | 1,647 | NO PUBLIC FEED | agreement required | no |

- **Metadata:** none public. The internal `https://511.vdot.virginia.gov/services/511/map/layers/map/cams` (GeoJSON) needs terms confirmation.
- **Images:** `https://snapshot.vdotcameras.com/thumbs/{name}.flv.png`, which 301-redirects to `/{name}.png`.
- **Streams:** HLS/RTSP/RTMP `https://media-sfs7.vdotcameras.com/rtplive/{name}/playlist.m3u8`; not probed.
- **Access:**
  - Video by user agreement with Iteris (511_videosubscription@iteris.com, per the [VDOT media page](https://www.vdot.virginia.gov/news-events/media/)).
  - SmarterRoads needs an account plus the [Data Sharing Use Agreement](https://smarterroads.vdot.virginia.gov/termsOfService).
- **Terms:**
  - VDOT: "The Virginia Department of Transportation makes its 511 traffic video feeds available to third-parties free of charge for internal use or free distribution to the public (e.g., through the media). Video is also available for resale (e.g., by a multi-state video redistributor) for a monthly fee."
  - VDOT: "In order to access the video, a user agreement is required with the organization or company."
  - SmarterRoads: the user "shall not delete or alter any proprietary rights or attribution notices".
- **CORS:** internal GeoJSON `ACAO: *`. Image 200 image/png, ACAO absent.
- **Fields (internal, Iteris ATIS schema shared with SC):** `active`, `problem_stream`; no last-updated field; `direction` (often empty).
- **Recommendation:** the operator emails Iteris. An operator-internal tool may fit the free "internal use" tier.
- **Evidence:** [VDOT media](https://www.vdot.virginia.gov/news-events/media/) · [SmarterRoads ToS](https://smarterroads.vdot.virginia.gov/termsOfService)
- **Not verified:** whether SmarterRoads has a camera dataset (its catalogue returns 401), and the exact Iteris terms.

### NV — Nevada

| Source (owner) | API | Auth | Cameras | Coverage | Terms | Enable now |
|---|---|---|---|---|---|---|
| NVroads 511 (NDOT, plus Las Vegas FAST feeds), Arcadis IBI TravelIQ | IBI 511 v2 | free key | 652 (FAQ says "550+") | FULL | silent | no (free key) |

- **Metadata:** `https://www.nvroads.com/api/v2/get/cameras?key={key}&format=json`.
- **Images:** `https://www.nvroads.com/map/Cctv/{viewId}` (e.g. `/2362`), `max-age=60`.
- **Streams:** HLS in `Views[].VideoUrl` (`https://d2wse2.its.nv.gov:443/…_public.stream/playlist.m3u8`), 200, `ACAO: *`, no token.
- **Rate limit:** "Throttling is enabled. Ten calls every 60 seconds."
- **Attribution:** not specified.
- **Terms:** no public developer terms (`/about/disclaimer` → not found). [FAQ](https://www.nvroads.com/about/faq): "The cameras are provided as a courtesy to the public, but are primarily used by NDOT for traffic monitoring".
- **CORS:** API without a key → 400 "Invalid Key", no ACAO. Image: duplicate ACAO + credentials, which browsers reject.
- **Fields:** `Views[].Status`; no last-updated field; `Direction`.
- **Recommendation:** use `ibi511_v2` after the key. Poll no more than every ~10 min and proxy images for about 60 s. Ask NDOT to confirm redistribution. NDOT's GIS has no camera layer.
- **Evidence:** [developers/doc](https://www.nvroads.com/developers/doc) · [cameras endpoint help](https://www.nvroads.com/help/endpoint/cameras) · [FAQ](https://www.nvroads.com/about/faq)
- **Not verified:** the keyed payload, and terms shown at key request (dot.nv.gov returned 403 to a non-browser UA; not circumvented).

### LA — Louisiana

| Source (owner) | API | Auth | Cameras | Coverage | Terms | Enable now |
|---|---|---|---|---|---|---|
| 511LA (LADOTD), Arcadis IBI TravelIQ | IBI 511 v2 | free key | 336 | FULL | silent | no (free key) |

- **Metadata:** `https://511la.org/api/v2/get/cameras?key={key}&format=json`.
- **Images:** `https://511la.org/map/Cctv/{viewId}`, `max-age=10`; legacy ids such as `b24--1` still resolve.
- **Streams:** HLS `https://ITSStreamingBR2.dotd.la.gov/public/{cam}.streams/playlist.m3u8`, `ACAO: *`, no token.
- **Rate limit:** "Throttling is enabled. Ten calls every 60 seconds."
- **Terms:** [disclaimer](https://511la.org/about/disclaimer) is an "as available" warranty disclaimer; it says nothing about redistribution or commercial use.
- **CORS:** API without a key → 400, no ACAO. Image: duplicate ACAO + credentials.
- **Fields:** `Views[].Status`; no last-updated field; `Direction`. `Views[].Description` gives direction prose.
- **Recommendation:** use `ibi511_v2` after the key.
  - The only no-key fallback is East Baton Rouge's [Traffic_Camera MapServer](https://maps.brla.gov/gis/rest/services/Transportation/Traffic_Camera/MapServer/0): 118 features, metro only, derived from 511LA, last changed 2023.
  - The LADOTD camera view monitor requires a login.
- **Evidence:** [developers/doc](https://511la.org/developers/doc) · [cameras endpoint help](https://511la.org/help/endpoint/cameras)
- **Not verified:** the keyed payload and the terms shown at key request.

### AL — Alabama

| Source (owner) | API | Auth | Cameras | Coverage | Terms | Enable now |
|---|---|---|---|---|---|---|
| ALGO Traffic (ALDOT/ALEA; built by UA CAPS) | undocumented REST JSON; docs behind OIDC login | none technically | 635 (Public 628, ALDOT 4, FirstResponder 3) | NO PUBLIC FEED (none sanctioned) | restrictive | no |

- **Metadata:** `https://api.algotraffic.com/v4.0/Cameras` is undocumented internal and needs terms confirmation.
- **Images:** `snapshotImageUrl` → `https://api.algotraffic.com/v4/Cameras/{id}/snapshot.jpg`.
- **Streams:** `playbackUrls.hls` / `.dash` on Wowza; not probed.
- **Terms:** camera notice in the algotraffic.com bundle: "ALGO Traffic cameras are a public safety tool for use in real time and not intended to be recorded or otherwise used for any commercial purpose. All unauthorized photography, recording, storing, or transmitting of visual material, data, or information gathered from ALGO traffic cameras without the permission of ALDOT is expressly prohibited."
- **Rate limit:** not documented (list `max-age=300`).
- **CORS:** no ACAO on the API or the image.
- **Fields:** `accessLevel` (keep only Public); no last-updated field; `location.direction`.
- **Recommendation:** do not enable without ALDOT's written permission. The ArcGIS "ALDOT Traffic Cameras 2023" item is a stale third-party copy (Baldwin County 911).
- **Evidence:** [algotraffic.com bundle](https://algotraffic.com/assets/index-C9wQEv5T.js) · [3rd-party ArcGIS item](https://www.arcgis.com/sharing/rest/content/items/76cca231f72f446f9735b6e912c04cd0?f=json)
- **Not verified:** API docs, rate limit and ToS (behind login).

### KY — Kentucky

| Source (owner) | API | Auth | Cameras | Coverage | Terms | Enable now |
|---|---|---|---|---|---|---|
| "KYTC - Traffic Cameras" ArcGIS Online layer (KYTC GIS), used by the official GoKY app | ArcGIS FeatureServer | none | 256: 247 KY (246 Online / 1 Offline) + 9 Indiana cross-border with null attributes | FULL, all 12 districts (Louisville-heavy) | silent (disclaimer only) | **yes** |

- **Metadata:** `https://services2.arcgis.com/CcI36Pduqd0OR4W9/arcgis/rest/services/trafficCamerasCur_Prd/FeatureServer/0/query?where=1%3D1&outFields=*&f=json` (maxRecordCount 1000). [Item 00715d24…](https://www.arcgis.com/home/item.html?id=00715d24d2bf42e5abc1fab8a08d45eb) is shared to the "Kentucky Transportation Cabinet Open Data Content" group. Snippet: "Locations updated nightly from on-prem - Images updated every few minutes".
- **Images:** `snapshot` → `https://www.trimarc.org/images/milestone/CCTV_{dd}_{route}_{mile}.jpg`. 13 legacy or cross-border rows use plain `http` (trimarc `/images/snapshots/`, pws.trafficwise.org).
- **Streams:** none in the layer.
- **Terms:** item licence: "DISCLAIMER: The Kentucky Transportation Cabinet (KYTC) does not represent or warrant that the information contained on this website is accurate, complete, current or that the website will operate without interruption or error." Nothing on redistribution.
- **Rate limit / attribution:** none stated. Credit "Kentucky Transportation Cabinet" anyway.
- **CORS:** metadata 200, `ACAO: *`, `max-age=3600`. Image 200 image/jpeg, ACAO absent, `Last-Modified` ~25 s old.
- **Fields:** `status` ("Online"/"Offline"/null); `updateTS` (epoch ms); `direction` ("North", "East-West", …, null). Also `id`, `name`, `state`, `district`, `county`, `highway`, `milemarker`, `description`, `snapshot`, `latitude`, `longitude`.
- **Recommendation:** adopt now. Upgrade `http` image URLs to https where the host supports it. Filter or keep the null-attribute Indiana rows deliberately.
  - GoKY also loads the LFUCG Lexington city layer (108 cameras). Its terms say use means acceptance and include an indemnity, so skip it unless the operator accepts them.
- **Evidence:** [layer](https://services2.arcgis.com/CcI36Pduqd0OR4W9/arcgis/rest/services/trafficCamerasCur_Prd/FeatureServer/0?f=json) · [KYTC open-data group](https://www.arcgis.com/home/group.html?id=88854739925b44889cc40404d6defbdc) · [GoKY](https://goky.ky.gov/) · [KYTC camera map](https://maps.kytc.ky.gov/trafficcameras/)
- **Fixture:** `apps/api/tests/fixtures/cameras/ky_kytc/traffic_cameras_cur_prd_query.json`
- **Not verified:** any KYTC reuse statement beyond the disclaimer, and the TRIMARC (Peraton) image terms.

### MD — Maryland

| Source (owner) | API | Auth | Cameras | Coverage | Terms | Enable now |
|---|---|---|---|---|---|---|
| CHART camera export (MDOT SHA) | documented JSON + XML | none | 552: commMode ONLINE 549 / OFFLINE 3 | FULL | silent | **yes** (metadata + HLS) |

- **Metadata:**
  - JSON: `https://chartexp1.sha.maryland.gov/CHARTExportClientService/getCameraMapDataJSON.do`, wrapper `{data[], error, success, totalCount, warnings}`.
  - XML: `https://chart.maryland.gov/DataFeeds/GetCamerasXml`.
  - Both are listed with field descriptions on the official [Data Feeds page](https://chart.maryland.gov/DataFeeds/GetDataFeeds) under "Live Traffic Cameras".
  - Alternative: [CHART/Cameras MapServer](https://chartimap1.sha.maryland.gov/arcgis/rest/services/CHART/Cameras/MapServer/0) (552 rows; `ID`, `location`, `url` (rtmp), `CCTVPublicURL`, `hlsurl`). It has no status or still-image URL and isn't on the feeds page.
- **Images:** `https://chart.maryland.gov/wwwroot/thumbnails/{id}.jpg` (~8.5 KB). This path comes from the CHART cameras-page JS, not the feed docs, so it needs confirmation. `publicVideoURL` is an HTML player page.
- **Streams:** HLS `https://{cctvIp}/rtplive/{id}/playlist.m3u8`, public, 200, `ACAO: *`, no token.
- **Rate limit:** none documented. The feed is `no-cache`; poll at 60 s or slower.
- **Attribution:** not specified; credit "MDOT SHA CHART". The footer says "© Copyright chart.maryland.gov. All rights reserved."
- **Terms:** feeds page has no licence. [Cameras page](https://chart.maryland.gov/TrafficCameras/GetTrafficCameras): "The Live cameras are for viewing current traffic conditions only. We do not store any images or video from the live cameras; therefore we are not able to provide historical video or images for any reason."
- **CORS:** JSON has no ACAO (GET and HEAD). Thumbnail 200 image/jpeg, no ACAO. HLS `ACAO: *`. XML HEAD → 405.
- **Fields:**
  - Status: `commMode` (ONLINE/OFFLINE/MAINT_MODE) + `opStatus` (OK/COMM_FAILURE/HARDWARE_FAILURE/COMM_MARGINAL/HARDWARE_WARNING).
  - Last-updated: `lastCachedDataUpdateTime` (epoch ms).
  - Direction: no field (only in `name`/`description`).
  - Also `cameraCategories`, `cctvIp`, `id`, `lat`, `lon`, `milePost`, `routePrefix`/`routeNumber`/`routeSuffix`, `publicVideoURL`.
- **Recommendation:** enable now for metadata + HLS. Confirm the thumbnail path and property-context use with CHART before showing stills. "Current traffic conditions only" is a use-statement to respect.
- **Fixture:** `apps/api/tests/fixtures/cameras/md_chart/export_camera_map_data.json`
- **Not verified:** an explicit reuse licence, whether the thumbnail path is sanctioned, and its refresh cadence.

### RI — Rhode Island

| Source (owner) | API | Auth | Cameras | Coverage | Terms | Enable now |
|---|---|---|---|---|---|---|
| RIDOT "Rhodeways" MapServer layer 6 "Camera" on the State enterprise GIS (risegis.ri.gov); feeds RIDOT's official camera map | ArcGIS MapServer query | none | 143, all `Enabled=1` | FULL | silent; needs terms confirmation | no (ask RIDOT) |

- **Metadata:** `https://risegis.ri.gov/hosting/rest/services/RIDOT/Rhodeways/MapServer/6/query?where=1%3D1&outFields=*&outSR=4326&f=json`. It is undocumented internal (found in the RIDOT map page source; the REST directory is browsable but not catalogued). Native SR is RI State Plane (3438); the attributes also carry `Latitude`/`Longitude`.
- **Images:** `CCVEWebURL` → `https://www.dot.ri.gov/img/travel/camimages/{Description}.jpg`. The URLs contain spaces, 94 are `http`, some have trailing tabs and 4 are null, so normalize them.
- **Streams:** Wowza HLS found via an undocumented `cameras.php`; a copied playlist returned 403 and was not pursued.
- **Terms:** no RIDOT data terms. [ri.gov copyright](https://www.ri.gov/policies/copyright/): "The State of Rhode Island makes the content of this WWW site available to the public. However, the State of Rhode Island makes no warranty that materials contained herein are free of copyright claims or other restrictions or limitations on fair use or display."
- **Attribution:** `copyrightText` "RIDOT".
- **CORS:** metadata 200, ACAO reflects the Origin with credentials. Image 200 image/jpeg, ACAO absent, `Last-Modified` ~1 min.
- **Fields:** `Enabled`; no last-updated field; `Direction` (NB/SB/EB/WB). Also `EquipmentID`, `Description`, `CCVEWebURL`. Drop `Cost` and `EndofLifeDate` in the adapter.
- **Recommendation:** best RI option once RIDOT confirms reuse. It ranks 6th on feasibility because it is undocumented, so no fixture was taken. A server-side `resultRecordCount=15` query on the layer would produce one.
- **Evidence:** [RIDOT camera map](https://www.dot.ri.gov/travel/traffic_camera_map/) · [layer](https://risegis.ri.gov/hosting/rest/services/RIDOT/Rhodeways/MapServer/6?f=json)
- **Not verified:** RIDOT permission, stream access, and image refresh rate.

### WA — Washington

| Source (owner) | API | Auth | Cameras | Coverage | Terms | Enable now |
|---|---|---|---|---|---|---|
| WSDOT Travel Information Cameras (self-hosted ArcGIS; item owner OnlineMapSupport_WSDOT) | ArcGIS FeatureServer (+ no-key KML; keyed Traveler API) | none (AccessCode optional) | 1,706 incl. airports 99, ferries 45, Oregon/TripCheck ~64 | FULL | low volume + indemnity; silent on redistribution | **yes** |

- **Metadata:**
  - `https://data.wsdot.wa.gov/arcgis/rest/services/TravelInformation/TravelInfoCamerasWeather/FeatureServer/0/query?where=1=1&outFields=*&outSR=4326&f=json` (maxRecordCount 2000).
  - No-key KML twin: `https://wsdot.wa.gov/traffic/api/HighwayCameras/kml.aspx` (1,706 placemarks).
  - Keyed: `…/HighwayCamerasREST.svc/GetCamerasAsJson?AccessCode={code}`.
- **Images:** `https://images.wsdot.wa.gov/{region}/{file}.jpg`. Folders: nw, sw, orflow, rweather, airports, spokane, nc, sc, wsf. Some rows point at tripcheck.com or Azure blob storage. Images are "refreshed approximately every 5 minutes".
- **Streams:** none.
- **Rate limit:** numeric limit not published; licence says "low volume" only.
- **Attribution:** `accessInformation` "Washington State Department of Transportation".
- **Terms:** [item licence](https://www.arcgis.com/home/item.html?id=6692b4f163bd4ec99b5a897b2d207aa6):
  - "This data feed is intended for “low volume” use only. The Washington State Department of Transportation (WSDOT) may cancel or restrict access for any reason."
  - It also says "the Data User shall hold harmless, defend at its own expense, and indemnify WSDOT…"
- **CORS:** ArcGIS 200, ACAO reflects the Origin with credentials, `max-age=0`. KML no ACAO. Image 200 image/jpeg, ACAO absent, `Last-Modified` present.
- **Fields:** status: none (the keyed API has `IsActive`); last-updated: none; direction: `CompassDirection` (B/N/S/E/W/O/null). Also `OBJECTID`, `CameraTitle`, `ImageURL`.
- **Recommendation:** enable now via ArcGIS, polling server-side at low volume. Filter `airports`, `wsf` and non-WSDOT hosts if the map should show roadway cameras only. Optionally register an AccessCode later for `IsActive`, owner and milepost.
- **Evidence:** [Traveler API](https://wsdot.wa.gov/traffic/api/) · [HighwayCameras docs](https://wsdot.wa.gov/traffic/api/Documentation/group___highway_cameras.html) · [travel-info disclaimer](https://wsdot.wa.gov/about/policies/travel-information-disclaimer)
- **Fixture:** `apps/api/tests/fixtures/cameras/wa_wsdot/travel_info_cameras_query.json`. Its first row is an Oregon TripCheck camera, which is a useful filter edge case.
- **Not verified:** meaning of `CompassDirection` "B"/"O", a numeric rate limit, and a WSDOT image-copyright policy (the footer only says "Image Copyright WSDOT ©").

### CT — Connecticut

| Source (owner) | API | Auth | Cameras | Coverage | Terms | Enable now |
|---|---|---|---|---|---|---|
| CTroads (CTDOT), Arcadis IBI; imagery sourced via TrafficLand | IBI v2 documents only signs, events and alerts | free key, which doesn't cover cameras | 347 | NO PUBLIC FEED | restrictive | no |

- **Metadata:** no camera resource in the [CT API docs](https://ctroads.org/developers/doc). `/api/v2/get/cameras` → 400 without a key; `/help/endpoint/cameras` → 500.
- **Images:** `https://ctroads.org/map/Cctv/{id}` (`no-store`); the sampled camera's `source` is "TRAFFICLAND". No public streams.
- **Terms:** [terms and conditions](https://ctroads.org/termsandconditions): "Redistribution or republication of any part of ctroads.org or its content is prohibited, including by such methods as framing, other similar methods or by any other means, without the prior express written consent of CTDOT."
- **CORS:** API 400, no ACAO. Image: duplicate ACAO + credentials.
- **Recommendation:** skip. It would need CTDOT written consent and probably TrafficLand licensing. data.ct.gov and geodata.ct.gov have no camera datasets.
- **Not verified:** whether a CT key returns cameras, and the TrafficLand share.

---

## Optional states

### CO — Colorado

| Source (owner) | API | Auth | Cameras | Coverage | Terms | Enable now |
|---|---|---|---|---|---|---|
| COtrip (CDOT), Castle Rock CARS "511x"; data portal manage-api.cotrip.org | keyed data API (JSON/XML) | key after approval + ToS | 1,020 cameras / 1,329 views (internal count) | UNKNOWN | agreement required | no |

- **Metadata:**
  - The portal lists "Cameras – Latest photo from the still cameras – cameras.xml" (`/xml/cameras.xml?apiKey=`), but `https://data.cotrip.org/xml/cameras.xml` returns 404 "not defined by this API". The route may be retired.
  - The current [feed-access help page](https://www.cotrip.org/help/117/Traveler-Information-Data-Feed-Access) lists no cameras.
  - The working source is internal `https://api-511x-co.carsprogram.org/cameras/map-features`, which needs terms confirmation.
- **Images:** `https://cocam.carsprogram.org/Snapshots/{code}.flv.png` (served as image/jpeg).
- **Streams:** untokenised HLS `https://publicstreamer{n}.cotrip.org:443/rtplive/{code}/playlist.m3u8`, `ACAO: *`.
- **Terms:** "These data feeds will be available once you request access via the Subscription Request page and register." And: "After requesting access, you will need to accept CDOT's Terms of Service Policy." The ToS itself is not public.
- **CORS:** keyed API → 403 without a key. Internal `ACAO: *`. Image: ACAO absent.
- **Fields (internal):** `views[].broken` / `public`; `lastUpdated`, `views[].imageTimestamp`; direction only in `name`.
- **Recommendation:** the operator registers at [manage-api.cotrip.org](https://manage-api.cotrip.org/), reads the ToS and confirms whether a camera feed still exists. Otherwise ask CDOT ITS for CARS camera access. The Esri "CDOT_Traffic_Cameras_V2" layer is a stale 2017 copy.
- **Not verified:** the ToS text, whether `cameras.xml` is live, and the rate limit.

### NY — New York

| Source (owner) | API | Auth | Cameras | Coverage | Terms | Enable now |
|---|---|---|---|---|---|---|
| 511NY (NYSDOT), Arcadis IBI | IBI 511 v2 (and legacy) | free key + Developer's Access Agreement | ~1,877 sites (internal list) | FULL, statewide incl. NYC | permits with attribution, unaltered | no (free key) |

- **Metadata:** v2 `https://511ny.org/api/v2/get/cameras?key={key}&format=json|xml`; legacy `…/api/getcameras?key={key}&format=json|xml`.
- **Images:** `https://511ny.org/map/Cctv/{viewId}`, `max-age=60`.
- **Streams:** HLS `Views[].VideoUrl`, e.g. `https://s52.nysdot.skyvdn.com/rtplive/R5_013/playlist.m3u8`, no token, `ACAO: *`.
- **Rate limit:** "Throttling is enabled. Ten calls every 60 seconds."
- **Terms:** [DAA](https://511ny.org/developers/daa):
  - "The Data Disseminator may redistribute, enhance, repackage, or otherwise add value to the provided data. However, the integrity of the source data must be preserved and cannot be altered in any way."
  - "There is no fee associated with the 511NY Real-Time and Static Data Feed."
  - Attribution is encouraged ("powered by 511NY" plus logo and link); the logo is otherwise restricted.
- **Caveat:** every 511NY page, including the DAA, now carries this banner: "UCI/FOUO may be distributed only after permission of the public information officer and the regional records access officer has granted and identified the recipient(s) and use of information." It conflicts with the DAA; ask NYSDOT.
- **CORS:** API without a key → 400, no ACAO. Image: duplicate ACAO + credentials. HLS `ACAO: *`.
- **Fields:** v2 `Views[].Status`, no last-updated field, `Direction`. Legacy `Disabled`/`Blocked`, `DirectionOfTravel`.
- **Recommendation:** best `ibi511_v2` candidate after the key. Don't use the legacy endpoint's missing key enforcement.
  - NYC DOT `webcams.nyctmc.org/api/cameras` (971 cameras, no key) is undocumented internal and needs terms confirmation.
  - data.ny.gov has no camera dataset.
- **Evidence:** [developers/doc](https://511ny.org/developers/doc) · [cameras endpoint help](https://511ny.org/help/endpoint/cameras)
- **Not verified:** the v2 payload and count, whether keys are issued instantly, the meaning of the FOUO banner, and NYC DOT inclusion.

### NJ — New Jersey

| Source (owner) | API | Auth | Cameras | Coverage | Terms | Enable now |
|---|---|---|---|---|---|---|
| none: 511NJ (NJDOT/TRANSCOM) uses a token-authenticated internal API; the TRANSCOM free feed has events and travel times only | none | agreement (TRANSCOM members / OpenReach) | NJTA 136 (Turnpike 71, Parkway 65); 511NJ unknown | NO PUBLIC FEED | agreement required | no |

- **What exists:**
  - NJ Turnpike Authority embeds HLS camera records as JSON in the `data-block-config` attribute of its [camera-list page](https://www.njta.gov/travel-resources/camera-list/). Streams are at `https://wink.njta.com/203/public/hls/{GUID}_nj.m3u8` (200, ACAO reflects the Origin). This is undocumented consumer HTML, and there are no stills.
  - The [TRANSCOM data service](https://data.xcmdata.org/DEWeb/Pages/aboutus) offers "real-time event and link (travel time) data", with no cameras.
- **Recommendation:** defer. Ask NJDOT/TRANSCOM about a CCTV data-sharing agreement, and ask NJTA for a sanctioned feed.
- **Not verified:** the 511NJ camera count, and whether NJDOT shares CCTV with third parties at all.

### MA — Massachusetts

| Source (owner) | API | Auth | Cameras | Coverage | Terms | Enable now |
|---|---|---|---|---|---|---|
| Mass511 (MassDOT) runs on Castle Rock CARS, not IBI; imagery is brokered by TrafficLand; MassDOT "Assets/CCTV" ArcGIS asset layer | ArcGIS FeatureServer (metadata) / TrafficLand API (imagery) | none (metadata) / agreement (imagery) | 308 on Mass511; 845 assets (644 In Service) | METADATA ONLY | agreement required for imagery | no |

- **Metadata:** `https://gis.massdot.state.ma.us/arcgis/rest/services/Assets/CCTV/FeatureServer/0/query?where=1=1&outFields=*&f=json`. It is listed on the MassDOT hub (item 4ffcd943…, licence null) and has no image URLs.
  - It includes editor usernames (`created_user`/`last_edited_user`); redact these if it is ever used.
- **Imagery:** a TrafficLand agreement. The paraphrased mass.gov guidance (verbatim unverified; the page returns 403 to automated clients) is JPEG at 1 frame per 120 s, by emailing TrafficLand.
  - The CARS payload contains `api.trafficland.com` URLs with an embedded key; never reuse it.
- **CORS:** ArcGIS reflects the Origin with credentials. CARS image `ACAO: *`, about 20 h stale when sampled.
- **Fields (asset layer):** `Status`, `last_edited_date`, `Direction` ("EB").
- **Recommendation:** skip for imagery unless the operator engages TrafficLand.
- **Evidence:** [asset layer](https://gis.massdot.state.ma.us/arcgis/rest/services/Assets/CCTV/FeatureServer) · [MassDOT open data](https://geo-massdot.opendata.arcgis.com) · [Mass511 terms](https://mass511.com/termsandconditions) (JS-rendered, not read)
- **Not verified:** the Mass511 terms, verbatim mass.gov text, and TrafficLand terms and pricing.

### WI — Wisconsin

| Source (owner) | API | Auth | Cameras | Coverage | Terms | Enable now |
|---|---|---|---|---|---|---|
| 511WI (WisDOT), IBI platform | IBI 511 v2 | key on application and approval, plus the Developers Access Agreement | 490 (34 at 0,0 must be filtered) | FULL (via key) | agreement required (restrictive) | no |

- **Metadata:** `https://511wi.gov/api/v2/get/cameras?key={key}&format=json`. It adds `Region` and `County`.
- **Images:** `https://511wi.gov/map/Cctv/{viewId}`.
- **Streams:** HLS `https://cctv1.dot.wi.gov/rtplive/{cam}/playlist.m3u8`, `ACAO: *`.
- **Key process:** "submit the reasons for the API Key request. Once approved, you will receive an email with your Developer API key." ([developer resources](https://511wi.gov/developers/resources))
- **Terms:** [DAA](https://511wi.gov/Cms/GetFile?id=60dc61b7-2bf0-ed11-abd6-06b534637530.133282862079100000):
  - "Any commercial or public use of the data or video available on the 511WI website by a third-party requires explicit written consent from WisDOT prior to its use."
  - "Data and video provided by WisDOT may not be altered in any way by Developer."
- **Attribution:** mandatory WisDOT logo or caption plus copyright notice.
- **Rate limit:** "Ten calls every 60 seconds."
- **Recommendation:** defer until WisDOT gives written consent. There is no no-key alternative.
- **Not verified:** the keyed payload, approval turnaround, and whether the 0,0 rows also appear in the API.

### UT — Utah

| Source (owner) | API | Auth | Cameras | Coverage | Terms | Enable now |
|---|---|---|---|---|---|---|
| UDOT Traffic (UDOT), IBI | IBI 511 v2 | free key | 2,081 (Wasatch Front ~1,334) | FULL | silent | no (free key) |

- **Metadata:** `https://www.udottraffic.utah.gov/api/v2/get/cameras?key={key}&format=json`.
- **Images:** `https://www.udottraffic.utah.gov/map/Cctv/{viewId}`, `max-age=60`.
- **Streams:** none observed.
- **Rate limit:** "Throttling is enabled. Ten calls every 60 seconds."
- **Terms:** [disclaimer](https://udottraffic.utah.gov/about/disclaimer): "Traveler information is provided by UDOT as a public service. Information is published automatically; accuracy or timeliness cannot be guaranteed."
- **CORS:** API 400 without a key. Image sends a comma-joined `access-control-allow-origin: *,https://example.org` plus credentials, which is invalid.
- **Fields:** `Views[].Status`; no last-updated field; `Direction` ("North"/"East"); `Views[].Description` like "Looking East".
- **Recommendation:** it's the largest inventory in scope, so worth the free key. There is no no-key mirror:
  - The Utah Open Data camera dataset has been decommissioned.
  - The UPlan "Live_View_Cameras" layer has only 32 rows.
- **Not verified:** the keyed payload, terms at key request, and local-agency camera terms.

### OR — Oregon

| Source (owner) | API | Auth | Cameras | Coverage | Terms | Enable now |
|---|---|---|---|---|---|---|
| TripCheck API (ODOT Developer Portal, Azure APIM) | REST JSON/XML | free key (auto-approved) | ~1,188 (from the Oregon OEM mirror; API count needs a key) | FULL | permits with attribution + mirroring + disclaimer | no (free key) |

- **Metadata:** `https://api.odot.state.or.us/tripcheck/Cctv/Inventory`, header `Ocp-Apim-Subscription-Key`. Filters: `DeviceId`, `DeviceName`, `RouteId`, `Bounds`. Shape: `CctvInventory{organization-information, CCTVInventoryRequest[]}`.
- **Images:** `cctv-url` → `https://tripcheck.com/RoadCams/cams/{name}_pid{n}.JPG`.
- **Streams:** none.
- **Rate limit:** 429 "Message request rate limit exceeded" is documented, with no number. The inventory refreshes every 24 h.
- **Terms:** [product terms](https://apiportal.odot.state.or.us/product#product=tripcheck-api-data):
  - "a. Republishers must credit the public agency providing the data."
  - "b. Republisher must mirror the data found on this site. To mirror a file means that the re-publisher's server must download a copy periodically and use the copy on its own server on its page."
  - (c) requires repeating ODOT's disclaimer.
- **CORS:** 401 `WWW-Authenticate: AzureApiManagementKey` without a key. Image 200, ACAO absent.
- **Fields:** status: none; `last-update-time`; direction: none (in `device-name`). Also `device-id`, `latitude`, `longitude`, `route-id`, `milepoint`, `cctv-url`.
- **Recommendation:** register the free key. The adapter **must** proxy and cache images rather than hotlink, and must show agency credit plus the disclaimer. The OEM ArcGIS mirror (`services.arcgis.com/uUvqNMGPm7axC2dD/…/TripCheck_Cameras`) is a secondary copy; don't make it primary.
- **Evidence:** [TripCheck API page](https://www.tripcheck.com/Pages/API) · [getting-started PDF](https://www.tripcheck.com/pdfs/TripCheckAPI_Getting_Started_GuideV5.pdf)
- **Not verified:** a real payload and count, and the numeric rate limit.

### SC — South Carolina

| Source (owner) | API | Auth | Cameras | Coverage | Terms | Enable now |
|---|---|---|---|---|---|---|
| 511SC (SCDOT), Iteris SafeTravel4 | undocumented CDN GeoJSON | none technically | 795 | NO PUBLIC FEED | restrictive | no |

- **Metadata:** `https://sc.cdn.iteris-atis.com/geojson/icons/metadata/icons.cameras.geojson` is undocumented internal and needs terms confirmation. `/developers/doc` returns 404.
- **Images:** `https://scdotsnap.us-east-1.skyvdn.com/thumbs/{name}.flv.png`.
- **Streams:** HLS on skyvdn; not probed.
- **Terms:** [disclaimer](https://www.511sc.org/static/disclaimer.html): "You may not modify, publish, transmit, display, participate in the transfer or sale, create derivative works or in any way exploit, any of the content, in whole or in part, without the express written permission of SCDOT."
- **Fields:** `active`, `problem_stream`; no last-updated field; `direction`.
- **Recommendation:** do not enable without SCDOT's written permission. A historic [broadcaster agreement](https://ops.fhwa.dot.gov/travelinfo/resources/datashare/app2scdt.htm) exists.

### IA — Iowa

| Source (owner) | API | Auth | Cameras | Coverage | Terms | Enable now |
|---|---|---|---|---|---|---|
| Iowa DOT Traffic Cameras (CCTV) ArcGIS Online layer (owner IowaDOT_OTO); 511IA itself runs on CARS | ArcGIS FeatureServer | none | 1,259 rows = 860 `device_id`s; `Type`: Iowa DOT 742, RWIS 364, Rest Area/Parking 153 | FULL | permits with attribution (CC BY 4.0) | **yes** |

- **Metadata:** `https://services.arcgis.com/8lRhdTsQyJpO52F1/arcgis/rest/services/Traffic_Cameras_View/FeatureServer/0/query?where=1=1&outFields=*&outSR=4326&f=json` (maxRecordCount 1000, so paginate). The keyed alternative `https://ia.carsprogram.org/hub/data/cctv.xml` needs Castle Rock credentials.
- **Images:** `ImageURL` → `https://atmsqf.iowadot.gov/SNAPSHOTS/PUBLIC/{Metro|RWIS|RestAreas}/{name}.jpeg|jpg`.
- **Streams:** untokenised HLS in `VideoURL` (`https://video{n}.iowadot.gov:8888/{area}/{cam}/playlist.m3u8`, 701 rows), `ACAO: *`.
- **Terms:**
  - [Iowa DOT terms](https://iowadot.gov/policies-statements/terms-use): "These licenses allow you to copy, share, adapt, transform, and build upon the Data for any purpose, including commercial use, provided that you give appropriate credit to the Data source, which may be the Iowa Department of Transportation or a third party, and comply with the terms of the applicable license."
  - [511 data feeds](https://iowadot.gov/travel-tools/iowa-511/511-data-feeds): "These and other feature services can be found on our DOT Data Portal and do not require credentials to access."
  - Caveat: the general site-content terms limit site content to "personal, educational, and noncommercial use", and the CC licence doesn't explicitly cover the image pixels.
- **Rate limit:** none published.
- **Attribution:** "Iowa Department of Transportation".
- **CORS:** metadata `ACAO: *`, `max-age=30`. Image 200 image/jpeg, ACAO absent. HLS `ACAO: *`.
- **Fields:** status: none (`RECORDED` is a recording flag). Last-updated: `UpdateDate` (YYYYMMDD) + `UpdateTime` (HHMMSS) + `UTCoffset` (-500), a record stamp; the layer is "updated once a day". Direction: none (in `Desc_`). Also `device_id`, `Route`, `VideoURL`, `ORG`, `Type`, `REGION`, `COMMON_ID`, `FUNCTION`.
- **Recommendation:** enable now. Group rows by `device_id`, treat RWIS and rest-area cameras as their own kinds, credit Iowa DOT, and poll metadata daily. Confirm image reuse in a commercial product with Iowa DOT when convenient.
- **Evidence:** [item](https://www.arcgis.com/home/item.html?id=c4063f200a7b4da5826e2ac86c677cf5) · [511 feed terms](https://iowadot.gov/policies-statements/511-data-feed-terms-conditions) · [CCTV ICD](https://ia.carsprogram.org/hub/Hub%20CCTV%20ICD%20-%20Third%20Party.pdf)
- **Fixture:** `apps/api/tests/fixtures/cameras/ia_iowadot/traffic_cameras_view_query.json`
- **Not verified:** whether CC BY covers the image content.

### NE — Nebraska

| Source (owner) | API | Auth | Cameras | Coverage | Terms | Enable now |
|---|---|---|---|---|---|---|
| Nebraska 511 (NDOT), Castle Rock CARS | CARS-Hub XML has events only; camera JSON is internal | agreement (CARS-Hub credentials) | 348 cameras / 1,053 views | NO PUBLIC FEED | silent | no |

- **Metadata:** the [hub](https://ne.carsprogram.org/hub/index.jsf) lists FEU-g, FEU-i and CIFS only. The internal `https://netg.carsprogram.org/cameras_v1/api/cameras` needs terms confirmation.
- **Images:** `https://dot511.nebraska.gov/images/vid-{id}-{nn}.jpg`.
- **Streams:** none.
- **Terms:** the linked NDOT CARS terms PDF returns 404; the help pages are JS-rendered.
- **Fields (internal):** `public`; `lastUpdated` (~4 h ahead of the real time, which looks like a timezone bug); `views[].name` holds the direction.
- **Recommendation:** lowest priority. Request access via the Castle Rock form or NDOT.

---

## Fixtures (no-key feeds, top 5 by feasibility)

The 5 are chosen for being official, documented, key-free, with terms that don't forbid the use, and for coverage. All were fetched without credentials on 2026-09-30. Structure and field names are kept exactly; no images were saved.

| provider_id | File | Request | Fetched (UTC) | Sample |
|---|---|---|---|---|
| `md_chart` | `apps/api/tests/fixtures/cameras/md_chart/export_camera_map_data.json` | `GET https://chartexp1.sha.maryland.gov/CHARTExportClientService/getCameraMapDataJSON.do` | 11:14:49 | Wrapper kept; `data` cut client-side to the first 15 of 552 (`jq '.data \|= .[0:15]'`); `totalCount` still reads 552 |
| `ky_kytc` | `…/ky_kytc/traffic_cameras_cur_prd_query.json` | `…/trafficCamerasCur_Prd/FeatureServer/0/query?where=(OBJECTID>=594167 AND OBJECTID<=594180) OR status='Offline'&outFields=*&orderByFields=OBJECTID&resultRecordCount=15&f=json` | 10:46:56 | 15 of 256, unmodified: 6 null-attribute Indiana rows, 8 Online, 1 Offline, chosen for edge cases |
| `ia_iowadot` | `…/ia_iowadot/traffic_cameras_view_query.json` | `…/Traffic_Cameras_View/FeatureServer/0/query?where=1=1&outFields=*&outSR=4326&resultRecordCount=15&orderByFields=FID&f=json` | 11:15:52 | 15 of 1,259 rows, unmodified |
| `wa_wsdot` | `…/wa_wsdot/travel_info_cameras_query.json` | `…/TravelInfoCamerasWeather/FeatureServer/0/query?where=1=1&outFields=*&outSR=4326&resultRecordCount=15&orderByFields=OBJECTID&f=json` | 10:08:50 | 15 of 1,706, unmodified |
| `mi_mdot` | `…/mi_mdot/midrive_cameras_query.json` | `…/MiDrive%20Cameras/FeatureServer/0/query?where=1%3D1&outFields=*&resultRecordCount=15&orderByFields=OBJECTID&f=json` | 10:40:59 | 15 of 681, unmodified |

RI (the no-key RIDOT layer) was not taken because it is undocumented and needs terms confirmation. MA's asset layer has no image URLs. The OK, AL and SC endpoints are undocumented and their terms are restrictive.

## Operator actions

**Free keys (self-serve), by platform:**
- **Arcadis IBI 511:** create an account at `/my511/register`, then request a developer key on `/developers/doc`:
  - [DriveNC](https://www.drivenc.gov/my511/register) (NC)
  - [NVroads](https://www.nvroads.com/my511/register) (NV)
  - [511LA](https://511la.org/my511/register) (LA)
  - [511NY](https://511ny.org/my511/register) (NY; accept the [DAA](https://511ny.org/developers/daa))
  - [UDOT Traffic](https://udottraffic.utah.gov/my511/register) (UT)
- **OHGO** (OH): <https://publicapi.ohgo.com/accounts/registration>. The key appears on the account page.
- **ODOT Developer Portal** (OR): <https://apiportal.odot.state.or.us/signup>, then subscribe to "TripCheck Data" (auto-approved).
- **WSDOT Traveler Information API** (WA, optional upgrade): an AccessCode by email at <https://wsdot.wa.gov/traffic/api/>.
- **COtrip data portal** (CO): <https://manage-api.cotrip.org/>. It requires approval plus ToS, and it is unconfirmed that a camera feed exists.

**Agreements or written permission (not self-serve):**
- PennDOT: request form, video license and private circuit.
- VDOT: Iteris video subscription or SmarterRoads DSUA.
- WisDOT: key approval plus written consent.
- TDOT: OpenData key.
- KDOT / NDOT: CARS-Hub credentials via the Castle Rock form.
- MassDOT and CTDOT: TrafficLand licensing, plus CTDOT consent.
- NJDOT / TRANSCOM.
- ALDOT, SCDOT, and ODOT (Oklahoma).

**Confirmations for sources already usable:**
- RIDOT: reuse of the Rhodeways layer.
- MDOT SHA: the CHART thumbnail path and property-context use.
- MDOT (Michigan): a current feed and reuse.
- Iowa DOT: image reuse in a commercial product.
- KYTC / TRIMARC: image terms.

## Not verified (consolidated)

- **Keyed payloads were never seen.** No live responses from OHGO, IBI v2 (NC, NV, LA, NY, UT, WI), TripCheck, TDOT, the WSDOT Traveler API or COtrip. Field names come from the docs or swagger, and OH's live count is unconfirmed.
- **Terms behind a login or form were not read.** This covers the IBI key-request ToS, the CDOT ToS, the PennDOT video licence, the Iteris/VDOT agreement, TrafficLand, and the Mass511 terms (JS-rendered). The mass.gov developer page returned 403.
- **Image licensing is unconfirmed nearly everywhere.** Only Iowa (data, CC BY) and 511NY (DAA) give an explicit redistribution grant. Every "yes" in the matrix is "no key and no prohibition found", not an affirmative licence.
- **Some streams could not be tested.** OK and RI (404/403); NC (401); VA, SC and AL were not probed.
- **Several counts come from undocumented internal endpoints, each read once.** These are NV, LA, WI, UT, NC, NY, PA, CT, KS, CO, NE, VA, SC, OK and AL. OR's count comes from a third-party mirror, and TN's from TDOT's page plus a third-party snapshot.
- **The meaning of some values is unknown.** WSDOT `CompassDirection` "B"/"O", and the NE `lastUpdated` offset.
