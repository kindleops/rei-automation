# Camera Network — provider discovery: priority states

Scope: Texas, California, Georgia, Missouri, Indiana, Illinois, Arizona. Research snapshot **2026-09-30 (UTC)**. Minnesota and Florida are covered in `mn-fl.md`, and the other operating states in `remaining-states.md`.

This is discovery research only. No adapter code exists yet. Every claim below comes from a live request or an official page, both linked. Anything we could not confirm is marked **unverified**.

## Method and conventions

- Requests used the User-Agent `LeadCommand-CameraDiscovery/0.1 (public agency camera provider research; low-volume manual requests)`.
- Request volume was minimal: one metadata pull per endpoint and 1–2 image or playlist probes per provider.
- We did not register for anything, enter credentials, guess API keys, or bypass CAPTCHA or signed/tokenised URLs.
- CORS: every metadata endpoint and 1–2 image URLs were probed with `curl -sI`, once plain and once with `Origin: https://ops.leadcommand.ai`. "ACAO" means `Access-Control-Allow-Origin`.
- Quoted terms are verbatim and at most two sentences each. "not addressed" means the official terms are silent on that point.
- **undocumented internal endpoint — needs terms confirmation** marks JSON that a consumer web map uses but that is not published as an API. These are never recommended unless the terms allow it. Fixtures taken from them carry an `internal_` filename prefix.
- Fixtures live in `apps/api/tests/fixtures/cameras/<provider_id>/`. They keep the original response structure and field names; only the camera array is truncated, to ≤ 15 records. Provenance for each fixture (source URL, fetch time, truncation method) is recorded in the provider's **Fixture** line.

### Coverage status vocabulary

| Status | Meaning |
|---|---|
| FULL | Statewide (or the agency's whole network), machine-readable, with coordinates and usable image/stream URLs |
| PARTIAL | Machine-readable, but part of the state/network is missing, or the data is stale or thin |
| METRO ONLY | Machine-readable, covering one metro/region |
| METADATA ONLY | Locations/metadata published, but no usable imagery URLs |
| NO PUBLIC FEED | No official machine-readable camera feed (consumer site only, or none) |
| UNKNOWN | Could not be determined |

### Image-handling vocabulary

| Mode | Meaning for the aggregator |
|---|---|
| proxy+cache (short TTL) | The server fetches stills, caches them ~60–120 s (never longer than the source cadence justifies), and serves them from our origin with attribution. This spares agency servers and avoids browser CORS limits. |
| reference official URL directly | The browser loads the agency's own image/stream URL (`<img src>` / hls.js). We store metadata only. |
| link-out only | Show the camera's location and a link to the official page. No imagery is displayed inside LeadCommand. |

## Ranked recommendation

Ranked by how soon each source can ship legally.

| # | State | Best source (`provider_id`) | Auth | Format | Image handling | Cadence | Attribution string | Terms verdict |
|---|---|---|---|---|---|---|---|---|
| 1 | California | Caltrans CWWP2 (`ca_caltrans_d1` … `d12`) | none | 12 static JSON files (also XML/CSV/TXT) | proxy+cache 60–120 s; HLS by official URL, click-to-play | 1–5 min in metros (per-camera field) | "Camera imagery: Caltrans (California Department of Transportation)" | **Permissive**: public domain, built "for integration into your application", fair-use clause |
| 2 | Texas — Austin only | City of Austin open data (`tx_austin_mobility`) | none (optional Socrata app token) | Socrata JSON/GeoJSON | proxy+cache ≤ 5 min (honour `Expires`) | ~5 min | "Camera images: City of Austin Transportation & Public Works (data.austintexas.gov)" | **Permissive**: public domain, "free and without restriction"; credit the City and the department |
| 3 | Illinois | IDOT Gateway ArcGIS (`il_idot_gateway`) | **free registration** (Access/Reuse Policy) | ArcGIS FeatureServer JSON + JPEG | after registration: proxy+cache ≥ 5 min, unmodified | ~5 min | "Gateway traffic information courtesy of the Illinois Department of Transportation" + IDOT logo + policy link | **Permitted with registration and conditions** |
| 4 | Arizona | AZ511 API v2 (`az_az511`) | **free key** | JSON/XML | reference official URL directly; no proxy without ADOT OK | 30 s UI (frames seen up to ~8 min old) | "Traffic camera images: Arizona DOT (AZ511)" | **Mostly silent**: ADOT "retains … the right of distribution"; hotlinking API-supplied URLs is the intended use |
| 5 | Georgia | 511GA API v2 (`ga_511ga`) | **free key** + written consent advised | JSON/XML | reference official URL directly once GDOT OKs; otherwise link-out | 60 s | "Traffic camera images: Georgia DOT / 511GA" | **Restrictive**: GDOT EULA bars copy/store/commercial use without consent; the API's stated purpose is apps |
| 6 | Missouri | MoDOT ArcGIS MapServer (`mo_modot`) | none (KC video tokenised) | ArcGIS JSON + HLS | no stills; HLS by official URL, click-to-play (provisional); KC link-out | live video | "Camera: Missouri Department of Transportation (MoDOT)" | **Unclear**: "All Rights Reserved"; media get feeds "through agreements" |
| 7 | Texas — statewide | TxDOT ITS (`tx_txdot_its`) | none technically; **agreement** needed | internal JSON, base64 stills | link-out only until TxDOT agrees | ~1–2 min | "Traffic camera data: Texas Department of Transportation (TxDOT)" (confirm in agreement) | **Not cleared**: internal endpoint, terms silent; TranStar explicitly forbids linking images |
| 8 | Indiana | INDOT 511IN (`in_indot`) | none technically; **agreement** needed | internal GraphQL; JPEG + HLS | link-out only | ~2–4 min | "Camera: INDOT TrafficWise" | **Not cleared**: 511IN terms silent; state portal terms allow personal use only |

Tiers:
- **Ship now:** CA and Austin.
- **After a free key or registration:** IL, AZ, GA. GA also needs a consent letter to be safe.
- **After a written agreement:** TX statewide, MO (production), IN.

## Adapter families

| Adapter type | Providers | Notes |
|---|---|---|
| `caltrans_cwwp2` | CA: 12 district instances | Static JSON per district. Conditional GET with ETag (304 verified); no gzip. Key `(district, index)`. |
| `ibi511_v2`: 511 developer-API family (Arcadis IBI "TravelIQ") | **GA, AZ**. The same design is live at 511NY, 511WI, UDOT Traffic, NVRoads, 511 Idaho, 511 Alaska, 511LA, 511 Ontario and 511 Alberta. | `GET https://{host}/api/v2/get/cameras?key={key}&format=json`. One free key per deployment; 10 calls / 60 s. One adapter parameterised by `{host, key, attribution}`. See the family section below. |
| `arcgis_rest` (FeatureServer / MapServer `query`, paged, `outSR=4326`) | **IL** (primary), **MO** (primary, MapServer). Cross-check/bootstrap layers only: CA Caltrans GIS, GA GEMA mirror, TX TxDOT ITS devices, AZ ADOT inventory, TX Montgomery County. | Most AGOL layers send ACAO `*` + `max-age=30`. Watch for **frozen age fields** (IL) and stale snapshots (CA GIS 2024, GEMA 2025). |
| `socrata` | TX: City of Austin | `$limit` / `$where`, optional app token. Reusable for other Socrata cities. |
| Do **not** build without an agreement | TxDOT ITS internal JSON, INDOT/Castle Rock GraphQL, DriveTexas/MapLarge, Houston TranStar JS, SoCal511 internal JSON, 511 `List/GetData` internal lists | All are undocumented internal endpoints. Several sets of terms explicitly forbid scraping or reuse. |

Cross-provider adapter facts:
- **Freshness:** only some feeds carry an image time. Use the image `Last-Modified` where it is real (CWWP2, TranStar, Austin, IDOT, MoDOT stills, INDOT). The 511 family's `Last-Modified` is synthetic (= response time).
- **Placeholders look healthy:** CA "Down for Construction" JPEGs have live timestamps, Austin VOID cameras return a 2023 image, and INDOT closed cameras return an SVG. Always honour status fields (`inService`, `camera_status`, `Views[].Status`, `active`).
- **Composite keys:** CA `(district, index)`; TxDOT `(districtCode, netId, icd_Id)`; 511 family `(host, Views[].Id)`, never the site `Id`.
- **CORS:** most still images have **no ACAO** (TxDOT, TranStar, Austin, IDOT, MoDOT). Caltrans and the 511 family send `*`; 511GA sometimes sends duplicate ACAO headers. A plain `<img>` works everywhere, but canvas or `fetch` use needs our server proxy, and only where the terms allow it.

## Operator blockers

| # | Action | Where | Unblocks |
|---|---|---|---|
| 1 | Register a 511GA account + developer key | https://511ga.org/my511/register → https://511ga.org/developers/doc | GA |
| 2 | Register an AZ511 account + developer key | https://az511.gov/my511/register → https://az511.gov/developers/doc | AZ |
| 3 | Submit the IDOT Gateway Access/Reuse registration (CAPTCHA; asks intended usage and "Will earn revenue"; IDOT may require a signed agreement) | https://travelmidwest.com/About/RegistrationForm | IL production use (and the XML/FTP feed) |
| 4 | Request written permission / a data-sharing (C2C) agreement from **TxDOT**. One request covers its.txdot.gov statewide imagery (incl. DalTrans, TransGuide, TransVision, TransVista) and Houston TranStar images. | TxDOT Traffic Operations; https://www.txdot.gov/about/disclaimer.html | TX statewide |
| 5 | Ask **GDOT** in writing to confirm commercial display of 511GA images | https://511ga.org/contact | GA (safe production) |
| 6 | Ask **MoDOT** for permission to embed HLS, and **KC Scout** about KC video | https://www.modot.org/closed-circuit-cameras · https://www.kcscout.net/UserLicense.aspx | MO production, KC |
| 7 | Ask **INDOT** (and Castle Rock) for a documented camera feed or agreement | https://511in.org | IN |
| 8 | Optional: ask **ADOT** before caching or proxying AZ511 stills | https://azdot.gov/disclaimer | AZ proxy mode |
| 9 | Optional: Socrata app token (not required) | https://dev.socrata.com/docs/app-tokens.html | Austin throttling headroom |

## Texas

TxDOT ITS covers the whole state: 4,364 cameras, fresh stills, no key. But the endpoint is an **undocumented internal endpoint**, stills come only as base64 inside JSON, there is no CORS, and TxDOT's terms are silent on reuse. Imagery therefore needs a TxDOT agreement.

The regional brands (DalTrans, TransGuide, TransVision, TransVista) are now served by TxDOT ITS. Houston TranStar explicitly forbids linking to its images. The only clean, sanctioned source is **City of Austin open data** (Socrata, public domain). No Texas source needs an API key; the blocker is an agreement with TxDOT.

### TxDOT ITS — statewide district camera pages (`tx_txdot_its`)

| Item | Finding |
|---|---|
| Owner | Texas Department of Transportation (TxDOT), per district. DalTrans, TransGuide, TransVision and TransVista are served here. |
| Public API / type | No documented API. The site calls internal JSON (GET) and a SignalR hub (`District/ItsHub`, not probed). **undocumented internal endpoint — needs terms confirmation** |
| Metadata endpoint | `https://its.txdot.gov/its/DistrictIts/GetCctvStatusListByDistrict?districtCode={code}` (25 codes: ABL AMA ATL AUS BMT BRY BWD CHS CRP DAL ELP FTW HOU LBB LFK LRD ODA PAR PHR SAT SJT TYL WAC WFS YKM) |
| Still image URL pattern | **No image URL exists.** `GET https://its.txdot.gov/its/DistrictIts/GetCctvSnapshotByIcdId?icdId={url-encoded icd_Id}&districtCode={code}` returns JSON `{icd_Id, snippet, timestampFormatted}`, where `snippet` is a **base64 JPEG** (720×480 observed). The bulk `GetCctvSnapshotListByDistrict` was not probed because it downloads every image. |
| Video (HLS/MJPEG) | None on this site. See DriveTexas for token-signed HLS. |
| Refresh cadence | documented: none. A Skyline vendor page says TxDOT "had previously restricted sharing of camera data to still images, updated every 30 seconds." observed: snapshots <1 to ~2 min old. |
| Auth | none |
| Rate limit | None documented. 25 district pulls at 1 req/s all returned 200. |
| Attribution | Not specified |
| Terms URL(s) | https://www.txdot.gov/about/disclaimer.html (the ITS footer "Disclaimer" link redirects here) · https://www.txdot.gov/discover/live-traffic-cameras.html |
| CORS — metadata | **No ACAO** (also none with `Origin`); no Cache-Control / Last-Modified / ETag; HEAD and OPTIONS → 405 `Allow: GET` (re-verified on SJT) |
| CORS — image | Same, and JSON-wrapped, so server-side only |
| Cameras / coverage | 4,364 cameras in all 25 districts (4,132 Online / 193 Offline / 39 Error): HOU 1,168 · DAL 841 · FTW 487 · SAT 307 · AUS 283 · ELP 258 · BMT 240 · LRD 117 · CRP 87 · WAC 85 · ODA 74 · LBB 59 · BRY 54 · YKM 52 · PHR 50 · ABL 36 · ATL 30 · PAR 29 · AMA 28 · TYL 26 · WFS 25 · LFK 14 · SJT 6 · BWD 4 · CHS 4. A full statewide pull is ~1.95 MB. |
| Field map | id `icd_Id` (+ `netId`); name `name`; last-updated: none in the list (the snapshot's `timestampFormatted` is local Central time with no zone, e.g. "9/30/2026 4:48 AM"); status `statusDescription` (Device Online/Offline/Error) + `hasSnapshot`; route `equipLoc.roadway` (also the grouping key of `roadwayCctvStatuses`); direction `dirDescription` / `equipLoc.direction` (roadway direction, not camera heading); mile marker: none (132 names embed "MM n"); coords `latitude` / `longitude` (+ `latString` / `lonString`); image: via the snapshot call; video none |
| Coverage status | FULL (but internal and unsanctioned) |
| Recommendation | Custom adapter `txdot_its_district` (status list → per-camera snapshot → base64 decode) is technically feasible. **Image handling: link-out only** (`https://its.txdot.gov/its/District/{code}/cameras`) until TxDOT grants written permission or a data-sharing (C2C) agreement. The endpoint is internal, the terms are silent, and serving the images means re-encoding and re-hosting TxDOT content. |

**Terms (quoted)**
- Redistribution: not addressed. The general clause says only: "Use of the Texas Department of Transportation ("TxDOT") Web site ("Site") is governed by the following terms, conditions, and disclaimers ("Terms"). Users of this Site agree to abide by these Terms."
- Embedding: not addressed.
- Proxy/cache: not addressed. The cameras page says: "Notice: TxDOT camera footage is not recorded. Traffic cameras are for real-time monitoring only."
- Commercial: not addressed for cameras. A search snippet says TrafficLand holds an agreement covering 1,600+ TxDOT cameras through TxDOT's C2C portal, including commercial redistribution. The article returned 403, so this is **unverified**.
- Watermarks/attribution: not addressed.
- TxDOT's stance on other data, from the DriveTexas API agreement (road conditions, not cameras): "The Data are copyrighted and TxDOT's property protected under federal and state laws. User may use, copy, and distribute the Data in compliance with this Data Sharing and Usage Agreement." Also: "User shall not use TxDOT's name, logo, trademark, or other marks without TxDOT's prior written consent."

**Image probes**

| camera | snapshot call | status | content-type | timestamp (age) | size | ACAO | Cache-Control |
|---|---|---|---|---|---|---|---|
| FM-734 @ US-290 EB (AUS) | `…/GetCctvSnapshotByIcdId?icdId=FM-734%20%40%20US-290%20EB&districtCode=AUS` | 200 | application/json (base64 JPEG inside) | `timestampFormatted` 4:48 AM CDT at 09:50:21Z (~2 min); re-probe ~1 min | 43,325 B JSON → 32,430 B JPEG 720×480 | none | none |
| Aldine Westfield Rd @ Treaschwig Rd (HOU) | `…/GetCctvSnapshotByIcdId?icdId=Aldine%20Westfield%20Rd%20%40%20Treaschwig%20Rd&districtCode=HOU` | 200 | application/json | 6:20 AM CDT at 11:20:42Z (<1 min) | 113,730 B JSON → 85,219 B JPEG (EXIF: AXIS Q6315-L) | none | none |

**Notes**
- District lists include cameras from other networks (e.g. the AUS list holds a `netId` HOUSTON camera and a SAT camera). `netId` values seen: AUS, DAL1, DAL2, ELP, FTW, FTW2, HOU2, HOUSTON, SAT, SAT2.
- One `icd_Id` appears under two networks, so key on `(districtCode, netId, icd_Id)`.
- `icd_Id` ≠ `name` in 772 cases. It contains spaces, `@`, `&` and parentheses, so URL-encode it.
- The snapshot call needs the page's district code, not `netId`. An unknown id returns HTTP 200 with body `null`.
- The HTML embeds third-party map tokens (INRIX, Esri); they were not used or recorded.
- DalTrans (`www.daltrans.org`, `dfwtraffic.dot.state.tx.us`) is a DNS alias of `its.txdot.gov`; its HTTPS fails with a certificate name mismatch.
- TransGuide's page is `its.txdot.gov/ITS_V3/SAT/sat.htm`; the old `transguide.dot.state.tx.us` timed out (whether it is down or only blocked from here is **unverified**).
- `transvision.dot.state.tx.us` and `www.transvista.dot.state.tx.us` do not resolve.

**Evidence**
- https://its.txdot.gov/its/District/AUS/cameras
- https://its.txdot.gov/its/js/its.js
- https://its.txdot.gov/its/DistrictIts/GetCctvStatusListByDistrict?districtCode=AUS
- https://www.txdot.gov/about/disclaimer.html
- https://www.txdot.gov/discover/live-traffic-cameras.html
- https://skylinenet.net/statewide-video-interoperability-and-sharing-for-texas-department-of-transportation/

**Fixture**
- `tx_txdot_its/internal_cctv_status_list_aus.json`: **internal endpoint**, `GetCctvStatusListByDistrict?districtCode=AUS`, fetched 2026-09-30T10:07:02Z.
- Both top-level keys are kept. `cctvStatusRoadways` is filtered to the 6 roadways kept, and the `roadwayCctvStatuses` arrays are cut to 15 cameras total in original order, including Online, Offline and Error cameras and the HOUSTON and SAT cross-network cameras.
- Source total: 283 (AUS). There is no snapshot fixture because that payload is an image.

### Regional TMC brands — DalTrans, TransGuide, TransVision, TransVista (served by `tx_txdot_its`)

| Brand (metro) | District code | Cameras in TxDOT ITS | Own feed? | Coverage status | Recommendation |
|---|---|---|---|---|---|
| DalTrans (Dallas) | DAL | 841 (834 `DAL1`, 7 `FTW`) | No. The hostnames alias `its.txdot.gov`. | NO PUBLIC FEED (separate) | use `tx_txdot_its`; link-out only |
| TransGuide (San Antonio) | SAT | 307 | No. Page hosted on its.txdot.gov. | NO PUBLIC FEED (separate) | same |
| TransVision (Fort Worth) | FTW | 487 (476 `FTW`, 11 `DAL1`) | No. Host does not resolve. | NO PUBLIC FEED (separate) | same |
| TransVista (El Paso) | ELP | 258 | No. Host does not resolve. | NO PUBLIC FEED (separate) | same |

All four have token-signed HLS for their cameras on DriveTexas (`TX_DAL_*`, `TX_SAT_*`, …). The terms are TxDOT's, as above. The City of San Antonio is adding ~93 city cameras (KSAT, Dec 2025), but no public feed was found.

### DriveTexas camera layer (`tx_drivetexas`)

| Item | Finding |
|---|---|
| Owner | TxDOT (drivetexas.org). The camera table is hosted by vendor MapLarge (`dtx-e-cdn.maplarge.com`, account `appgeo`); streams come from Skyline (`*.us-east-1.skyvdn.com`). |
| Public API / type | The documented DriveTexas API (`https://api.drivetexas.org/api/conditions.{geojson,csv,kml}?key=`, `conditions.wzdx.geojson`) has **road conditions only, no cameras**. Cameras come from MapLarge internal JSON. **undocumented internal endpoint — needs terms confirmation** |
| Metadata endpoint | Two steps: (1) `https://dtx-e-cdn.maplarge.com/Remote/GetActiveTableID?shortTableId=appgeo/cameraPoint` returns a versioned table id; (2) `https://dtx-e-cdn.maplarge.com/Api/ProcessDirect?request={"action":"table/query","query":{"sqlselect":["*","XY"],"start":0,"take":N,"table":"<versioned>"}}` |
| Still image URL pattern | None usable. `imageurl` is the broken placeholder `https://localhost/thumbs/TX_ELP_209.flv.jpg`. |
| Video (HLS/MJPEG) | HLS in `httpsurl`: `https://s69.us-east-1.skyvdn.com/rtplive/{name}/playlist.m3u8?token=<JWT>` (token valid ~300 s). Also `rtspurl`, `rtmpurl`, `clspsurl`, `prerollurl`, and an `iosurl` without a token. `iosurl` was **deliberately not tested**, because using it would sidestep the token. |
| Refresh cadence | `lastUpdated` is one table-wide value; the site re-checks the active table every 30 s |
| Auth | None for MapLarge; streams are token-signed. The conditions API key requires email + justification + accepted terms and expires each 31 March. |
| Rate limit | Not documented for MapLarge. The conditions API asks for polling ≥ 5 min. |
| Attribution | Not specified |
| Terms URL(s) | https://drivetexas.org/faq (no terms) · https://api.drivetexas.org/tos.json (conditions API only) |
| CORS — metadata | GetActiveTableID: ACAO `*`, `public, max-age=30`. ProcessDirect: ACAO `*`, `public, max-age=604800`. |
| Cameras / coverage | 3,510 streams statewide (HOU 855, DAL 776, FTW 336, SAT 303, AUS 239, ELP 215, …) |
| Field map | id `id` / `name` (e.g. TX_ELP_209); name `description`; last-updated `lastUpdated` (epoch ms, table-wide); status `active` / `problemstream` (always 1/0, so useless); route `metadata.route` (JSON string, often empty); direction `metadata.direction`; mile marker `metadata.mrm`; coords `XY` (WKT `POINT (lon lat)`); image `imageurl` (broken); video `httpsurl` |
| Coverage status | FULL (video only, token-signed; no stills) |
| Recommendation | **Do not build an adapter. Link-out only** to drivetexas.org: internal vendor endpoint, no stills, and stream tokens issued for TxDOT's own player. |

**Terms (quoted)**, from the conditions-API agreement (does not cover cameras):
- Redistribution: "User may use, copy, and distribute the Data in compliance with this Data Sharing and Usage Agreement."
- Commercial: "User may not sub-license, sell, or lease the Data or any portion of the Data without TxDot's prior written consent."
- Attribution/marks: "User shall not use TxDOT's name, logo, trademark, or other marks without TxDOT's prior written consent."
- Embedding and proxy/cache: not addressed. The FAQ says: "TxDOT does not record or store any traffic camera footage."

**Notes**
- The response is column-oriented (`data.data.{field:[values]}`).

**Evidence**
- https://drivetexas.org/static/index-B86VCxiK.js (`VITE_CAMERA_TABLE`, `VITE_ML_HOST`)
- https://api.drivetexas.org/
- https://api.drivetexas.org/tos.json
- https://drivetexas.org/faq

**Fixture**
- `tx_drivetexas/internal_maplarge_camerapoint_query.json`: **internal endpoint**, ProcessDirect with `take:15`, fetched 2026-09-30T10:36:49Z.
- The 30 stream-token values in `httpsurl` / `clspsurl` were replaced with `token=REDACTED`; they had already expired. That is the only deviation from the original payload.
- Source total: 3,510.

### TxDOT ArcGIS "Existing ITS Device" layer (`tx_txdot_gis`)

| Item | Finding |
|---|---|
| Owner | TxDOT AGOL org `KTcxiTD9dsQw4r7Z`, item `ad88c62a2d6f4fa2bd700f39ddda038b` ("ITS CCTV and DMS devices"). Not listed in the TxDOT Open Data hub, which has no camera dataset. |
| Public API / type | ArcGIS FeatureServer |
| Metadata endpoint | `https://services.arcgis.com/KTcxiTD9dsQw4r7Z/arcgis/rest/services/Existing_ITS_Device_Service_view/FeatureServer/0/query?where=Type%3D%27CCTV%27&outFields=*&f=json` (maxRecordCount 2000, so page) |
| Still image / video | none |
| Refresh cadence | Static inventory; last edit 2025-10-29 |
| Auth / rate limit / attribution | none / not documented / none (`copyrightText` empty, `licenseInfo` null) |
| Terms URL(s) | none on the item; falls back to https://www.txdot.gov/about/disclaimer.html |
| CORS — metadata | ACAO `*`; `public, max-age=30, s-maxage=30` |
| Cameras / coverage | 4,243 CCTV (+1,680 DMS), statewide |
| Field map | id `OBJECTID`; name `Equipment_Name`; last-updated none; status none; route in name only; direction none; mile marker none; coords `Lat_Y` / `Lon_X` (floats) or `Latitude` / `Longitude` (integers × 1e6) or geometry (Web Mercator unless `outSR=4326`) |
| Coverage status | METADATA ONLY |
| Recommendation | Generic ArcGIS adapter, as an optional location cross-check only. There is no imagery. |

**Notes**
- `District` is dirty: spreadsheet auto-fill junk from FTW2 to FTW94, plus FTE.
- The count differs from its.txdot.gov (4,243 vs 4,364).

**Evidence**
- https://services.arcgis.com/KTcxiTD9dsQw4r7Z/arcgis/rest/services/Existing_ITS_Device_Service_view/FeatureServer/0
- https://www.arcgis.com/home/item.html?id=ad88c62a2d6f4fa2bd700f39ddda038b

**Fixture**
- `tx_txdot_gis/its_device_locations_cctv.json`: `…/query?where=Type='CCTV'&outFields=*&resultRecordCount=15&orderByFields=OBJECTID&f=json`, fetched 2026-09-30T11:16:51Z; 15 of 4,243.

### Houston TranStar (`tx_houston_transtar`)

| Item | Finding |
|---|---|
| Owner | Site owned by TxDOT (per its disclaimer). TranStar is a partnership of TxDOT, Harris County, City of Houston and METRO. |
| Public API / type | The documented data feeds (speeds, incidents, lane closures, flood warnings; access by request) have **no camera feed**. Camera data exists only as an internal JS file. **undocumented internal endpoint — needs terms confirmation** |
| Metadata endpoint | `https://traffic.houstontranstar.org/data/layers/cctvSnapshots_out.js`: ~240 KB of `new CctvCamera(name, monitor, roadway, location, lat, lng, dir, path, validimg, frameCount, framePauseMs)` calls, regenerated every 1–4 min |
| Still image URL pattern | `https://www.houstontranstar.org/snapshots/cctv/{path}` (e.g. `1004.jpg`). Six-frame cameras add `{id}-{n}.jpg`. |
| Video (HLS/MJPEG) | None (the FAQ says public streaming is not offered) |
| Refresh cadence | documented: "Camera snapshots are updated approximately every three minutes." observed: image 62 s old |
| Auth / rate limit | none / not documented |
| Attribution | Not specified |
| Terms URL(s) | https://traffic.houstontranstar.org/disclaimer.aspx · https://www.houstontranstar.org/faq/webfaq.aspx |
| CORS — metadata | No ACAO; no Cache-Control; Last-Modified + ETag; gzip; HEAD → 301, so use GET |
| CORS — image | No ACAO; no Cache-Control; ETag. HEAD wrongly returns 200 text/html (`private`), so use GET. |
| Cameras / coverage | 1,386 entries (1,074 `validimg=True`), 108 roadways; Houston / Harris County region |
| Field map | id `path` filename; name `name`; last-updated none (use the image Last-Modified); status `validimg`; route `roadway`; direction `dir` (encoded, see notes); mile marker none; coords `lat` / `lng` (strings); image `…/snapshots/cctv/{path}`; video none |
| Coverage status | METRO ONLY |
| Recommendation | **No adapter. Link-out only** (https://traffic.houstontranstar.org/cctv/transtar/). The terms explicitly forbid copying and "linking to specific images" without TxDOT's written consent. |

**Terms (quoted)** (re-verified 2026-09-30):
- Redistribution: "Except as otherwise expressly authorized in this site, no copying, reproduction, or distribution of the information contained in this site is permitted without the prior written permission of the Texas Department of Transportation."
- Embedding: "No part of this web site, whether complete or otherwise, may be set within a "frame" of another web site, without the express written consent of TxDOT. External framing or linking to specific images or graphics is prohibited without the express written consent of TxDOT."
- Proxy/cache: covered by the reproduction clause. The FAQ says: "Houston TranStar does not record video or save images from these cameras."
- Commercial: not addressed. The FAQ: "You are welcome to use the data in the feeds without obtaining permission as long as you follow the usage guidelines in the disclaimer." Those feeds exclude cameras.
- Watermarks/attribution: not addressed.

**Image probes**

| camera | image URL | status | content-type | Last-Modified (age) | size | ACAO | Cache-Control |
|---|---|---|---|---|---|---|---|
| 10 EAST @ JENSEN | https://www.houstontranstar.org/snapshots/cctv/1004.jpg | 200 (GET) | image/jpeg | 10:50:53Z at 10:51:55Z (62 s) | 23,112 B, 320×260 | none | none |

**Notes**
- `dir` is not the travel direction. The site maps South→East, North→West, West→South, other→North. "None" (408 cameras) marks a PTZ camera.
- The site adds a random `?arg=` to image URLs to defeat caches.
- Not determined: which cameras belong to TxDOT versus city or county, and whether TxDOT ITS HOU (1,168 cameras) shares images with TranStar.

**Evidence**
- https://traffic.houstontranstar.org/cctv/transtar/
- https://traffic.houstontranstar.org/datafeed/datafeed_info.aspx
- https://traffic.houstontranstar.org/api/api_doc.aspx
- https://traffic.houstontranstar.org/disclaimer.aspx
- https://www.houstontranstar.org/faq/webfaq.aspx

**Fixture**: none. The source is JS rather than JSON/XML, and the terms forbid reproduction without consent.

### City of Austin — Traffic Cameras open data (`tx_austin_mobility`)

| Item | Finding |
|---|---|
| Owner | City of Austin, Transportation & Public Works (city street / arterial cameras, not freeways) |
| Public API / type | Socrata open-data API (JSON / GeoJSON / CSV), documented and official |
| Metadata endpoint | `https://data.austintexas.gov/resource/b4k4-adkb.json` (or `.geojson`); filter `$where=camera_status='TURNED_ON'` |
| Still image URL pattern | `https://cctv.austinmobility.io/image/{camera_id}.jpg` (field `screenshot_address`). Stable, unsigned, S3 + CloudFront. |
| Video (HLS/MJPEG) | none |
| Refresh cadence | documented: dataset updated daily (`rowsUpdatedAt` 2026-09-30T06:55:48Z). observed: images 3–3.5 min old, `Expires` ~5 min after Last-Modified (≈ 5-min refresh). |
| Auth | None. An optional free Socrata app token exists (not registered). |
| Rate limit | Socrata: "IP addresses that make too many requests during a given period may be subject to throttling." App-token requests are not throttled unless abusive. |
| Attribution | Dataset metadata: "City of Austin, Texas - data.austintexas.gov" (re-verified). The terms ask for both the City and the source department. |
| Terms URL(s) | https://data.austintexas.gov/stories/s/City-of-Austin-Open-Data-Terms-of-Use/ranj-cccq/ · dataset licence **Public Domain** (`licenseId: PUBLIC_DOMAIN`, re-verified) |
| CORS — metadata | ACAO `*`; no Cache-Control; Last-Modified + ETag |
| CORS — image | **No ACAO**; no Cache-Control; `Expires` ≈ Last-Modified + 5 min; ETag |
| Cameras / coverage | 1,007 records: 819 TURNED_ON, 124 DESIRED, 34 VOID, 30 REMOVED. City of Austin + ETJ. |
| Field map | id `camera_id` (string; also hex `id`); name `location_name`; last-updated `modified_date` (record edit, not image time); status `camera_status`; route `primary_st` (+ `cross_st`); direction none; mile marker none; coords `location` (GeoJSON Point [lon, lat]); image `screenshot_address`; video none |
| Coverage status | METRO ONLY |
| Recommendation | Socrata adapter, reusable for other Socrata cities. **Image handling: proxy+cache (short TTL ≤ 5 min, honour `Expires`)**. The data is public domain and "offered free and without restriction", and the images lack CORS, so proxying also fixes canvas/fetch use. Direct `<img>` reference is also permitted. |

**Terms (quoted)**
- Redistribution: "Data available through the City of Austin Open Data Portal are offered free and without restriction. Data and content created by City of Austin government employees within the scope of their employment are not subject to copyright protection."
- Embedding: "Unless otherwise noted in metadata, datasets available on the City of Austin Open Data Portal are in the public domain, which means you may link to the City of Austin Open Data Portal at no cost."
- Proxy/cache: not addressed.
- Commercial: not addressed beyond "free and without restriction".
- Watermarks/attribution: "Please provide attribution to both the City of Austin and the City Department that is the source of the cited data." Logo: "Placement of the City of Austin logo is to be used only as a marker and link to the home page. It is not meant as a form of endorsement or approval from the City of Austin."

**Image probes**

| camera | image URL | status | content-type | Last-Modified (age) | size | ACAO | Cache-Control |
|---|---|---|---|---|---|---|---|
| 1 (830 BLK W RUNDBERG LN) | https://cctv.austinmobility.io/image/1.jpg | 200 | image/jpeg | 11:03:44Z at 11:06:43Z (~3 min); Expires 11:08:43Z | 171,309 B | none | none |
| 100 | https://cctv.austinmobility.io/image/100.jpg | 200 | image/jpeg | 11:03:52Z at 11:07:26Z (~3.5 min); Expires 11:08:51Z | 413,791 B | none | none |

**Notes**
- VOID camera 1016 still returns 200 with a **2023-10-31** image. Always filter `camera_status='TURNED_ON'` and check image age.
- Every record has a `screenshot_address`, even DESIRED and VOID ones.
- `camera_id` sorts as a string.
- Images are 170–415 KB, so re-encode or resize when proxying.
- Whether the image files themselves fall under the portal's public-domain licence is inferred, not confirmed with the City.

**Evidence**
- https://data.austintexas.gov/Transportation-and-Mobility/Traffic-Cameras/b4k4-adkb
- https://data.austintexas.gov/api/views/b4k4-adkb.json
- https://data.austintexas.gov/stories/s/City-of-Austin-Open-Data-Terms-of-Use/ranj-cccq/
- https://dev.socrata.com/docs/app-tokens.html

**Fixture**
- `tx_austin_mobility/traffic_cameras_b4k4-adkb.json`: `https://data.austintexas.gov/resource/b4k4-adkb.json?$limit=15&$order=camera_id`, fetched 2026-09-30T11:03:50Z; includes TURNED_ON, VOID and DESIRED; 15 of 1,007.

### Minor Texas sources (brief)

| Source | Owner | Type | Cameras | Coverage status | Recommendation |
|---|---|---|---|---|---|
| Montgomery County live cameras (`tx_montgomery_county`) | Montgomery County, TX GIS (mctraffic.org) | ArcGIS FeatureServer `https://services1.arcgis.com/PRoAPGnMSUqvTrzq/arcgis/rest/services/MCTX_Live_Cameras/FeatureServer/0` | 141 (The Woodlands / Conroe) | METADATA ONLY | `FEEDURL` is a live-video page (HTTP-only WebSocket relay); no stills; terms not located; layer last edited 2024-02. **Link-out only.** Never ingest `CONTROLIP`: the layer publicly exposes camera control IPs. No fixture. |
| El Paso international bridge cameras (`tx_elpaso_bridges`) | City of El Paso International Bridges | HTML page with 9 HLS streams (`zoocams.elpasozoo.org`) | 9 border crossings | NO PUBLIC FEED | **Link-out only**: https://www2.elpasotexas.gov/misc/externally_linked/bridges/cameras.html |

**Texas summary**
- **Statewide:** TxDOT ITS is the only statewide imagery (4,364 cameras, ~1–2 min stills). Verdict: **not usable for imagery without TxDOT written permission / a C2C data-sharing agreement**; until then, link-out only. Even metadata use of the internal endpoint needs an operator decision.
- **Clean gap-filler:** City of Austin. Socrata, no key, public domain; proxy+cache with TTL ≤ 5 min. Attribution: "Camera images: City of Austin Transportation & Public Works (data.austintexas.gov)".
- **Houston TranStar:** link-out only (explicit prohibition).
- **DriveTexas:** link-out only (token-signed video, vendor-internal).
- **TxDOT ArcGIS layer:** metadata-only cross-check.
- **Attribution for TxDOT, if an agreement is reached:** "Traffic camera data: Texas Department of Transportation (TxDOT)". Confirm the wording in the agreement, because TxDOT forbids use of its name or marks without consent.
- **Blockers:** (1) TxDOT written permission / data-sharing agreement for its.txdot.gov imagery (the same request covers TranStar); (2) an operator decision on using internal-endpoint metadata before that agreement.

## California

Statewide source: **Caltrans CWWP2** (12 district feeds, one schema). Regional 511s (SoCal511, 511 SF Bay, 511SD) only re-display Caltrans cameras and publish no camera API, so they add no coverage. No machine-readable municipal (arterial) camera feed turned up in a brief search.

### Caltrans CWWP2 — CCTV status feeds, Districts 1–12 (`ca_caltrans_d1` … `ca_caltrans_d12`)

| Item | Finding |
|---|---|
| Owner | California Department of Transportation (Caltrans), Commercial Wholesale Web Portal (CWWP2) |
| Public API / type | Static JSON, XML, CSV and TXT files per district. Documented and intended for third-party integration. No query API. |
| Metadata endpoint | `https://cwwp2.dot.ca.gov/data/d{N}/cctv/cctvStatusD{NN}.json` (N = 1–12, NN zero-padded, e.g. `/data/d7/cctv/cctvStatusD07.json`). `.xml` / `.csv` / `.txt` variants carry the same data. |
| Still image URL pattern | `https://cwwp2.dot.ca.gov/data/d{N}/cctv/image/{slug}/{slug}.jpg`, plus 12 history frames at `…/{slug}/previous/{slug}-{1..12}.jpg`. JPEG, 320×260, with a burned-in Caltrans logo, camera name and timestamp banner. |
| Video (HLS/MJPEG) | HLS on 2,305 of 3,591 cameras: `https://wzmedia.dot.ca.gov/D{N}/{name}.stream/playlist.m3u8` (Wowza). Master playlist → `chunklist_w{session}.m3u8`, 1280×720 H.264. No MJPEG. Per-camera official player pages at `https://cwwp2.dot.ca.gov/vm/loc/d{N}/{slug}.htm`. |
| Refresh cadence | documented: per camera, `currentImageUpdateFrequency` in minutes (observed values 1–60; D3/D6 = 1, D5/D7/D10/D11 = 2, D8 = 3, D4/D12 = 5, D1 5–15, D2 4–60, D9 5–20). History frames every `referenceImageUpdateFrequency` (15). The feed file is updated "as necessary" (file Last-Modified ranged from 2026-03-02 for D9 to 2026-09-29). observed: D7 still was 50 s old (freq 2); D4 still was 4 min 14 s old (freq 5). |
| Auth | none |
| Rate limit | None published. Fair-use clause: "Usage that risks degrading the availability of the CCTV streaming service is prohibited." ETag / `If-None-Match` works (verified 304). No gzip (feeds are 69 KB–2.4 MB raw). |
| Attribution | Not required by the terms. Suggested: "Camera imagery: Caltrans (California Department of Transportation)". Every still already carries the Caltrans logo. |
| Terms URL(s) | https://dot.ca.gov/conditions-of-use · https://cwwp2.dot.ca.gov/closed-circuit-television-cameras.html (Fair Use Policy) · https://cwwp2.dot.ca.gov/documentation/cctv/cctv.htm |
| CORS — metadata | `Access-Control-Allow-Origin: *` with and without `Origin`. No `Cache-Control`. `ETag` + `Last-Modified` present. |
| CORS — image | `Access-Control-Allow-Origin: *`. No `Cache-Control`. `ETag` + `Last-Modified` present. HLS playlists: ACAO `*`, `Cache-Control: no-cache`. |
| Cameras / coverage | 3,591 cameras (3,392 `inService=true`) on the whole State Highway System, pulled 2026-09-30 09:25 UTC. D1 145 · D2 91 · D3 275 · D4 756 · D5 181 · D6 128 · D7 592 · D8 503 · D9 23 · D10 154 · D11 324 · D12 419. Metros: LA/Ventura = D7; Bay Area = D4; San Diego = D11; Orange = D12; Inland Empire = D8; Sacramento = D3; Fresno/Bakersfield = D6; Stockton/Modesto = D10. |
| Field map | id `cctv.index` (string, unique per district, see Notes); name `location.locationName`; last-updated: no per-image timestamp in the feed (`recordTimestamp.recordDate/recordTime/recordEpoch` is the record's creation time, PST/PDT; use the image `Last-Modified`); status `inService` ("true"/"false"/"Not Reported"); route `location.route` (+ `routeSuffix`); direction `location.direction` (North/South/East/West/Median/""); mile marker `location.postmile` (county postmile, + `postmilePrefix`, `alignment`) and `location.milepost` (absolute postmile); coords `location.latitude` / `location.longitude` (WGS84 strings); image `imageData.static.currentImageURL`; video `imageData.streamingVideoURL` |
| Coverage status | FULL (state highways statewide; no city arterials) |
| Recommendation | Adapter: `caltrans_cwwp2`, one type with 12 district instances. Poll each district file every 5–15 min using `If-None-Match`. Stills: proxy+cache with a short TTL (60–120 s, or at least the camera's `currentImageUpdateFrequency`). The terms treat the data as public domain, the portal is built "for integration into your application", and a shared cache honours the fair-use clause better than per-user hotlinking. Keep the burned-in banner uncropped. HLS: reference the official playlist directly (never re-stream), and only start it on user click. |

**Terms (quoted)**
- Redistribution: "In general, information presented on this website, unless otherwise indicated, is considered in the public domain. It may be distributed or copied as permitted by law." (Conditions of Use, Ownership). Caveat from the same section: "However, the California Department of Transportation does make use of copyrighted data (e.g., photographs) which may require additional permissions prior to your use." These camera stills are Caltrans-produced, so the caveat reads as covering third-party photos, but that is my interpretation.
- Embedding / integration: "These files are available for integration into your application and are available via the HTTPS protocol. There is no charge for the use fo this data." ("fo" typo is in the original.) The site also publishes an iframe map (`/vm/iframemap.htm`, no X-Frame-Options).
- Proxy / cache: not addressed. Related: "Usage that risks degrading the availability of the CCTV streaming service is prohibited." and "Caltrans traffic camera video footage and still images are neither retained nor archived."
- Commercial: not addressed explicitly. The portal is titled "Commercial Wholesale Web Portal", and the page states "There is no charge for the use fo this data."
- Watermarks / attribution: not addressed. Stills carry a burned-in Caltrans logo, camera ID/name and timestamp (observed).

**Image probes** (2026-09-30)

| camera | image URL | status | content-type | Last-Modified (age) | size | ACAO | Cache-Control |
|---|---|---|---|---|---|---|---|
| D7 #1 I-110 Avenue 26 Off Ramp | https://cwwp2.dot.ca.gov/data/d7/cctv/image/i110196avenue26offramp/i110196avenue26offramp.jpg | 200 | image/jpeg | 09:40:15 GMT (50 s) | 27,769 B, 320×260 | `*` | none (`ETag "6abcd8ff-6c79"`) |
| D4 #1 TV102 I-580 W of SR-24 | https://cwwp2.dot.ca.gov/data/d4/cctv/image/tv102i580westofsr24/tv102i580westofsr24.jpg | 200 | image/jpeg | 09:36:52 GMT (4 min 14 s) | 13,894 B | `*` | none (`ETag "6abcd834-3646"`) |
| D7 CCTV-196 HLS | https://wzmedia.dot.ca.gov/D7/CCTV-196.stream/playlist.m3u8 | 200 | application/vnd.apple.mpegurl | n/a | 128 B master playlist | `*` (+ `Allow-Credentials: true`) | `no-cache` |
| D7 I-57 Triggs St (`inService=false`) | https://cwwp2.dot.ca.gov/data/d7/cctv/image/i57triggsst/i57triggsst.jpg | 200 | image/jpeg | 1 min 50 s | 16,770 B | `*` | none |

**Notes**
- Out-of-service cameras still serve a fresh JPEG: a "Down for Construction" placeholder with a live timestamp. `Last-Modified` freshness is therefore not a health signal. The adapter must honour `inService` (199 cameras are `false`) and should hide `"Not Reported"` values.
- `index` is not contiguous (e.g. D7 max 1250 for 592 rows). It stayed stable: all 15 sampled D1 `(district, index)` pairs mapped to the same image URL in the Oct-2024 GIS snapshot and today. Use `ca_caltrans:d{district}:{index}` as the key and the image slug as a secondary key. Image slugs are unique per district.
- Data defects: `county` is wrong on some rows (11 D7 and 5 D12 cameras say "Alameda"), so trust lat/lon over county. `direction` is empty on 381 rows. Every value is a string, including numbers and booleans. 2 D4 stream URLs use `wzmedia.dot.ca.gov:443`. `currentImageUpdateFrequency` can be `"Not Reported"`.
- The District Reporting Matrix is stale: it lists `streamingVideoURL` only for D3/4/5/6/8/10, but D1, D7, D11 and D12 also carry streams. D2 and D9 have none.
- XML is ISO-8859-1; JSON is UTF-8. JSON is preferred.
- The HLS master playlist returns a per-session chunklist (`w{digits}`). It is a Wowza session id, not an auth token, so reference the master URL.

**Evidence**
- https://cwwp2.dot.ca.gov/closed-circuit-television-cameras.html
- https://cwwp2.dot.ca.gov/documentation/cctv/cctv.htm
- https://cwwp2.dot.ca.gov/documentation/cctv/cctv-field-description.htm
- https://cwwp2.dot.ca.gov/documentation/cctv/cctv-district-reporting-matrix.htm
- https://dot.ca.gov/conditions-of-use
- https://cwwp2.dot.ca.gov/vm/streamlist.htm (per-camera official player links)
- https://cwwp2.dot.ca.gov/vm/iframemap.htm

**Fixture**
- `apps/api/tests/fixtures/cameras/ca_caltrans_d{1..12}/cctv_status_d{01..12}.json`: 12 files, 15 cameras each (~43 KB each). Source: `https://cwwp2.dot.ca.gov/data/d{N}/cctv/cctvStatusD{NN}.json`, fetched 2026-09-30 09:25 UTC. Truncation: `{"data":[…]}` wrapper kept and the array sliced to 15 records in original feed order. Each file includes one exemplar per edge case present in that district (`inService=false`, no stream, `:443` stream host, `"Not Reported"` frequency, empty direction, county outside district); the rest are the first records in feed order. Source totals: 145 / 91 / 275 / 756 / 181 / 128 / 592 / 503 / 23 / 154 / 324 / 419.

### Caltrans GIS — CCTV FeatureServer (`ca_caltrans_gis`)

| Item | Finding |
|---|---|
| Owner | Caltrans GIS (Caltrans GIS Data hub item `450df5bed93c4558a7264b7ef64187e6`) |
| Public API / type | ArcGIS FeatureServer (JSON, geoJSON, PBF), maxRecordCount 2000 |
| Metadata endpoint | `https://caltrans-gis.dot.ca.gov/arcgis/rest/services/chhighway/CCTV/FeatureServer/0/query?where=1%3D1&outFields=*&outSR=4326&f=json` |
| Still image URL pattern | `currentImageURL` points at the same CWWP2 JPEGs |
| Video (HLS/MJPEG) | `streamingVideoURL` (same Wowza HLS) |
| Refresh cadence | Layer is a stale snapshot: max `recordEpoch` = 1729277971 (2024-10-18) |
| Auth | none |
| Rate limit | not published |
| Attribution | `copyrightText`: "Copyright © 2020 State of California" |
| Terms URL(s) | https://gisdata-caltrans.opendata.arcgis.com/datasets/450df5bed93c4558a7264b7ef64187e6_0/about · https://dot.ca.gov/conditions-of-use |
| CORS — metadata | No ACAO without `Origin`. With `Origin`, it echoes `Access-Control-Allow-Origin: https://ops.leadcommand.ai` + `Allow-Credentials: true`. `Cache-Control: max-age=00:00:00` (malformed; effectively no-cache). |
| CORS — image | same CWWP2 images as above |
| Cameras / coverage | 2,936 rows (2,836 `inService="True"`), versus 3,591 in live CWWP2 |
| Field map | id `index_` + `district`; name `locationName`; last-updated `recordDate` (epoch ms) / `recordEpoch`; status `inService` ("True"/"False"); route `route`; direction `direction`; mile marker `postmile`, `Odometer`; coords geometry `x`/`y` (+ `latitude`/`longitude`); image `currentImageURL`; video `streamingVideoURL` |
| Coverage status | PARTIAL (stale; missing ~650 current cameras) |
| Recommendation | Do not use as the primary source; use CWWP2 JSON. Useful only as a one-shot bootstrap or as a cross-check for the ArcGIS adapter. |

**Terms (quoted)**: no terms beyond the Caltrans Conditions of Use quoted above.

**Fixture**
- `apps/api/tests/fixtures/cameras/ca_caltrans_gis/cctv_featureserver_query.json`: Esri JSON query response, `resultRecordCount=15`, `orderByFields=OBJECTID`, `outSR=4326`. Fetched 2026-09-30 10:16 UTC; 2,936 rows in the source.

### SoCal511 / Go511 (`ca_socal511`)

| Item | Finding |
|---|---|
| Owner | Los Angeles County Service Authority for Freeway Emergencies (LA SAFE) |
| Public API / type | No documented API. The consumer site calls `https://go511.com/api/camera/getall` (JSON, 1,106 cameras, all Caltrans D7/D8/D12, all images on `cwwp2.dot.ca.gov`). **undocumented internal endpoint — needs terms confirmation** (and the terms prohibit it, see below). |
| Metadata endpoint | none public (internal only, see above) |
| Still image URL pattern | Caltrans CWWP2 URLs |
| Video (HLS/MJPEG) | Caltrans Wowza HLS |
| Refresh cadence | inherits Caltrans |
| Auth | none (internal) |
| Rate limit | not published |
| Attribution | n/a |
| Terms URL(s) | https://go511.com/About/TermsConditions |
| CORS — metadata | no ACAO (IIS; sets ARRAffinity cookies) |
| CORS — image | see Caltrans |
| Cameras / coverage | LA, Ventura, Orange, Riverside and San Bernardino freeways, a subset of CWWP2 |
| Field map | n/a (not recommended) |
| Coverage status | NO PUBLIC FEED (a subset of Caltrans CWWP2) |
| Recommendation | Do not use. Get the same cameras from CWWP2 D7/D8/D12. Link-out only, to the home page, if ever. |

**Terms (quoted)**: redistribution: "Redistribution or republication of any part of Go511.com or its content is prohibited, including by such methods as framing, other similar methods or by any other means, without the prior express written consent of LA SAFE."; automated access: prohibits using "any robot, spider or other similar kind of automatic program or device, or manual process to monitor, copy, summarize, or otherwise extract information from this website"; linking: "Links may not be established to any other pages on this website without Go511.com's prior written permission."; commercial: prohibits using the content "for any personal, public or commercial purpose, including without limitation use of the content on any other website".

**Fixture**: none. The endpoint is internal, the terms prohibit extraction, and the data duplicates CWWP2. One discovery request was made to identify the camera source.

### 511 SF Bay (MTC) (`ca_511sfbay`)

| Item | Finding |
|---|---|
| Owner | Metropolitan Transportation Commission (511.org) |
| Public API / type | 511 Open Data API (token): traffic events, tolls, WZDx. **No camera/CCTV endpoint.** |
| Auth / rate limit | free token (https://511.org/open-data/token — not registered). Default 60 requests / 3600 s. |
| Terms URL(s) | https://511.org/open-data/traffic (links the "511 Data Agreement Final 2026.pdf") |
| Coverage status | NO PUBLIC FEED (cameras); the Bay Area is covered by Caltrans D4 (756 cameras) |
| Recommendation | Not needed for cameras. |

### 511SD (SANDAG) (`ca_511sd`)

| Item | Finding |
|---|---|
| Owner | San Diego Association of Governments (SANDAG) |
| Public API / type | None found. Consumer site `traffic.511sd.com` and low-bandwidth `lbw.511sd.com/lbweb` (Castle Rock "Streamlined Web" platform); no developer/data page. |
| Coverage status | NO PUBLIC FEED. San Diego freeway cameras come from Caltrans D11 (324 cameras). Whether 511SD shows any non-Caltrans cameras is UNKNOWN. |
| Recommendation | Not needed; use CWWP2 D11. |

**California summary**: best source is Caltrans CWWP2 (12 static JSON feeds). Auth none; format JSON (also XML/CSV/TXT); stills proxy+cache with a short TTL; HLS by direct official URL on click. Cadence 1–5 min in metros (per-camera field). Attribution "Camera imagery: Caltrans". Terms verdict: permissive (public domain, integration intended, fair-use clause). No blockers.

## Georgia

Best source: **511GA developer API v2** (keyed; 511 developer-API family). It already aggregates the Atlanta-metro city and county cameras, so no separate metro source is needed.

### 511GA Developer API (`ga_511ga`)

| Item | Finding |
|---|---|
| Owner | Georgia DOT (GDOT). Platform is Arcadis IBI "TravelIQ" behind AWS CloudFront. |
| Public API / type | REST, JSON or XML. Developer key required. |
| Metadata endpoint | `https://511ga.org/api/v2/get/cameras?key={key}&format=json` (or `xml`; JSON is the default). The hinted legacy `/api/getcameras` returns **404**. |
| Still image URL pattern | `https://511ga.org/map/Cctv/{viewId}`, taken from `Views[].Url`. No key needed, unsigned, stable. PNG 450×253 with a burned-in camera caption and a **511GA logo watermark**. |
| Video (HLS/MJPEG) | Not in the documented API. The consumer UI plays HLS from `https://sfs-msc-pub-lq-NN.navigator.dot.ga.gov:443/rtplive/{CAMERA}/playlist.m3u8`. The internal JSON marks it `isVideoAuthRequired: true`, and the site mints a token through GDOT's stream-manager. An unauthenticated request returns 200 `text/html` (246 B), not a manifest. Treat video as **gated / off-limits**. |
| Refresh cadence | documented: none in the API; the consumer UI config has `CameraRefreshRateMs='60000'`. observed: image `Cache-Control: max-age=60`; image bytes changed between two fetches ~90 s apart. |
| Auth | Free key. Create a My511 account at https://511ga.org/my511/register, then request the key at https://511ga.org/developers/doc (not registered). |
| Rate limit | "Throttling is enabled. Ten calls every 60 seconds." (re-verified 2026-09-30) |
| Attribution | Not specified. Logo use needs written permission. Suggested: "Traffic camera images: Georgia DOT / 511GA". |
| Terms URL(s) | https://www.dot.ga.gov/GDOT/Pages/EndUserAgreement.aspx (GDOT website and mobile-app EULA) · https://511ga.org/privacy (logo clause). The API-key terms are shown only after login and were **not seen**. |
| CORS — metadata | HEAD → 405 (`Allow: GET`). GET without a key → **400** `<Error><Message>Invalid Key</Message></Error>` (`application/xml`), **no ACAO** even with `Origin`, `Cache-Control: no-cache`. CORS on a successful keyed response is unverified. |
| CORS — image | ACAO `*` + `Access-Control-Allow-Credentials: true`, `Cache-Control: max-age=60`. **Duplicate ACAO headers** (`*` and the echoed Origin) were seen on 2 of 3 probes, including our re-check at 11:07Z. Browsers reject that for CORS-mode `fetch`; a plain `<img>` is unaffected. |
| Cameras / coverage | 4,331 camera sites (internal list `recordsTotal`, 2026-09-30); the About page says "3,700+". Statewide GDOT plus local agencies: City of Atlanta, Cobb, Gwinnett, Clayton, Alpharetta, Bartow, Barrow, Carroll, Cherokee, Coffee, Forsyth, Bibb. |
| Field map | id `Id` (site), view id `Views[].Id`; name `Name` (GA only, e.g. "GDOT-CCTV-0054") / `Location`; last-updated **none**; status `Views[].Status` ("Enabled"/"Disabled"); route `Roadway`; direction `Direction` (enum + "Unknown"); mile marker: **no field**, only in text (`Location` / `Views[].Description`, e.g. "… MM 25.7 (Fulton)"); coords `Latitude` / `Longitude`; image `Views[].Url`; video none; extras `Source` ("SKYLINE"), `SourceId`, `SortOrder`. |
| Coverage status | FULL per docs, including Atlanta-metro local agencies. Unverified without a key. |
| Recommendation | Adapter `ibi511_v2`. Images: **reference official URL directly**, and only after GDOT confirms commercial display in writing. **No proxy/cache**: the GDOT EULA bars copying, storing and redistribution without express written consent. If GDOT declines, **link-out only**. |

**Terms (quoted)**, from the GDOT EULA unless noted:
- Redistribution: "You may not alter, modify, copy, distribute (for compensation or otherwise), transmit, display, perform, reproduce, reuse, post, publish, license, frame, download, store for subsequent use, create derivative works from, transfer, or sell any Content without our express written consent."
- Embedding: this appears among the prohibited uses: "Manipulate or otherwise display the GDOT Website by using framing, creating deep links to the GDOT Website by by-passing the GDOT Website's home page, mirroring or similar navigational technology or directly link to any portion of the GDOT Website other than the main homepage."
- Proxy/cache: "We hereby grant you a limited, non-exclusive and revocable license to access and make personal use of the GDOT Mobile Application, but not to download, copy (other than page caching for personal use) or modify it or any portion of it, except with our express written consent…"
- Commercial: "This license does not include any resale, commercial use or alternative display of the GDOT Mobile Application or any of the text, pictures, graphics, logos, names, trademarks, images or other materials and content displayed on and from the GDOT Mobile Application…"
- Watermarks/attribution (511GA privacy page): "Registered and non-registered users of the 511GA website and My511 Services are not permitted to modify, duplicate, or otherwise use the Georgia Department of Transportation and the 511 Georgia trademarks or logos in any manner without prior written permission." The EULA also prohibits: "Delete any author attributions, legal notices or proprietary designations or labels."

**Image probes**

| camera | image URL | status | content-type | Last-Modified (age) | size | ACAO | Cache-Control |
|---|---|---|---|---|---|---|---|
| view 186 (doc-sample id; now "GDOT-40: Peachtree St at John Portman Blvd") | https://511ga.org/map/Cctv/186 | 200 | image/png 450×253 | = Date (synthetic) | 158,660 B | `*` (+ echoed Origin once) | max-age=60 |
| view 18558 "ATL-CCTV-0602 Buford Hwy @ Lenox Rd" | https://511ga.org/map/Cctv/18558 | 200 | image/png | 117 s before Date; = Date on re-check | 204,503 / 202,521 B | `*` + echoed Origin (duplicate) | max-age=60 |

**Notes**
- HEAD on `/map/Cctv/*` returns `Content-Length: 0`; probe with GET. `Last-Modified` is the edge/response time, not the capture time, and there is no machine-readable capture time anywhere.
- The doc-sample IDs are stale (186 now shows a different camera). Site `Id` ≠ view `Id`, so always use `Views[].Url` verbatim.
- `Roadway` formatting is inconsistent ("1stSt", "SR 9/Atlanta Hwy").
- `https://511ga.org/List/GetData/Cameras?query=…` is an **undocumented internal endpoint — needs terms confirmation**. It returns 200 JSON, no ACAO, max-age=60. Do not use it: the GDOT EULA also bans "any robot, spider, scraper…". One request was made, for counts and schema.
- It is ambiguous whether the GDOT EULA governs the developer API. 511ga.org does not link to it, and the API exists "to create mobile traffic apps". Get written confirmation.
- "GDOT does not record video" (FAQ).

**Evidence**
- https://511ga.org/developers/doc
- https://511ga.org/help/endpoint/cameras
- https://511ga.org/help/subendpoint/cameras
- https://511ga.org/my511/register
- https://511ga.org/about/about
- https://511ga.org/about/faq
- https://511ga.org/privacy
- https://www.dot.ga.gov/GDOT/Pages/EndUserAgreement.aspx

**Fixture**
- `ga_511ga/doc_sample_getcameras.json`: the JSON sample published on https://511ga.org/help/endpoint/cameras (fetched 2026-09-30T09:11:40Z). **Doc sample, not a live pull** (2 cameras); a live pull needs a key.
- `ga_511ga/internal_list_getdata_cameras.json`: **internal endpoint**, `https://511ga.org/List/GetData/Cameras` DataTables query (start=0, length=15). Fetched 2026-09-30T10:13:34Z. Wrapper kept; 15 of 4,331.

### GEMA ArcGIS mirror of 511GA cameras (`ga_gema_arcgis`)

| Item | Finding |
|---|---|
| Owner | Georgia Emergency Management & Homeland Security Agency (GEMA), AGOL org `2iUE8l8JKrP2tygQ`. The data is an export of 511GA/GDOT. |
| Public API / type | ArcGIS FeatureServer, JSON. No key. |
| Metadata endpoint | `https://services1.arcgis.com/2iUE8l8JKrP2tygQ/arcgis/rest/services/GDOT_511_Cameras/FeatureServer/0/query?where=1%3D1&outFields=*&f=json` (maxRecordCount 1000) |
| Still image URL pattern | `Url` → `https://511ga.org/map/Cctv/{viewId}` (same host and terms as 511GA) |
| Video (HLS/MJPEG) | `VideoUrl` holds the gated NaviGAtor HLS. Do not use. |
| Refresh cadence | Layer `dataLastEditDate` = **2025-09-09**, a static snapshot ~12.7 months old. Images refresh like 511GA. |
| Auth / rate limit | none / not stated |
| Attribution / terms | none stated (`licenseInfo` null); the images remain under GDOT terms |
| CORS — metadata | ACAO `*`; `Cache-Control: public, max-age=30, s-maxage=30` |
| Cameras / coverage | 3,830 features statewide (as of 2025-09) |
| Field map | id `Id` (view id); name `Description`; last-updated none; status `Status`; route `Roadway`; direction `Direction`; mile marker none; coords `Latitude` / `Longitude` + point geometry; image `Url`; video `VideoUrl` |
| Coverage status | PARTIAL (stale secondary mirror) |
| Recommendation | Not a source. At most a one-time keyless bootstrap of locations before the 511GA key arrives; image handling follows the 511GA verdict. |

**Notes**
- Older copies are staler still: GEMA `GDOT_Live_Traffic_Cameras` (2020-12-29) and City of Atlanta DPW `GDOT_LiveTrafficCameras` (2018-12-07).
- GDOT's own AGOL org (`6RaeG1zfsIoM9Lze`) has **no public camera layer**.
- The "GDOT Camera Information" items belong to an Esri staff account and are not official.

**Evidence**
- https://services1.arcgis.com/2iUE8l8JKrP2tygQ/arcgis/rest/services/GDOT_511_Cameras/FeatureServer/0?f=json
- https://hub-gema-soc.opendata.arcgis.com/datasets/gdot-live-traffic-cameras/data

**Fixture**
- `ga_gema_arcgis/gdot_511_cameras_query.json`: `…/query?where=1%3D1&outFields=*&resultRecordCount=15&f=json`, fetched 2026-09-30T10:33:23Z; 15 of 3,830.

**Georgia summary**: 511GA API v2 with a free key; JSON/XML; ~4,331 sites. Reference `/map/Cctv/{viewId}` directly; no proxy/cache; keep the watermark; no video. Cadence 60 s. Attribution "Traffic camera images: Georgia DOT / 511GA" (no GDOT/511GA logos). Terms verdict: **restrictive — written consent needed** for commercial display. **Blockers:** the developer key, and written permission from GDOT (https://511ga.org/contact).


## Missouri

Best source: the **MoDOT ArcGIS "Cameras" MapServer layer**. It is keyless and statewide (880 cameras) and already includes St. Louis (Gateway Guide), Kansas City (KC Scout) and Springfield (Ozarks Traffic). The limits:

- It is **video only**: HLS, no stills.
- KC Scout video is token-gated.
- MoDOT publishes no reuse terms; the site footer says "All Rights Reserved".

### MoDOT Traveler Information — ArcGIS "Cameras" layer (`mo_modot`)

| Item | Finding |
|---|---|
| Owner | Missouri Department of Transportation (MoDOT) |
| Public API / type | ArcGIS Server **MapServer** layer (JSON, geoJSON, PBF; maxRecordCount 2000). Public GIS service, but no MoDOT page documents it for reuse. |
| Metadata endpoint | `https://mapping.modot.org/arcgis/rest/services/TravelerInformation/NWSDATA/MapServer/0/query?where=1%3D1&outFields=*&f=json` (880 rows; re-verified) |
| Still image URL pattern | **None in the layer**: `URL1` is null on all 880 rows (re-verified). 12 rural snapshot-only sites exist only in an internal file: `https://traveler.modot.org/traffic_camera_snapshots/{name}/{name}.jpg`. |
| Video (HLS/MJPEG) | HLS in `URL2`, three groups:<br>(a) 390 MoDOT cameras: `https://sfs0N-traveler.modot.mo.gov/rtplive/MODOT_CAM_{n}/playlist.m3u8` (Wowza, 800×450)<br>(b) 168 Ozarks Traffic cameras: `https://s2.ozarkstrafficoneview.com/rtplive/CAM{n}/playlist.m3u8`<br>(c) 322 KC Scout cameras: `https://traveler.modot.org/tisvc/api/Tms/CameraStream/{id}`, which returns 403 outside the MoDOT site<br>No MJPEG. |
| Refresh cadence | documented: none. observed: live HLS; the 12 stills were 6–7 s old. `REFR_RATE_MS` is always -1. |
| Auth | none (KC Scout video is tokenised, see below) |
| Rate limit | None documented. traveler.modot.org sits behind Imperva bot protection, so heavy server-side polling may be challenged. |
| Attribution | None specified. Suggested: "Camera: Missouri Department of Transportation (MoDOT)". |
| Terms URL(s) | https://www.modot.org/closed-circuit-cameras · https://www.modot.org/privacy (footer "© 2026 Missouri Department of Transportation, All Rights Reserved") · KC Scout licence (MoDOT is "Owner"): https://www.kcscout.net/UserLicense.aspx |
| CORS — metadata | ArcGIS query: **no ACAO** even with `Origin` (`Vary: Origin`); `Cache-Control: must-revalidate,max-age=0,public` |
| CORS — image | Stills: no ACAO, no Cache-Control (ETag only). HLS (sfs / Ozarks): ACAO `*`, `no-cache`. |
| Cameras / coverage | **880**: St. Louis (Gateway Guide) ≈298, outstate corridors ≈92, Kansas City (KC Scout, MO + KS sides) 322, Springfield (Ozarks Traffic) 168. `STREAM_ERROR`: 39 Y / 841 N. Plus 12 rural stills (internal file only). |
| Field map | id `CAM_ID`; name `DESCRIPTION`; last-updated none; status `STREAM_ERROR` (Y/N); route, direction and mile marker are parsed from `DESCRIPTION` (e.g. "I-29 NB At 64th St", "MM 256.8"); coords `X` / `Y` + geometry (WGS84); image none (`URL1` null); video `URL2` |
| Coverage status | PARTIAL (statewide metadata; video only, no stills). KC is METADATA ONLY. |
| Recommendation | Adapter `arcgis_rest` (MapServer query). Image handling: **reference official URL directly**, meaning click-to-play HLS from the MoDOT/Ozarks servers: no proxy, no re-stream, no frame-grab thumbnails. This is **provisional**: no reuse permission is published and MoDOT supplies camera views to media "through agreements". Get written MoDOT permission before production. |

**Terms (quoted)**
- Redistribution: "Camera views are also provided to the local media through agreements to provide additional information in media traffic reporting efforts." (closed-circuit-cameras page)
- Embedding: not addressed.
- Proxy/cache: not addressed. The nearest statement: "Video and photos from the cameras are only available in real time and are not stored."
- Commercial: not addressed on MoDOT pages.
- Watermarks/attribution: not addressed on MoDOT pages. The KC Scout licence, where MoDOT is Owner, says: "The Products are copyrighted and you shall not alter or remove any copyright notice or proprietary legend contained in or on the Products."

**Image probes**

| camera | URL | status | content-type | Last-Modified (age) | size | ACAO | Cache-Control |
|---|---|---|---|---|---|---|---|
| I-44 @ RT-MM Springfield (still) | https://traveler.modot.org/traffic_camera_snapshots/I-44@RT-MM_Springfield/I-44@RT-MM_Springfield.jpg | 200 | image/jpeg | 09:20:15Z (7 s) | 127,699 B | none | none |
| I-70 @ Rocheport (still) | https://traveler.modot.org/traffic_camera_snapshots/I-70@RocheportEOMORiver/I-70@RocheportEOMORiver.jpg | 200 | image/jpeg | 10:14:31Z (6 s) | 174,166 B | none | none |
| MODOT_CAM_271 (HLS master) | https://sfs01-traveler.modot.mo.gov/rtplive/MODOT_CAM_271/playlist.m3u8 | 200 | application/vnd.apple.mpegurl | n/a | 127 B | `*` | no-cache |

**Notes**
- The traveler map itself reads two files, each an **undocumented internal endpoint — needs terms confirmation**:
  - `https://traveler.modot.org/timconfig/feed/desktop/StreamingCams2.json`: 880 rows; fields `location, x, y, rtmp (null), html`; **no id field**; Last-Modified 2026-06-30 (a static inventory).
  - `https://traveler.modot.org/map/js/snapshot.json`: the 12 stills.
  - The sibling `mo_wzdx.json` is registered with USDOT's work-zone feed registry; the camera files are not.
- The SEMA AGOL copy (`services2.arcgis.com/jWXb6JPWtBjOCalT/.../MODOT_Traffic_Cameras/FeatureServer`) says the MoDOT service "should be used as the authoritative source", so do not use the copy.
- mapping.modot.org failed DNS once during testing; treat it as flaky.
- The Ozarks HLS server's `Date` header ran ~29 min fast.
- How often `STREAM_ERROR` updates is **unverified**.

**Evidence**
- https://mapping.modot.org/arcgis/rest/services/TravelerInformation/NWSDATA/MapServer/0?f=pjson
- https://traveler.modot.org/map/js/site.js
- https://www.modot.org/closed-circuit-cameras
- https://www.kcscout.net/UserLicense.aspx
- https://www.arcgis.com/home/item.html?id=38774183927d423488f9e2e707a6eca5
- https://data.transportation.gov/resource/69qe-yiui.json

**Fixture**
- `mo_modot/arcgis_cameras_query.json`: `…/NWSDATA/MapServer/0/query?where=CAM_ID IN (1000,1001,1002,1025,1094,1095,1096,1097,1150,1222,3964,3965,3966,3967,1227)&outFields=*&resultRecordCount=15&f=json`, fetched 2026-09-30T10:13:18Z; 15 of 880. The sample deliberately mixes Ozarks, St. Louis, KC and 4 `STREAM_ERROR=Y` rows.
- `mo_modot/internal_streaming_cams2.json`: **internal**, `StreamingCams2.json`, fetched 2026-09-30T09:12:37Z; top-level array cut to the first 15 of 880.
- `mo_modot/internal_snapshot.json`: **internal**, `snapshot.json`, fetched 2026-09-30T09:12:38Z; complete file (12 of 12).

### KC Scout — Kansas City (`mo_kcscout`)

| Item | Finding |
|---|---|
| Owner | KC Scout, a joint MoDOT + KDOT program (the licence names MoDOT as "Owner") |
| Public API / type | No public feed. Its 322 cameras appear in the MoDOT layer (`URL2` = the tisvc lookup). kcscout.net uses internal ASP.NET POST services (`DataProvider.asmx/LoadEntities`, `/GetVideoParams`, `/getTrafficLandVideoFeedData`). |
| Metadata endpoint | via `mo_modot`: `where=URL2 LIKE '%tisvc%'` |
| Still image URL pattern | None public. kcscout.net pulls some images from the **TrafficLand** REST service. |
| Video (HLS/MJPEG) | HLS on Wowza `live-secure` (`5fca316e7c40f.streamlock.net`) with a **SecureToken** issued by `GetVideoParams`: **tokenised, not used**. `traveler.modot.org/tisvc/api/Tms/CameraStream/{id}` → HEAD 405 / GET 403. The lane did not fake the Referer header or cookies. |
| Auth | tokenised / access-controlled; an agreement is needed |
| Attribution | Suggested: "KC Scout (MoDOT/KDOT)". Keep copyright legends. |
| Terms URL(s) | https://www.kcscout.net/UserLicense.aspx |
| Cameras / coverage | 322 (KC metro, MO + KS) |
| Coverage status | METADATA ONLY |
| Recommendation | Metadata via `mo_modot`; **link-out only** (kcscout.net). The video is tokenised and the licence is non-transferable. TrafficLand appears to be the commercial channel (**unverified**, inferred from site code). |

**Terms (quoted)**, from the KC Scout licence:
- Redistribution / commercial: "Owner grants you a non-transferable, non-exclusive license to use the Products for your personal or business use."
- Proxy/cache: not addressed. On termination: "you shall destroy any and all copies of the Products, including those copies on your computer hard drive".
- Watermarks: "you shall not alter or remove any copyright notice or proprietary legend contained in or on the Products."
- Embedding: not addressed.

**Evidence**
- https://www.kcscout.net/js/openlayers/vcsCameraLayer.js
- https://www.kcscout.net/js/DynamicContentManager.js
- https://www.kcscout.net/UserLicense.aspx

### Gateway Guide (St. Louis) and Ozarks Traffic (Springfield) — served by `mo_modot`

| Brand | Owner | Cameras | Own feed? | Video | Coverage status | Recommendation |
|---|---|---|---|---|---|---|
| Gateway Guide (`mo_gatewayguide`) | MoDOT St. Louis District TMC | ≈298 | No; folded into the MoDOT map and layer | HLS `sfs0N-traveler.modot.mo.gov` (ACAO `*`) | METRO ONLY (via `mo_modot`) | covered by `mo_modot` |
| Ozarks Traffic (`mo_ozarkstraffic`) | City of Springfield + MoDOT joint TMC | 168 | No. ozarkstraffic.com is behind an Imperva browser challenge, which the lane did not bypass. | HLS `s2.ozarkstrafficoneview.com` (ACAO `*`) | METRO ONLY (via `mo_modot`) | covered by `mo_modot`; no Ozarks terms found |

Evidence: https://www.modot.org/gatewayguide · https://www.springfieldmo.gov/5037/Traffic-Signals-and-Management

**Missouri summary**: MoDOT ArcGIS layer, no key; Esri JSON + HLS. No stills: click-to-play HLS referenced directly (provisional); KC is link-out only. Attribution "Camera: Missouri Department of Transportation (MoDOT)" (plus "Ozarks Traffic (City of Springfield/MoDOT)" where applicable). Terms verdict: **unclear**: nothing grants reuse, the site says "All Rights Reserved", and media access is "through agreements". **Blockers:** written MoDOT permission; a KC Scout agreement for video. Thumbnails would require frame-grabbing video, which is not advisable without an agreement.

## Indiana

Best source: **INDOT TrafficWise / 511IN**: 747 sites statewide with stills and HLS. It is reachable **only through an undocumented internal GraphQL API**. No documented feed or ArcGIS camera layer exists. **Link-out only** until INDOT agrees.

### INDOT TrafficWise / 511IN (`in_indot`)

| Item | Finding |
|---|---|
| Owner | Indiana DOT (INDOT TrafficWise). The site runs on Castle Rock's shared 511 platform (app id `crc.carsapp.in`). The per-camera `agencyAttribution.agencyName` is "Skyline", the video vendor. |
| Public API / type | **No documented camera API.** The site uses GraphQL at `POST https://511in.org/api/graphql`: **undocumented internal endpoint — needs terms confirmation**. `in.carsprogram.org/carsapi_v1` hosts only the USDOT-registered work-zone feed (its root returns 403). The INDOT ITS ArcGIS service has cabinets and towers but no camera layer. |
| Metadata endpoint | (internal) GraphQL `MapFeatures` query with `layerSlugs:["normalCameras"]` + bbox + zoom; `Camera(cameraId)` for details |
| Still image URL pattern | `https://public.carsprogram.org/cameras/IN/INDOT_{n}_{streamKey}.flv.png`, served as **image/jpeg** despite the name. The key matches the stream name and looks stable, but whether it rotates is **unverified**. |
| Video (HLS/MJPEG) | HLS `https://skysfs4.trafficwise.org/preroll/INDOT_{n}_{streamKey}/playlist.m3u8` (`views[].sources[]`, `application/x-mpegURL`) |
| Refresh cadence | documented: none. observed: stills 2 min 27 s – 3 min 38 s old; `lastUpdated` ~4 min old. |
| Auth | None technically; no developer programme found. |
| Rate limit | none documented |
| Attribution | Not specified. Suggested: "Camera: INDOT TrafficWise". |
| Terms URL(s) | https://511in.org/help/tou.html (a warranty disclaimer only, silent on reuse; re-verified) · https://www.in.gov/core/terms_of_use.html (state portal terms; unclear whether they govern 511in.org) |
| CORS — metadata | GraphQL: ACAO `*`; no Cache-Control (weak ETag) |
| CORS — image | Stills (S3 + CloudFront): ACAO `*` **only when `Origin` is sent** (`Vary: Origin`); no Cache-Control. HLS: ACAO echoes the origin, with credentials; `no-cache`. |
| Cameras / coverage | **747 sites statewide** (one statewide query): 712 with stills, 34 showing a "closed" placeholder, 1 inactive. Top routes: I-65 190, I-69 121, I-70 95, I-465 69, I-94 51. Includes Indianapolis city cameras and Northwest Indiana. No official count published. |
| Field map | id `uri` ("camera/23727"); name `title`; last-updated `lastUpdated.timestamp` (epoch ms; Camera query only); status `active` + view `url` = closed-icon SVG; route = `title` before ":"; direction none; mile marker `location.primaryLinearReference` (Camera query) or in `title` ("I-70/79.5"); coords `features[].geometry.coordinates` / `bbox`; image `views[].url`; video `views[].sources[].src` |
| Coverage status | NO PUBLIC FEED (documented). The internal endpoint is statewide. |
| Recommendation | **Link-out only**: deep-link to 511in.org at the camera's map location. No terms permit reuse, and the state portal terms limit content to personal use. With an INDOT data-sharing agreement, a `castlerock_graphql` adapter would work; the same platform serves Iowa and Colorado 511, and its code also references 511mn.org (the MN/FL lane should confirm Minnesota). |

**Terms (quoted)**
- Redistribution (IN.gov): "The copying, redistribution, use or publication by you of any such materials or any part of the Portal, except as allowed for in the Limited Right to Use section below, is strictly prohibited." 511in.org: not addressed.
- Embedding: not addressed.
- Proxy/cache (IN.gov): "No part of any content, graphic, form, or document may be reproduced in any form or incorporated into any information retrieval system, electronic or mechanical, other than for your personal use (not for resale or redistribution)."
- Commercial (IN.gov): prohibits using the Portal to "post, transmit, or in any way exploit any information, software, or other material for advertising or commercial purposes". 511in.org: not addressed.
- Watermarks/attribution (IN.gov): "You must keep intact all copyright and other proprietary notices." 511in.org: not addressed. Its own terms say only: "The Your 511 technology is provided to you on an "as available" basis and without any warranty of any kind".

**Image probes**

| camera | image URL | status | content-type | Last-Modified (age) | size | ACAO | Cache-Control |
|---|---|---|---|---|---|---|---|
| camera/23727 I-70/79.5 WEST ST | https://public.carsprogram.org/cameras/IN/INDOT_80_Qv2KD2hDDbPUj1Fs.flv.png | 200 | image/jpeg | 11:12:48Z (2 min 27 s) | 142,520 B | `*` (only with Origin) | none |
| camera/23752 I-65/113.5 WEST ST/MLK | https://public.carsprogram.org/cameras/IN/INDOT_212_QVc0pxec1UK4yq7l.flv.png | 200 | image/jpeg | 11:11:38Z (3 min 38 s) | 166,248 B | `*` (only with Origin) | none |
| camera/23727 HLS master | `https://skysfs4.trafficwise.org/preroll/…/playlist.m3u8` | 200 | application/vnd.apple.mpegurl | n/a | 253 B | echoes origin | no-cache |

**Evidence**
- https://511in.org/shared-7a5ede7727b55484de58.js (GraphQL URL and terms-of-use URL)
- https://511in.org/main-eb89d9aa1dbe99f31d54.js (MapFeatures and Camera queries)
- https://511in.org/help/tou.html
- https://www.in.gov/core/terms_of_use.html
- https://gis.indot.in.gov/ro/rest/services/Asset_Management_ITS/ITS_ASSETS_ro/FeatureServer

**Fixture**
- `in_indot/internal_graphql_mapfeatures_normalcameras.json`: **internal**, POST `https://511in.org/api/graphql` `MapFeatures` query, bbox N39.80 S39.74 E−86.10 W−86.20 (downtown Indianapolis), zoom 14. Fetched 2026-09-30T11:12:35Z. `data.mapFeaturesQuery.mapFeatures` cut to 15 of 25 in the bbox (747 statewide).
- `in_indot/internal_graphql_camera_detail.json`: **internal**, `Camera(cameraId:"23727")`, fetched ~2026-09-30T11:13Z; one camera, including its HLS source and `lastUpdated`.

**Indiana summary**: the best data is the 511IN internal GraphQL (747 sites, stills + HLS, ~2–4 min), but it is **not cleared**. Link-out only. Attribution "Camera: INDOT TrafficWise". **Blocker:** an INDOT data-sharing agreement or written permission; ask INDOT / Castle Rock whether a documented camera feed exists.

## Illinois

Best source: **IDOT "Illinois Gateway Traffic Cameras"**, a keyless ArcGIS Online FeatureServer behind Getting Around Illinois: 1,363 sites / 3,773 views statewide, including the Chicago collar counties and some Tollway sites. It is the only fully sanctioned statewide source in the Midwest group. **Free registration under IDOT's Access/Reuse Policy is required** for republication or linking.

### IDOT Illinois Gateway Traffic Cameras (`il_idot_gateway`)

| Item | Finding |
|---|---|
| Owner | Illinois Department of Transportation (IDOT), Gateway Traveler Information System (item owner `IDOTAdmin`). Combines IDOT, Lake County PASSAGE, DuPage, Kane and the Illinois Tollway. |
| Public API / type | **ArcGIS Online hosted FeatureServer** (JSON, geoJSON, PBF; maxRecordCount 1000, so page with `resultOffset`). The layer behind the IDOT "Traveler" web map on gettingaroundillinois.com. |
| Metadata endpoint | `https://services2.arcgis.com/aIrBD8yn1TDTEXoz/arcgis/rest/services/TrafficCamerasTM_Public/FeatureServer/0/query?where=1%3D1&outFields=*&f=json` (3,773 rows; re-verified) |
| Still image URL pattern | Field `SnapShot`:<br>• mostly `https://cctv.travelmidwest.com/snapshots/{OWNER}_{n}_{County}_{Dir}_{Road}_{latE5}_{lonE5}_{k}_{DIR}.jpg`<br>• Lake County: `https://www.lakecountypassage.com/snapshots/{Location}_cctv_{Dir}_Leg.jpg`<br>Unsigned and stable. |
| Video (HLS/MJPEG) | None in the public layer. |
| Refresh cadence | documented: policy caps fetches at one per image "every five minutes". observed: image ages 2 min 56 s – 7 min 37 s. The layer was last edited 2026-09-28T21:36Z, so its `AgeInMinutes` / `WarningAge` / `TooOld` fields are **frozen** (identical 52 min apart). |
| Auth | None for the layer or images. **A free registration and agreement to the Access/Reuse Policy are required for republication, redistribution or linking**: https://travelmidwest.com/About/RegistrationForm (CAPTCHA; asks intended usage and "Will earn revenue"; not registered). |
| Rate limit | Policy: ≤ 1 fetch per 5 min per XML feed and per image. AGOL org quota header: 6,000 request units/min, shared with all IDOT consumers. |
| Attribution | **"Gateway traffic information courtesy of the Illinois Department of Transportation"**, plus the IDOT logo per IDOT policy and a link to the policy. Layer metadata licence: **CC BY-SA 2.0** (re-verified). |
| Terms URL(s) | https://travelmidwest.com/About/InfoReusePolicy · https://travelmidwest.com/About/RegistrationForm · https://www.arcgis.com/home/item.html?id=8a885da23dfb46caaa1827ad920fb5b1 · https://gis-idot.opendata.arcgis.com/datasets/IDOT::illinois-gateway-traffic-cameras/about |
| CORS — metadata | ACAO `*` (with or without Origin); `Cache-Control: public, max-age=30, s-maxage=30` |
| CORS — image | cctv.travelmidwest.com: no ACAO; `public, max-age=0, must-revalidate`. lakecountypassage.com: no ACAO; `max-age=3600` + `public, immutable` (browsers will show stale frames). |
| Cameras / coverage | **1,363 sites / 3,773 views** (one row per direction): Lake County 475, IDOT downstate 448 (`IL-IDOTD4`: Peoria, Bloomington, Champaign, Springfield, Metro East), DuPage 182, IDOT Chicago district 149, Kane 90, Tollway (`IL-ISTHA`) 19. Statewide extent y 37.78–42.49. |
| Field map | id `OBJECTID` (per view; the site id is the `id=` value in `ImgPath`); name `CameraLocation`; last-updated `AgeInMinutes` (frozen, so use the image Last-Modified); status `WarningAge` / `TooOld` (frozen); route none (parse `CameraLocation`); direction `CameraDirection` (N/E/S/W/NONE); mile marker none; coords `x` / `y` + geometry; image `SnapShot`; video none; consumer link `ImgPath` |
| Coverage status | FULL (statewide IDOT + Chicago collar counties; Tollway partial) |
| Recommendation | Adapter `arcgis_rest` (FeatureServer query, paged). **After registration**: proxy+cache with TTL ≥ 5 min (one upstream fetch per image per 5 min), content unmodified, with the attribution sentence, IDOT logo and policy link. **Before registration**: dev/test only. The layer description calls `SnapShot` "suitable for placement in a &lt;img src&gt; tag", but the policy also routes "establishment of a link" through registration. |

**Terms (quoted)** (policy text re-verified in the site bundle):
- Redistribution: "Users must use this form to access traffic information from the Illinois Department of Transportation (IDOT), Gateway Traveler Information System (Gateway) for purposes such as republication or redistribution, inputting components of traffic information from other sources, or establishment of a link to this IDOT website."
- Embedding (ArcGIS item description): "SnapShot - public URL of camera's image file that is suitable for placement in a &lt;img src&gt; tag, for instance".
- Proxy/cache: "Initially, each camera image will not be accessed more than once every five minutes. In the future, more frequent updates may become available via this separate access."
- Commercial: "Traffic information is currently available without charge to individuals, organizations and companies via periodic downloads of data in XML format and JPEG images". Also: "Registrant shall not use the Gateway traffic information for any critical purposes or become financially dependent on the availability of this information."
- Watermarks/attribution: "The Gateway traffic information, in terms of content or accuracy, shall not be modified." And: "The message should read as follows: "Gateway traffic information courtesy of the Illinois Department of Transportation". Also, the official IDOT logo should be visible and displayed strictly in accordance with IDOT policy."
- Other clauses:
  - "Registrant shall also abide by the policies and rules of the originating agency for use of non-IDOT traffic information" (Lake County PASSAGE publishes no terms).
  - "IDOT reserves the right to require any registrant to sign a written agreement".
  - Layer licence: "Creative Commons Attribution-ShareAlike 2.0 Generic License."

**Image probes**

| camera | image URL | status | content-type | Last-Modified (age) | size | ACAO | Cache-Control |
|---|---|---|---|---|---|---|---|
| Hillside Tower Camera 9 (IDOT Chicago district) | https://cctv.travelmidwest.com/snapshots/IL-IDOTD1_1_Cook_WB_Albin_4188597_-8791483_2_NONE.jpg | 200 | image/jpeg | 10:29:57Z (7 min 37 s); re-check 3 min 45 s | 28,027 B | none | public, max-age=0, must-revalidate |
| Darrell at Roberts, East leg (Lake Co.) | https://www.lakecountypassage.com/snapshots/Darrell_@_Roberts_(Cell)_cctv_East_Leg.jpg | 200 | image/jpeg | 10:34:36Z (2 min 56 s) | 44,937 B | none | max-age=3600; public, immutable; Expires +1 h |

**Notes**
- Freshness must come from the image `Last-Modified`, because the layer's age/status fields are frozen at the last layer edit.
- Direct references to Lake County images need a cache-busting parameter (1-hour immutable caching).
- CC BY-SA is share-alike: fine for display, but a republished derived dataset would carry the same licence.
- `stltraffic.org` (District 8 / Metro East-branded; operator **unverified**) serves 71 stills via `/geoFiles/geo.json`. It duplicates Gateway coverage and is not recommended.

**Evidence**
- https://www.arcgis.com/sharing/rest/content/items/8a885da23dfb46caaa1827ad920fb5b1?f=json
- https://www.arcgis.com/sharing/rest/content/items/f77214fa1f744e8bb2409601294b22a2/data?f=json (the IDOT Traveler web map includes this layer)
- https://travelmidwest.com/About/InfoReusePolicy (the policy text ships in the SPA bundle, e.g. `/static/js/main.a73e4f48.js`)

**Fixture**
- `il_idot_gateway/arcgis_traffic_cameras_query.json`: `…/FeatureServer/0/query?where=OBJECTID IN (1,2,3,71,72,73,1030,1123,1124,1125,1126,1505,1506,3730,3731)&outFields=*&resultRecordCount=15&f=json`, fetched 2026-09-30T10:49:36Z; 15 of 3,773. Deliberately mixed: IDOT Chicago, downstate, Kane, Lake County (4 legs), DuPage, Tollway.

### Travel Midwest / Gateway XML + FTP feed (`il_travelmidwest`)

| Item | Finding |
|---|---|
| Owner | IDOT (Gateway, travelmidwest.com) |
| Public API / type | XML downloads + an FTP server of JPEGs, **for registered subscribers only**. The public SPA's map uses internal POST-only endpoints (`/lmiga/cameraMap.json` → 405 on GET). |
| Auth | **Agreement**: free registration (https://travelmidwest.com/About/RegistrationForm; not registered) |
| Rate limit | ≤ 1 fetch per 5 min per feed and per image |
| Terms / attribution | same as `il_idot_gateway` |
| Cameras / coverage | Same inventory as `il_idot_gateway`. The site also mentions some Iowa, Missouri and Wisconsin counties (not measured). |
| Coverage status | METADATA ONLY until registered (schema UNKNOWN) |
| Recommendation | Not needed if `il_idot_gateway` is used; the same registration covers both. |

Evidence: https://travelmidwest.com/About/RegistrationForm · https://its.cmap.illinois.gov/html/proj/pr2.htm

### Illinois Tollway (`il_tollway`) and City of Chicago (`il_chicago`)

| Source | Finding | Coverage status | Recommendation |
|---|---|---|---|
| Illinois Tollway | No public camera feed. The Tollway site has no camera URLs, and its WZDx feed needs a key and has no cameras. 19 Tollway sites (of ~1,400 in the internal TIMS2GO system) appear in `il_idot_gateway` (`ImgPath LIKE '%IL-ISTHA%'`). | PARTIAL (via Gateway) | no separate adapter |
| City of Chicago open data | No roadway video or still dataset. data.cityofchicago.org has only enforcement data: Speed Camera Locations `4i42-qv3h`, Red Light Camera Locations `thvf-6diy`, and violations. These are **not** roadway cameras and are excluded. | NO PUBLIC FEED | Chicago expressways are covered by `il_idot_gateway` |

**Illinois summary**: IDOT Gateway ArcGIS layer (3,773 views), no key to read; Esri JSON + JPEG. After the free Access/Reuse registration: proxy+cache with TTL ≥ 5 min, content unmodified. Cadence ~5 min. Attribution: "Gateway traffic information courtesy of the Illinois Department of Transportation" + IDOT logo + policy link (metadata CC BY-SA 2.0). Terms verdict: **permitted, with registration and conditions**. **Blocker:** the operator submits the registration form (CAPTCHA; asks usage and revenue); IDOT may require a signed agreement.

## Arizona

Best source: **AZ511 developer API v2** (keyed; same platform as 511GA). No official metro gap-filler was found.

### AZ511 Developer API (`az_az511`)

| Item | Finding |
|---|---|
| Owner | Arizona DOT (ADOT). Arcadis IBI TravelIQ platform. |
| Public API / type | REST, JSON or XML. Developer key required. |
| Metadata endpoint | `https://az511.com/api/v2/get/cameras?key={key}&format=json` (`az511.gov` answers identically). Legacy `/api/getcameras` returns 404. |
| Still image URL pattern | `https://az511.com/map/Cctv/{viewId}`, taken from `Views[].Url`. No key needed, unsigned, stable. JPEG 1280×720 with a burned-in **ADOT logo, camera label and date/time**. |
| Video (HLS/MJPEG) | None. Consumer config has `CctvEnableVideo='False'`. |
| Refresh cadence | documented: none in the API; UI `CameraRefreshRateMs='30000'`. observed: `Cache-Control: max-age=30`, but one frame's burned-in time was **~8 min** behind the fetch time. |
| Auth | Free key. Create an account at https://az511.gov/my511/register, then request the key at https://az511.gov/developers/doc (not registered). |
| Rate limit | "Throttling is enabled. Ten calls every 60 seconds." |
| Attribution | Not specified. Suggested: "Traffic camera images: Arizona DOT (AZ511)". |
| Terms URL(s) | https://az511.gov/about/disclaimer (silent on reuse) · https://azdot.gov/disclaimer (ADOT Website Policies). API-key terms are shown only after login and were **not seen**. |
| CORS — metadata | HEAD → 405. GET without a key → **400** "Invalid Key" (`application/xml`), **no ACAO**, `no-cache`. |
| CORS — image | ACAO `*` (with and without Origin) + `Allow-Credentials: true`; `Cache-Control: max-age=30` |
| Cameras / coverage | 644 camera sites (internal `recordsTotal`, 2026-09-30) on ADOT highways statewide: Phoenix freeways (I-10, I-17, SR-51, L-101/202/303), Tucson (I-10, I-19) and rural corridors. |
| Field map | id `Id`, view `Views[].Id`; name `Location`; last-updated **none**; status `Views[].Status`; route `Roadway`; direction `Direction` (mostly "Unknown"; the real direction is in text as "NB"/"EB"); mile marker in `Views[].Description` text ("SR-95 NB 249.80 @SR68 Laughlin Rd"); coords `Latitude` / `Longitude`; image `Views[].Url`; video none; `Source` "AZDOT", `SourceId` a GUID |
| Coverage status | FULL for state highways per docs, unverified without a key. Local arterial coverage is UNKNOWN (all 15 sampled rows are `Source=AZDOT`). |
| Recommendation | Adapter `ibi511_v2`. Images: **reference official URL directly**, since the API supplies these URLs for app display. **Do not proxy/cache** without ADOT permission (ADOT "retains … the right of distribution"). |

**Terms (quoted)**, from azdot.gov/disclaimer (AZ511's own disclaimer covers only alternate routes):
- Redistribution: "The state of Arizona retains all rights to the information provided by this website, including, but not limited to, the right of distribution."
- Embedding: not addressed.
- Proxy/cache: not addressed. The nearest clause: "Any and all documents available from this website may be protected under the U.S. and foreign copyright laws. Permission to reproduce may be required."
- Commercial: not addressed.
- Watermarks/attribution: not addressed. The images carry an ADOT logo and timestamp overlay; do not crop them.

**Image probes**

| camera | image URL | status | content-type | Last-Modified (age) | size | ACAO | Cache-Control |
|---|---|---|---|---|---|---|---|
| view 960 (doc sample said SR-95 Laughlin; now a Loop 101 Phoenix camera) | https://az511.com/map/Cctv/960 | 200 | image/jpeg 1280×720 | = Date (synthetic); `Age: 14`; burned-in frame ~8 min old | 111,820 B | `*` | max-age=30 |

**Notes**
- Doc-sample IDs are stale.
- `https://az511.com/List/GetData/Cameras?query=…` is an **undocumented internal endpoint — needs terms confirmation**. One request; not recommended.
- Internal rows carry questionable `county`/`city` values: I-10 @ Dragoon is tagged Graham County/Safford, but Dragoon is in Cochise County.
- Applying the azdot.gov disclaimer to az511.gov is an inference.

**Evidence**
- https://az511.gov/developers/doc
- https://az511.gov/help/endpoint/cameras
- https://az511.gov/my511/register
- https://az511.gov/about/disclaimer
- https://azdot.gov/disclaimer
- https://azdot.gov/news/nine-sr-347-traffic-cameras-now-available-through-az511gov

**Fixture**
- `az_az511/doc_sample_getcameras.json`: the JSON sample published on https://az511.gov/help/endpoint/cameras (fetched 2026-09-30T09:15:47Z). **Doc sample, not a live pull** (2 cameras).
- `az_az511/internal_list_getdata_cameras.json`: **internal endpoint**, DataTables query (length=15), fetched 2026-09-30T10:14:26Z; 15 of 644.

### ADOT "Existing CCTV" inventory layer (`az_adot`)

| Item | Finding |
|---|---|
| Owner | ADOT AGOL org `XAiBIVuto7zeZj1B`. A planning inventory; sibling layers are "Proposed … CCTV". |
| Public API / type | ArcGIS FeatureServer, JSON. No key. |
| Metadata endpoint | `https://services1.arcgis.com/XAiBIVuto7zeZj1B/arcgis/rest/services/Existing_CCTV/FeatureServer/0/query?where=1%3D1&outFields=*&f=json` |
| Still image / video | none |
| Refresh cadence | Static; last edit 2025-11-17 |
| Auth / rate limit / attribution | none / not stated / not stated (`licenseInfo` null) |
| CORS — metadata | ACAO `*`; `Cache-Control: public, max-age=30, s-maxage=30` |
| Cameras / coverage | 526 records, statewide ADOT |
| Field map | id `Cam__` (e.g. "0010N") / `ObjectId`; name `Cross_Street_Attached_to`; route `Route` ("SR-51 NB"); direction: suffix of `Route` / `Cam__`; mile marker **`MP`**; coords `Latitude` / `Longitude`; also `District`, `Area`; no status or last-updated |
| Coverage status | METADATA ONLY |
| Recommendation | Not an adapter source. At most, optional milepost/district enrichment matched to AZ511 cameras. |

**Evidence**
- https://www.arcgis.com/sharing/rest/content/items/ec493f52acd64bc1b9e75b2dbc5fb696?f=json
- https://services1.arcgis.com/XAiBIVuto7zeZj1B/arcgis/rest/services/Existing_CCTV/FeatureServer/0?f=json

**Fixture**
- `az_adot/existing_cctv_query.json`: `resultRecordCount=15`, fetched 2026-09-30T10:43:55Z; 15 of 526.

### MCDOT, City of Phoenix, City of Tucson, Pima County (no provider id)

- **NO PUBLIC FEED found.** None of these agencies publishes an official keyless camera API or ArcGIS layer.
- MCDOT runs its traffic management centre CCTV through the AZTech partnership with ADOT; public viewing points to AZ511.
- The "Phoenix traffic cameras" layer on AGOL belongs to a private company (AerialSphere) and "PHX ITS Demo" to a consultant; both excluded.
- The search was web + AGOL only, not exhaustive.
- Evidence: https://www.maricopa.gov/5307/Transportation-MCDOT

**Arizona summary**: AZ511 API v2 with a free key; JSON/XML; ~644 ADOT sites. Reference `/map/Cctv/{viewId}` directly; no proxy/cache without ADOT permission; keep the ADOT logo and timestamp; no video. Cadence 30 s (frames observed up to ~8 min old). Attribution "Traffic camera images: Arizona DOT (AZ511)". Terms verdict: **mostly silent; hotlinking the API-supplied URLs is the intended use**; ask before caching or redistributing. **Blocker:** the developer key.

## 511 developer-API family (Arcadis IBI "TravelIQ")

Georgia and Arizona both run on this platform, so one adapter (`ibi511_v2`) covers both and can be pointed at any other deployment.

- **Endpoint:** `GET https://{host}/api/v2/get/cameras?key={key}&format=json|xml` (JSON default). XML root is `<CamerasList><Cameras>…<Views><View>`. The hinted v1 path `/api/getcameras` is **404 on GA and AZ**.
- **Auth:** one free developer key per deployment. Create a My511 account, then request the key on `/developers/doc`. The key goes in the query string.
- **Rate limit:** "Throttling is enabled. Ten calls every 60 seconds." The wording is identical on every deployment checked. One call returns every camera, and the budget is shared across all resources on that key.
- **Response:** an array of sites `{Id, Source, SourceId, Roadway, Direction, Latitude, Longitude, Location, SortOrder, Views:[{Id, Url, Status, Description, (SortId), (VideoUrl)}]}`, plus per-deployment extras: `Name` (GA), `Region` / `County` (WI).
  - `Direction` enum: None, All Directions, Northbound, Eastbound, Southbound, Westbound, Inbound, Outbound, Both Directions; "Unknown" also appears in data.
  - **No last-updated field and no milepost field.** Parse milepost and direction from `Description` text.
- **Images:** `Views[].Url` = `https://{host}/map/Cctv/{viewId}`. No key, unsigned, ACAO `*`, `max-age` equal to the deployment's UI refresh (GA 60 s, AZ 30 s). HEAD returns `Content-Length: 0`, so probe with GET. `Last-Modified` is synthetic.
- **Doc-sample IDs are stale**, and site `Id` ≠ view `Id`. Always use `Url` verbatim.

Deployments checked (developer doc page fetched 2026-09-30; all carry the same key and throttle text):

| Deployment | v2 cameras | `VideoUrl` in doc sample |
|---|---|---|
| 511GA (https://511ga.org/developers/doc) | yes | no |
| AZ511 (https://az511.gov/developers/doc) | yes | no |
| 511NY (https://511ny.org/developers/doc) | yes | no |
| 511WI (https://511wi.gov/developers/doc) | yes | yes |
| UDOT Traffic (https://udottraffic.utah.gov/developers/doc) | yes | no |
| NVRoads (https://nvroads.com/developers/doc) | yes | yes |
| 511 Idaho (https://511.idaho.gov/developers/doc) | yes | no |
| 511 Alaska (https://511.alaska.gov/developers/doc) | yes | no |
| 511LA (https://511la.org/developers/doc) | yes | yes |
| 511 Ontario (https://511on.ca/developers/doc) | yes | no |
| 511 Alberta (https://511.alberta.ca/developers/doc) | yes | no |
| CTroads (https://ctroads.org/developers/doc) | **no Cameras resource** (help page returns 500) | n/a |

**Vendor:** the doc samples reference `*.stage.traveliq.co`. Arcadis (formerly IBI Group) markets the platform as TravelIQ:
- https://www.arcadis.com/en-us/projects/north-america/united-states/511ny-travel-information-system
- https://www.ibigroup.com/2019/05/09/ibi-group-launches-travellq-traveller-information-software/

**Out-of-scope observation:** 511NY's legacy `/api/getcameras?format=json` answered 200 with data **without a key**, although its docs say a key is required. This looks like an unenforced control. It was not saved or used; do not rely on it.

**Related platform (not this family):** Castle Rock's 511 platform serves 511IN (GraphQL at `/api/graphql`), Iowa and Colorado. Its code also references 511mn.org; see `mn-fl.md` for Minnesota. 511SD (San Diego) uses Castle Rock's "Streamlined Web" front end.

## Fixture index

All paths are under `apps/api/tests/fixtures/cameras/`. `internal_` = **undocumented internal endpoint**, kept for schema reference only and not an endorsed source. All fetches were on 2026-09-30 (UTC).

| Path | Source | Fetched (UTC) | Records |
|---|---|---|---|
| `ca_caltrans_d1/cctv_status_d01.json` … `ca_caltrans_d12/cctv_status_d12.json` (12 files) | `https://cwwp2.dot.ca.gov/data/d{N}/cctv/cctvStatusD{NN}.json` | 09:25 | 15 each, edge cases included (of 145/91/275/756/181/128/592/503/23/154/324/419) |
| `ca_caltrans_gis/cctv_featureserver_query.json` | Caltrans GIS CCTV FeatureServer query | 10:16 | 15 of 2,936 |
| `tx_txdot_its/internal_cctv_status_list_aus.json` | its.txdot.gov `GetCctvStatusListByDistrict?districtCode=AUS` | 10:07 | 15 of 283 |
| `tx_drivetexas/internal_maplarge_camerapoint_query.json` | MapLarge `ProcessDirect` table query (stream tokens → `REDACTED`) | 10:36 | 15 of 3,510 |
| `tx_txdot_gis/its_device_locations_cctv.json` | TxDOT AGOL `Existing_ITS_Device_Service_view` (Type='CCTV') | 11:16 | 15 of 4,243 |
| `tx_austin_mobility/traffic_cameras_b4k4-adkb.json` | data.austintexas.gov `resource/b4k4-adkb.json?$limit=15&$order=camera_id` | 11:03 | 15 of 1,007 |
| `ga_511ga/doc_sample_getcameras.json` | JSON sample published on https://511ga.org/help/endpoint/cameras (**doc sample, not a live pull**) | 09:11 | 2 |
| `ga_511ga/internal_list_getdata_cameras.json` | 511ga.org `List/GetData/Cameras` (GDOT EULA restricts storing content; delete if strict compliance is wanted) | 10:13 | 15 of 4,331 |
| `ga_gema_arcgis/gdot_511_cameras_query.json` | GEMA AGOL `GDOT_511_Cameras` | 10:33 | 15 of 3,830 |
| `az_az511/doc_sample_getcameras.json` | JSON sample published on https://az511.gov/help/endpoint/cameras (**doc sample**) | 09:15 | 2 |
| `az_az511/internal_list_getdata_cameras.json` | az511.com `List/GetData/Cameras` | 10:14 | 15 of 644 |
| `az_adot/existing_cctv_query.json` | ADOT AGOL `Existing_CCTV` | 10:43 | 15 of 526 |
| `mo_modot/arcgis_cameras_query.json` | MoDOT `NWSDATA/MapServer/0` query (CAM_ID list) | 10:13 | 15 of 880 |
| `mo_modot/internal_streaming_cams2.json` | traveler.modot.org `StreamingCams2.json` | 09:12 | 15 of 880 |
| `mo_modot/internal_snapshot.json` | traveler.modot.org `map/js/snapshot.json` | 09:12 | 12 of 12 (complete) |
| `il_idot_gateway/arcgis_traffic_cameras_query.json` | IDOT AGOL `TrafficCamerasTM_Public` (OBJECTID list) | 10:49 | 15 of 3,773 |
| `in_indot/internal_graphql_mapfeatures_normalcameras.json` | POST 511in.org `/api/graphql` `MapFeatures` (downtown Indianapolis bbox) | 11:12 | 15 of 25 in bbox (747 statewide) |
| `in_indot/internal_graphql_camera_detail.json` | POST 511in.org `/api/graphql` `Camera(cameraId:"23727")` | ~11:13 | 1 |

No fixture was saved for:
- Keyed APIs (511GA and AZ511 live pulls).
- Houston TranStar: JS source, and its terms forbid reproduction.
- SoCal511: internal endpoint, its terms forbid extraction, and it only re-publishes CWWP2.
- KC Scout: tokenised.
- Travel Midwest XML: registration-gated.
- Montgomery County: exposes camera control IPs.
- Any image or video.

## Could not verify

- **Keyed 511 APIs:** live responses for 511GA and AZ511 (no key); CORS on a successful keyed response; the API-key terms shown after login; whether the GDOT EULA formally governs the 511GA API; whether AZ511 carries non-ADOT (MCDOT/city) cameras.
- **Caltrans:** whether the "copyrighted data (e.g., photographs)" caveat covers CCTV stills. We read it as third-party photos only. Also whether 511SD shows any non-Caltrans cameras.
- **TxDOT:**
  - The TrafficLand / C2C agreement terms (the article returned 403; search snippet only).
  - DriveTexas `iosurl` streams (deliberately untested: they would sidestep the token).
  - Whether the old TransGuide host is down or only blocked from here.
  - Which Houston cameras belong to TxDOT versus the city or county, and whether TxDOT ITS HOU shares TranStar images.
  - Montgomery County and El Paso bridge terms.
  - Whether Austin's image files fall under its public-domain licence (inferred).
- **MoDOT:** its position on third-party embedding or commercial display (no terms page exists); the `STREAM_ERROR` update cadence; the still cadence.
- **IDOT:** the Travel Midwest XML schema and URLs (registration-gated); who operates stltraffic.org.
- **INDOT:** whether still-image stream keys rotate; an official camera count (747 is our measurement).
- **Rate limits:** undocumented for every non-511 source. None were hit at our request volume.
