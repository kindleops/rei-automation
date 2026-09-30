# Camera Network: provider discovery for Minnesota and Florida

Status: research only, no application code. Observed on 2026-09-30 between 09:00 and 11:50 UTC.

Method: `curl` with a descriptive `LeadCommand-CameraDiscovery/0.1` User-Agent. I kept requests to a handful per endpoint, except for two short cadence polls: 3 GETs about 60 s apart, and one 10-minute HEAD poll at 60 s intervals.

I did not register for anything or enter any credentials. I did not request any tokenised or signed URL. I did not fetch any unpublished camera.

Fixtures live in `apps/api/tests/fixtures/cameras/<provider_id>/` (see §4). They are trimmed from real responses. Each kept array element is byte-for-byte what the server returned, including quirks such as a duplicated JSON key.

Legal note: the terms verdicts below are an engineering reading of published text, not legal advice.

---

## 0. Summary

| Provider id | Source | Machine-readable? | Auth | Coverage status | Verdict |
|---|---|---|---|---|---|
| `mn_mndot_iris` | MnDOT IRIS public data (`data.dot.state.mn.us/iris/camera_pub`) and MnDOT video server (`video.dot.state.mn.us`) | Yes, JSON (+ XML config feed) | None | **FULL** (statewide, 1,527 public cameras) | **Recommended MN adapter.** Proxy/cache stills server-side with a short TTL |
| `mn_511mn_cars` | 511MN (Castle Rock CARS) web-map API `mntg.carsprogram.org/cameras_v1/api/cameras` | Yes, JSON | None | FULL, but it is a mirror of IRIS | Undocumented internal endpoint, needs terms confirmation. Do not build on it. Useful only as evidence of HLS and multi-view URL patterns |
| (none) | Castle Rock CARS XML feeds, `mn.carsprogram.org/hub` | XML | Login and password issued via request form | NO PUBLIC FEED (events-focused; camera content unverified) | Not attempted |
| (none) | Minnesota Geospatial Commons (now `gis.data.mn.gov`) | n/a | n/a | NO PUBLIC FEED | No camera layer exists |
| `fl_fl511` | FL511 (FDOT) keyed API `fl511.com/api/v2/get/cameras` | Yes (IBI 511 platform) | **API key.** Issuance path is not public | UNKNOWN (could not verify without a key) | **Target FL adapter, BLOCKED** on an FDOT key and FDOT written consent |
| `fl_fl511` | FL511 website internals `/List/GetData/Cameras`, `/map/mapIcons/Cameras`, `/map/Cctv/{id}` | Yes, JSON | None | FULL metadata (4,960 cameras) | Undocumented internal. The two JSON paths are **disallowed by robots.txt**, and FL511 terms forbid re-use without consent. Fixtures kept as shape reference only |
| (none) | FL511 Embed Tool, `fl511.com/Map/EmbeddedMap?...&layers=Cameras` | No (iframe) | None | FULL (embed only) | **The only sanctioned display path today:** link out or embed the official map |
| (none) | FDOT DIVAS (`divas.cloud`, `images-dis.divas.cloud`) | n/a | For "authorized external third parties"; video is tokenised | NO PUBLIC FEED | Needs an FDOT agreement |
| `fl_fdem_arcgis` | Florida Division of Emergency Management ArcGIS copy of FL511 cameras | Yes (ArcGIS FeatureServer) | None | METADATA ONLY, stale (last data edit 2026-07-20) | Not recommended |
| (none) | FDOT Open Data Hub, FDOT ArcGIS org, district CCTV layers | n/a | n/a | NO PUBLIC FEED | Nothing current or official |

---

## 1. Minnesota

### 1.1 `mn_mndot_iris`: MnDOT IRIS public resources and MnDOT video server (RECOMMENDED)

The owner is the Minnesota Department of Transportation (MnDOT), Regional Transportation Management Center. The data comes from MnDOT's open-source ATMS, [IRIS](https://github.com/mnit-rtmc/iris). The public JSON resources are served by IRIS's `honeybee` service ([REST API doc](https://mnit-rtmc.github.io/iris/rest_api.html): "Public Resources: `iris/` … `camera_pub` [Camera] locations and configuration").

| Field | Finding |
|---|---|
| Public API | Yes. Plain JSON array, documented in IRIS docs as an unauthenticated public resource. Also an XML config feed (below) |
| Camera metadata endpoint | `https://data.dot.state.mn.us/iris/camera_pub` (424,864 B, `application/json`) |
| Secondary metadata | `https://data.dot.state.mn.us/iris_xml/metro_config.xml.gz` (514,331 B gzip, 3,707,498 B XML). **It has no `publish` flag**, so it cannot decide what is public (see notes) |
| Still-image URL | `https://video.dot.state.mn.us/video/image/metro/{name}`, for example `…/metro/C4952` or `…/metro/D6-C002`. The `metro` segment worked for every camera tested, including outstate `C30xxx` and District 6 `D6-*` |
| HLS | `https://video.dot.state.mn.us/public/{name}.stream/playlist.m3u8`. Only for `streamable: true` cameras. H.264 720×480, about 302 kbps, 10 s segments. **This pattern appears only in the 511MN internal JSON (§1.2) and is not documented by MnDOT** |
| MJPEG | `https://video.dot.state.mn.us/video/stream/metro/{name}`. Returns `multipart/x-mixed-replace` (the header value is malformed: `Content-type: multipart/x-mixed-replace; boundary=--myboundary`). About 1.4 MB in 4 s, so it is too heavy to use. The path shape is documented in IRIS [cameras.md § Video Servlet](https://mnit-rtmc.github.io/iris/cameras.html) as `/video/stream/[district]/[camera_name]` |
| Refresh cadence | **Stills are live grabs per request.** Each GET about 60 s apart returned a new JPEG (different md5 each time). `Last-Modified` equals the response `Date`, not a capture time. The image has no timestamp overlay. HLS is live. Metadata `camera_pub` changes only on configuration edits (`Last-Modified: Tue, 29 Sep 2026 20:49:55 GMT`). `metro_config.xml.gz` is regenerated daily (`Last-Modified: 01:00:05 UTC`, root `time_stamp='Tue Sep 29 20:00:04 CDT 2026'`) |
| Auth / key | None |
| Rate limit | None documented. `data.dot.state.mn.us` sets an F5 BIG-IP cookie (`TS01…`, so there is a WAF) and `Cache-Control: max-age=5` / `no-cache, no-store`. Conditional GET works: `If-None-Match` and `If-Modified-Since` both return **304** |
| Attribution requirement | None published. The **MnDOT logo is burned into every still** (bottom-left), plus a direction label such as "SW" |
| Terms of use | No camera-specific license or terms exist. Governing texts: [MnDOT Disclaimer & Legal Notices](https://www.dot.state.mn.us/information/disclaimer.html), [511MN terms of use](https://511mn.org/help/terms-of-use.html) (covers "Your 511" accounts only), and [Minn. Stat. §13.03](https://www.revisor.mn.gov/statutes/cite/13.03) |
| CORS | `camera_pub`, `metro_config.xml.gz` and the still-image servlet send **no `Access-Control-Allow-Origin`**. The HLS playlist and chunklist send `Access-Control-Allow-Origin: *` (and `…-Credentials: true`) |
| Count | `camera_pub` has 1,779 entries. 1,560 have `publish:true`. **1,527 have `publish:true` and coordinates.** Of those, 1,247 are streamable (HLS), 132 are still-only single-view, and 148 are multi-view (RWIS-style, `views:[1..5]`). All 20 test cameras (C20000 "wowza test", CTEST-Rise4, C3099x "RTMC Test Camera", CSIGTEST*) are removed by the filter `publish && lat/lon` |
| Geography | Statewide: lat 43.508 to 48.971, lon −97.202 to −89.685. About 1,125 are in the Twin Cities metro box and about 402 are outstate (interstates, US and MN trunk highways, border crossings with WisDOT) |
| Coverage status | **FULL.** It is identical to the 511MN public camera set (§1.2): set-equal by camera name, 1,527 = 1,527 |

**`camera_pub` field names** (one object per camera; keys are omitted when null):

| Concept | Field |
|---|---|
| id | `name` (for example `C4952`, `D6-C002`); `cam_num` (int, keyboard number, often absent) |
| last-updated | none per camera. Use the HTTP `Last-Modified` or `ETag` of the whole resource |
| camera status | `publish` (bool, public viewing allowed), `streamable` (bool, true when the camera has the `#LiveStream` hashtag), `hashtags` (for example `#LiveStream #Recorded`, `#d3`, `#WisDOT`, `#MnRoad`). No online/offline or video-loss flag is public; `video_loss` is only under the authenticated `iris/api/camera` |
| road / route | `roadway` (for example `I-394`, `T.H.149`, `U.S.63`) |
| cross street | `cross_street` |
| direction | `road_dir` (`NB`/`SB`/`EB`/`WB`, `""`, `N-S`, `E-W`) |
| mile marker | **none**. Embedded in `location` text as `(MP 61.7)`; 382 of 1,527 contain "MP " |
| coordinates | `lat`, `lon` (WGS84 decimal) |
| label | `location` (for example `T.H.52 NB @ 75th St NW (MP 61.7)`) |
| views | `views` (array of fixed view numbers; non-empty only for multi-view cameras) |

The `camera_pub` SQL is in [`honeybee/src/query.rs` `CAMERA_PUB`](https://github.com/mnit-rtmc/iris/blob/master/honeybee/src/query.rs). There, `streamable` is `s.name IS NOT NULL`, where `s` is the camera's `#LiveStream` hashtag row, and `views` comes from `iris.encoder_stream.view_num`.

**`metro_config.xml.gz` camera element:** `<camera name='C909' description='I-394 EB @ Hampshire Ave' lon='-93.3652' lat='44.97115'/>`.
- It has 1,749 cameras, 1,642 with coordinates, rounded to 5 decimal places.
- It has **no publish flag**. For example, `C1911` has `publish:false` in `camera_pub` but is present here.
- Some unpublished cameras (C027, C791) are absent.
- Use it only as a cross-check, never as the public-camera authority.

**Image evidence** (GET, 2026-09-30):

| URL | Status | Content-Type | Last-Modified | Bytes | Cache / CORS |
|---|---|---|---|---|---|
| `https://video.dot.state.mn.us/video/image/metro/C4952` | 200 | image/jpeg (720×480) | `Wed, 30 Sep 2026 10:27:02 GMT` (= `Date`) | 17,946; then 17,432 at +64 s; then 18,371 at +127 s (3 distinct md5) | `cache-control: private`; no ETag; no ACAO |
| `https://video.dot.state.mn.us/video/image/metro/C909` | 200 | image/jpeg | `Wed, 30 Sep 2026 10:27:04 GMT` (= `Date`) | 21,822; then 21,501; then 21,517 (3 distinct md5) | `cache-control: private`; no ETag; no ACAO |
| `https://video.dot.state.mn.us/video/image/metro/D6-C002` | 200 | image/jpeg | = `Date` | 16,356 | same |
| `https://video.dot.state.mn.us/public/C4952.stream/playlist.m3u8` | 200 | application/vnd.apple.mpegurl | none (ETag present) | 127 | `cache-control: no-cache`; `access-control-allow-origin: *` |

**Multi-view (RWIS-style) cameras (148):**
- `…/video/image/metro/C30337` with no view parameter returned **HTTP 500** (empty body).
- `…/C30337?view=1` returned a 1280×720 JPEG (27,618 B).
- `…/C30337?view=2` returned **200 with a 0-byte body**.
- This is undocumented and unreliable. 511MN serves these views from the Castle Rock mirror as `https://public.carsprogram.org/cameras/MN/{name}-v{n}` (§1.2).
- Recommendation: exclude multi-view cameras from v1 (or link out) until MnDOT confirms a supported URL.

**Terms quotes (verbatim):**

| Topic | Quote | Source |
|---|---|---|
| Public status | "All government data collected, created, received, maintained or disseminated by a government entity shall be public unless classified by statute, or temporary classification pursuant to section 13.06, or federal law, as nonpublic or protected nonpublic, or with respect to data on individuals, as private or confidential." | [Minn. Stat. §13.03 subd. 1](https://www.revisor.mn.gov/statutes/cite/13.03) |
| As-is | "The user accepts the data "as is" and assumes all risks associated with its use." | [MnDOT disclaimer](https://www.dot.state.mn.us/information/disclaimer.html) |
| Continuity | "Due to the dynamic nature of the Internet, resources that are free and publicly available one day may require a fee or restricted access the next, and the location of items may change as menus, homepages, and files are reorganized." | same |
| Framing / identity / endorsement | "You must also refrain from creating frames, or using other visual altering tools, around the MnDOT identity. Lastly, you may not imply that the state of Minnesota or the Minnesota Department of Transportation is endorsing your product or services." | same (Linking policy) |
| 511MN warranty | "The Your 511 technology is provided to you on an "as available" basis and without any warranty of any kind, including, but not limited to, the implied warranty of mercantability, fitness for a particular purpose, accuracy, title, or non-infringement." | [511MN terms](https://511mn.org/help/terms-of-use.html) |
| Redistribution | **No clause found** | n/a |
| Embedding | **No clause found** beyond the framing and identity rule above | n/a |
| Proxying / caching | **No clause found** | n/a |
| Commercial use | **No clause found** (neither a grant nor a prohibition) | n/a |
| Watermark | **No clause found.** The MnDOT logo is burned into the image; do not crop or obscure it (see the "visual altering tools" clause) | n/a |
| Operational context (FHWA 2016 case study, not binding) | "There is an option in the Active Traffic Management System (ATMS) software (IRIS) to “un-publish” individual cameras so they are blocked from real-time viewing outside the RTMC. … Cameras are only to be un-published under very limited circumstances such as fatal or potentially fatal incidents …, national security events (like Presidential motorcades) …" | [FHWA-HOP-16-033 ch. 8](https://ops.fhwa.dot.gov/publications/fhwahop16033/chap8.htm) |

**Recommendation (MN): adapter `mn_mndot_iris`, a JSON poller.**
- **Metadata:** poll `camera_pub` every 5 min with `If-None-Match` or `If-Modified-Since`. It is almost always a 304, so this is cheap, and it makes un-published cameras disappear quickly.
  - Keep only `publish === true` with numeric `lat`/`lon`.
  - Parse the mile marker from `location` using `/\(MP ([\d.]+)\)/`.
  - Map `road_dir` `""`, `N-S` and `E-W` to "bidirectional/unknown".
- **Stills:** **proxy and cache server-side with a short TTL (30–60 s)**, single-flight per camera.
  - Every request to MnDOT is a live encoder grab, and the servlet sends no CORS headers and `cache-control: private`. A shared short-TTL cache is the polite way to avoid fan-out to MnDOT, and it keeps viewer IPs off MnDOT.
  - No published term forbids this, and the data is public under §13.03.
  - Purge the cache immediately when a camera flips to `publish:false`.
  - Never crop or overlay the MnDOT logo.
  - Directly referencing the official URL in `<img>` also works technically (no CORS is needed for `<img>`), but it pushes every viewer to MnDOT.
- **Video:** optional, on demand only. The client plays MnDOT's HLS URL directly (it has ACAO `*`); never proxy video. Flag the HLS pattern as undocumented and ask MnDOT to confirm before shipping.
- **Multi-view cameras (148):** exclude in v1.
- **Attribution to display:** `Traffic camera: Minnesota Department of Transportation (MnDOT) · 511mn.org`, plus the note `Not affiliated with or endorsed by MnDOT.`
- **Terms verdict:** **GREEN with caveats.**
  - The data is public government data. No clause restricts redistribution, embedding, caching or commercial use, but there is no explicit license either.
  - We must not imply endorsement and must not visually alter MnDOT's identity.
  - A courtesy confirmation to MnDOT RTMC before commercial launch is advisable but not a technical blocker.

### 1.2 `mn_511mn_cars`: 511MN web map (Castle Rock "CARS") internal camera API

**Flag: undocumented internal endpoint, needs terms confirmation.**

511MN (<https://511mn.org>, MnDOT's official 511 site, platform by Castle Rock ITS) loads cameras from `https://mntg.carsprogram.org/cameras_v1/api/cameras`. The base URL `https://mntg.carsprogram.org` is set in the site bundle `main-1463cdf0760b4615ce98.js`.

| Field | Finding |
|---|---|
| Endpoint / format | `GET https://mntg.carsprogram.org/cameras_v1/api/cameras`. JSON array, 865,690 B, 1,527 cameras (all `cameraOwner.name: "Iris"`) |
| Auth | None. The site loads reCAPTCHA v3, but the camera API responded without a token |
| CORS | `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Credentials: true` |
| Stills | `views[].videoPreviewUrl` (for HLS cameras) or `views[].url` (for `type:"STILL_IMAGE"`) → `https://public.carsprogram.org/cameras/MN/{name}` or `…/{name}-v{n}` for multi-view cameras. Castle Rock S3/CloudFront |
| HLS | `views[].url` with `type:"WMP"` → `https://video.dot.state.mn.us/public/{name}.stream/playlist.m3u8` (1,247 cameras). This is MnDOT's server, see §1.1 |
| Cadence (mirror stills) | Irregular. `Last-Modified` observed for C4952: 10:12:40 → 10:23:55 → 10:38:21 → 10:42:22 → 10:45:25 UTC, which is 3–15 min between updates. The 511MN client config has `clientPollTime: 6e4` (60 s) |
| Field names | `id`; `name`; `public` (bool); `lastUpdated` (epoch ms, record update); `location.{latitude, longitude, routeId, linearReference, cityReference, fips, localRoad}` (`linearReference` is a route measure in miles, the closest thing to a mile marker); `views[].{name, type, url, videoPreviewUrl, imageTimestamp}` (`imageTimestamp` in epoch ms is present on 1,456 of 1,941 views); `coLocatedWeatherStationId` (206 cameras). Direction appears only in the name text |
| Terms | Same as §1.1. No separate API terms exist |
| Robots | `511mn.org/robots.txt` disallows only `/images/`. The `mntg.carsprogram.org` host has no robots.txt (404) |
| Coverage | FULL, but it is a mirror of IRIS §1.1 |
| Recommendation | Do **not** build on it. Use it only as evidence that the HLS pattern and the `-v{n}` multi-view still pattern exist. If MnDOT confirms that the Castle Rock mirror (`public.carsprogram.org/cameras/MN/{name}-v{n}`) is fine to reference, it is the only working source for the 148 multi-view RWIS cameras |

Mirror still evidence: `https://public.carsprogram.org/cameras/MN/C4952` returned 200 image/jpeg (720×480), 17,887 B, `Last-Modified: Wed, 30 Sep 2026 10:23:55 GMT` (capture/upload time), `ETag: "b93688ba…"`, `server: AmazonS3`, CloudFront, `vary: Origin`, and `access-control-allow-origin: *` when an `Origin` header is sent. It has no `Cache-Control`. The multi-view `…/C30337-v1` returned 200 image/jpeg, 28,405 B.

Out of scope: snowplow cameras (mobile, via the `avl_v2` API) and the "hot cameras" layers.

### 1.3 Castle Rock CARS XML data feeds (MN): not attempted

[castlerockits.com/xml-data-feeds](https://www.castlerockits.com/xml-data-feeds) lists Minnesota with feed access at `https://mn.carsprogram.org/hub`. It says: "These XML data feeds will be available once you request access via the CARS XML Feed Request Form and receive a login and password."

The page lists incidents/accidents, construction, truck size and weight restrictions, and winter road conditions. Its only CCTV mention is ambiguous: "Special events also available via 511 websites for each agency, including CCTV information." So it is unclear whether the feed contains cameras at all. The hub is a JSF login app (302 to `/hub/index.jsf`).

Status: **NO PUBLIC FEED** (credentials required). Its camera content is unverified. I did not register.

### 1.4 Minnesota Geospatial Commons and third-party re-hosts

- **Geospatial Commons.** `gisdata.mn.gov` now 301-redirects to the ArcGIS Hub `https://gis.data.mn.gov/`. Searching the Hub API for `camera`, `cctv` and `traffic camera` found no traffic-camera layers; only air-photo items matched. Status: **NO PUBLIC FEED**.
- **ArcGIS Online.** The only MnDOT camera layers are county or personal re-hosts:
  - Dakota County `DCGIS_OL_Transportation/MapServer/12` is a stale copy (`CAMERAID`, UTM coordinates, no image URL).
  - Carver County `MnDoT_Cameras` requires a token (`499 Token Required`).
  - The others are personal KML copies.
  
  None are official DOT sources. Skip them.

---

## 2. Florida

The FDOT architecture is as follows:
- District SunGuide ATMS instances and local agencies feed **DIVAS**, FDOT's Data Integration and Video Aggregation System, operated by ARCADIS at `divas.cloud`.
- DIVAS feeds FL511. Trade press puts it this way: "The system will be used internally by the Department to better support Regional Transportation Management Centers (RTMC), and by other state agencies, the statewide traveler information service (FL511) and authorized external third parties." ([Traffic Technology Today](https://www.traffictechnologytoday.com/news/traffic-management/florida-to-use-new-platform-for-integration-of-video-and-data-systems.html); FDOT's own project page is [FDOT ITS architecture, DIVAS](https://teo.fdot.gov/architecture/architectures/statewide/html/projects/projarch17.html)).
- FDOT has an ITN to **consolidate FL511 and DIVAS** under a new contract. Proposals were due 2026-02-17 and the term runs to 2031-04-30, with a zero-downtime transition ([summary](https://floridaprocurements.com/fdot-fl511-itn-divas-consolidation-2026/)). Expect endpoints to change.

### 2.1 `fl_fl511`: FL511 (FDOT) keyed API (TARGET ADAPTER, BLOCKED)

| Field | Finding |
|---|---|
| Owner | Florida Department of Transportation (FDOT), FL511 program ([fdot.gov/traffic/its/fl511](https://www.fdot.gov/traffic/its/fl511)). The platform is the IBI 511 platform used by 511GA and AZ511 |
| Public API | **The API exists but is not publicly documented.** `GET https://fl511.com/api/v2/get/cameras?format=json` without a key returned **400** `<Error><Message>Invalid Key</Message></Error>` (XML even with `format=json`). HEAD returned 405 (`Allow: GET`) |
| Developer portal | **None public.** `https://fl511.com/developers`, `/developers/doc` and `/developers/help` returned 404; `/developers/register` returned 302 to `/notfound`. The hint that a free key is available at fl511.com/developers is **false as of 2026-09-30** |
| Auth / key | A key is required. **Issuance path unknown; no self-service registration found.** The operator must ask the FDOT FL511 program. The contact is published on [fdot.gov/traffic/its/fl511](https://www.fdot.gov/traffic/its/fl511), and FL511 has a contact form at <https://fl511.com/contact>. A "My Florida 511" consumer account (`/my511/register`) is **not** an API key, and its license is personal-use only |
| Format / fields | **Unverified for FL.** The sibling IBI deployments document `Id, Source, SourceId, Roadway, Direction, Latitude, Longitude, Location, SortOrder, Views[{Id, Url, Status, Description, SortId}], Name`, with `Views[].Url` = `https://<host>/map/Cctv/{id}` (see `fixtures/cameras/ga_511ga/doc_sample_getcameras.json`) |
| Rate limit | Unknown (could not access) |
| CORS | The error response has no ACAO. Unknown on success |
| Coverage status | **UNKNOWN** via the API. The site shows 4,960 cameras statewide (§2.2) |

### 2.2 FL511 website internal endpoints: undocumented, robots-disallowed, terms-restricted

**Flag: undocumented internal endpoint, needs terms confirmation.** Two of these paths are disallowed by `https://fl511.com/robots.txt` (`disallow: /map/map*/`, `disallow: /list/getdata/`, `disallow: /list/GetData/`).

During discovery I made 3 requests to `/List/GetData/Cameras` and 1 to `/map/mapIcons/Cameras` before reading robots.txt. Do not use these in production.

| Endpoint | Finding |
|---|---|
| `GET https://fl511.com/List/GetData/Cameras?query={DataTables JSON}&lang=en` | JSON `{draw, recordsTotal: 4960, recordsFiltered, data:[…]}`. The client caps `length` at 100. `cache-control: public, max-age=60`. **Each record contains the `dotDistrict` key twice** (`null`, then `"District 1"`), which parsers must tolerate (last-wins). **robots-disallowed** |
| `GET https://fl511.com/map/mapIcons/Cameras` | JSON `{item1:{icon meta}, item2:[{itemId, location:[lat,lon], icon:{url}, expando:{videoEnabled}}]}`, 4,960 items (4,450 `videoEnabled:true`). **robots-disallowed** |
| Still image `GET https://fl511.com/map/Cctv/{imageId}` | JPEG proxied from DIVAS (byte-identical md5 to `images-dis.divas.cloud/DGI/chan-{sourceId}_h.jpg`). CloudFront, `cache-control: max-age=60`. **`Last-Modified` is the edge fetch time, not the capture time.** Not disallowed by robots |
| Video | `images[].videoUrl`, for example `https://dis-se19.divas.cloud:8200/chan-11552_h/index.m3u8` with `isVideoAuthRequired: true`. The site calls `/Camera/GetVideoUrl?imageId=…` and then POSTs to `https://divas.cloud/VDS-API/SecureTokenUri/GetSecureTokenUriBySourceId` (from `/scripts/jsresources/List/listResources`). **These are tokenised URLs and were not requested** |
| Cadence | FL511 client `CameraRefreshRateMs: '60000'` (60 s). The DIVAS source still updated 11:07:31 → 11:10:30 UTC (about 3 min) for chan-11552. The burned-in timestamp on the 11:12 frame read `09/30/2026 07:08:38` EDT (11:08:38 UTC), so frames are 2–5 min old when served |
| Field names | id: `id`, `DT_RowId`, `images[].id`, `sourceId`, `source` (for example `DIVAS-District 1`, `DIVAS-COT`, `DIVAS-BCTD`). last-updated: `lastUpdated` (**null in 100/100 sampled**), `created`. status: `visible`, `images[].disabled`, `images[].blocked`, `images[].videoDisabled`. road: `roadway`. direction: `direction` (`Northbound`, …). mile marker: none (sometimes in `location` or `images[].description` text). coordinates: `latLng.geography.wellKnownText` = `"POINT (lon lat)"` with `coordinateSystemId: 4326`. Also `region`, `county`, `city`, `dotDistrict`, `areaId`, `linkId1`, `tooltipUrl` |
| Count / geography | 4,960 cameras. Lat 24.550 to 30.994 (Keys to the Panhandle), lon −87.403 to −80.066. Rough bucket split: Southeast about 1,275; Central about 1,123; Tampa Bay about 834; Southwest about 544; Big Bend and Panhandle about 750; Northeast about 434 |

**Image evidence** (GET, 2026-09-30):

| URL | Status | Content-Type | Last-Modified | Bytes | Cache / CORS |
|---|---|---|---|---|---|
| `https://fl511.com/map/Cctv/4770` | 200 | image/jpeg (768×432; name, direction and timestamp burned in) | `Wed, 30 Sep 2026 11:09:44 GMT` (edge fetch time; `age: 24`) | 28,143; new frame 29,449 at 11:11:08; unchanged at 11:12:10 | `cache-control: max-age=60`; CloudFront; `access-control-allow-origin: *`. When an `Origin` header is sent, the response carries **two** ACAO headers (`*` and the echoed origin). That is invalid CORS, so browsers reject cross-origin `fetch`; `<img>` is unaffected |
| `https://fl511.com/map/Cctv/1` | 200 | image/jpeg (640×480; **"DISTRICT1 FDOT" logo** and "I-75N AT MM 051.7" burned in) | `Wed, 30 Sep 2026 11:09:24 GMT` (edge; `age: 48`) | 28,332; new frame 30,364 at 11:11:09 | same |
| `https://fl511.com/map/Cctv/4357` | 200 | **image/png 540×330 placeholder, "No live camera feed at this time"** (md5 `9c2d059e65a23b43a5b481c16918fed4`) | none | 15,136 | `max-age=60`. **The adapter must detect this 200 placeholder** |
| `https://images-dis.divas.cloud/DGI/chan-11552_h.jpg` (DIVAS source of 4770) | 200 | image/jpeg | `Wed, 30 Sep 2026 11:07:31 GMT` (real update time), then `11:10:30` | 28,143 → 29,449 | `ETag: "303b95e3cb50dd1:0"`; IIS; **no ACAO; no Cache-Control** |

### 2.3 FL511 Embed Tool: the sanctioned embed and link-out path

The [FL511 about page](https://fl511.com/about) says: "You can insert the Florida 511 statewide interactive road map from the FL511.com home page, or a specific region of the map, as a traffic information feature on your website."

The tool is at <https://fl511.com/Map/EmbeddedMapSetup>. It generates `<iframe src="https://fl511.com/Map/EmbeddedMap?lat={lat}&lng={lng}&zoom={zoom}&layers=Cameras&size=4">`, or `region=ALL|CEN|NE|NW|SE|SW|TB`. Sizes are 0 Large, 1 Medium, 2 Small, 3 Ticker and 4 Full. `layers` accepts `Cameras`, `Incidents`, `TrafficSpeeds` and others.

The `EmbeddedMap` response sends no `X-Frame-Options`, whereas site pages send `SAMEORIGIN`. FDOT District 6 embeds it on its own site ([sunguide.info/cameras-map-service](https://sunguide.info/cameras-map-service/)).

Coverage: FULL, display only. **Recommended interim display for FL:** link out to, or embed, this official map. Do not render FL511 imagery in our own UI.

### 2.4 FDOT DIVAS (`divas.cloud`, `images-dis.divas.cloud`)

- <https://divas.cloud/> is an ARCADIS portal listing "FDOT DIVAS VDS Application" (`/divas-vas/`) and "FDOT DIVAS DFS Application" (`/DIVAS-DFS/`). Both are JS apps; I did not go past the landing pages.
- Per the trade-press description above, DIVAS serves FL511 and "authorized external third parties". FDOT D5's iVEDDS video sharing is "restricted in use and not available to the general public or private entities due to bandwidth capacity" (per FDOT D5 material surfaced in search, not re-verified).
- The still host `https://images-dis.divas.cloud/DGI/chan-{sourceId}_h.jpg` is public and untokenised. There are no docs or terms, and the root page just says "Snapshots". Video requires DIVAS secure-token URIs.
- Status: **NO PUBLIC FEED.** Third-party access needs an FDOT agreement. Do not hotlink the still host.

### 2.5 `fl_fdem_arcgis`: FDEM ArcGIS copy of FL511 cameras

| Field | Finding |
|---|---|
| Owner | Florida Division of Emergency Management (ArcGIS org `3wFbqsFPLeKqOlIK`, urlKey `floridadisaster`). Item `8c0046dd833347bea1c39decec1d3abb`, owner `jray5500`, created 2022-03-08; no license or access info |
| Endpoint | `https://services.arcgis.com/3wFbqsFPLeKqOlIK/arcgis/rest/services/FL511_Traffic_Cameras/FeatureServer/0/query?where=1%3D1&outFields=*&f=json` (ArcGIS FeatureServer, maxRecordCount 2000) |
| Auth / CORS | None; `access-control-allow-origin: *`; `cache-control: public, max-age=30, s-maxage=30` |
| Freshness | `editingInfo.dataLastEditDate` = **2026-07-20 20:31:11 UTC**; `TIMESTAMP` values like `"07/20/2026 8:09:58 PM"`. It is a stale snapshot (4,057 features vs 4,960 live). The sibling layer `TrafficCameraStaticTest` (`FEEDS_CopyFeatures`) was last edited 2026-01-07 |
| Fields | `OBJECTID_1`, `ID` (FL511 id), `DESCRIPT` (for example `I-75 @ MM 352 NB`, which carries the mile marker), `COUNTY`, `HIGHWAY`, `DIRECTION` (`N`/`S`/`E`/`W`), `LATITUDE`, `LONGITUDE`, `TIMESTAMP` (string, no time zone), `IMAGE` (DIVAS still URL). No status field |
| Image check | `https://images-dis.divas.cloud/DGI/chan-9422_h.jpg` returned 200 image/jpeg, 18,592 B, `Last-Modified` 4 s old, ETag, no ACAO. `…/chan-9442_h.jpg` returned **404** (stale mapping) |
| Coverage | **METADATA ONLY (stale)** |
| Recommendation | Not an adapter source. It is a derivative of FL511 content, so FL511 terms still govern the imagery |

### 2.6 FDOT Open Data Hub, FDOT ArcGIS, district layers

- **FDOT Open Data Hub.** The `gis-fdot.opendata.arcgis.com` search API returned **0 results** for `cctv`, `camera`, `traffic camera` and `sunguide`.
- **FDOT ArcGIS org (`O1JpcwDW8sjYuddV`).** It has only:
  - a 2019 "District Three - CCTVs" story map (`TestCCTV` layer),
  - a signal inventory with a `CCTV` flag (`eTraffic_Exhibit_A_Devices_Public`),
  - a D4 camera survey form.
  
  None are camera feeds.
- **District CCTV layers** ("District Six CCTVs", "D5_CCTVLocations") are hosted by a consultant org (Metric Engineering, `Ie0K5n4UyLAfvdiX`), not by FDOT. Skip them.
- Status: **NO PUBLIC FEED.**

### 2.7 FL terms: quotes (verbatim) and verdict

| Topic | Quote | Source |
|---|---|---|
| Re-use / redistribution | "The Information provided through the Service and all rights to it are owned by the FDOT. Content available through the Service is for individual use only and is not available for re-sale or re-use without the express written consent of FDOT." | [fl511.com/privacy, "Conditions/Disclaimer"](https://fl511.com/privacy) |
| Commercial use | "Upon registration, users of the Service are granted non-exclusive, non-transferable limited license to access and use the Information for personal purposes only (and specifically excluding any commercial use)." | same |
| Warranty | "The Florida Department of Transportation (FDOT) does not guarantee the reliability, accuracy, quality, timeliness, usefulness, adequacy, completeness or suitability of the Information." | same |
| Endorsement | "The mention of another agency or entity in relation to any Information, or to the Service, does not constitute an endorsement, sponsorship or recommendation of that entity or its product or service." | same |
| Embedding (permitted path) | "You can insert the Florida 511 statewide interactive road map from the FL511.com home page, or a specific region of the map, as a traffic information feature on your website." | [fl511.com/about](https://fl511.com/about) |
| Proxying / caching | **No explicit clause.** Covered by the "re-use without the express written consent" clause above | n/a |
| Watermark | **No clause.** Stills carry burned-in FDOT district logos (for example "DISTRICT1 FDOT") and timestamps; do not crop them | n/a |
| Automated access | `disallow: /map/map*/`, `disallow: /list/getdata/`, `disallow: /list/GetData/` | [fl511.com/robots.txt](https://fl511.com/robots.txt) |
| FDOT site | "Content provided by the Florida Department of Transportation presented herein is for informational purposes only." | [FDOT web policies](https://www.fdot.gov/agencyresources/webpoliciesandnotices.shtm) |

The "Conditions/Disclaimer" text is framed around "My Florida 511" / "the Service". The conservative reading, which we adopt, is that it covers all FL511 content, including camera snapshots. Florida public-records law may bear on enforceability; that needs legal review.

**Recommendation (FL): adapter `fl_fl511`, IBI v2 keyed JSON.** It stays **disabled until both blockers clear.**
- **Endpoint:** `https://fl511.com/api/v2/get/cameras?key=${FL511_API_KEY}&format=json`.
- **Normalise:**
  - `Id` / `SourceId` / `Source` → ids
  - `Roadway` → road
  - `Direction` → direction
  - `Latitude` / `Longitude` → coordinates
  - parse `MM x` from `Location` or `Description` → mile marker
  - `Views[].Status` → status
  - `Views[].Url` → still
- **Images, until FDOT written consent:** **link out only.** Use a per-camera link or the official Embed Map iframe (`layers=Cameras`, lat/lng/zoom) from §2.3. Do not proxy, cache or hotlink `/map/Cctv/{id}` or DIVAS stills in LeadCommand.
- **Images, after consent (per its terms):** proxy with TTL ≤ 60 s, which matches FL511's own `max-age=60` and 60 s UI refresh. Or reference `/map/Cctv/{id}` directly (its CDN handles load). Detect the 540×330 PNG placeholder, and treat `disabled` / `blocked` as offline.
- **Video:** do not use. It is tokenised via DIVAS SecureTokenUri.
- **Attribution to display:** `Traffic camera: Florida Department of Transportation (FDOT) · FL511`, plus whatever wording FDOT's consent requires.
- **Terms verdict:** **RED for commercial display without consent.** There is explicit "no re-use without express written consent" language and a personal-use-only, no-commercial-use license. The embed and link-out path is permitted.

---

## 3. Normalised field map

| Canonical | MN `camera_pub` | MN 511MN CARS (internal) | FL511 API (expected, unverified) | FL511 internal GetData | FDEM ArcGIS |
|---|---|---|---|---|---|
| provider camera id | `name` | `id` (+ IRIS name inside `views[].url`) | `Id` / `SourceId` | `id` / `sourceId` | `ID` |
| label | `location` | `name` | `Location` / `Name` | `location` | `DESCRIPT` |
| road | `roadway` | `location.routeId` | `Roadway` | `roadway` | `HIGHWAY` |
| direction | `road_dir` | (text in `name`) | `Direction` | `direction` | `DIRECTION` |
| mile marker | parse `(MP x)` in `location` | `location.linearReference` (route measure) | parse `MM x` in `Location` | text only | parse `MM x` in `DESCRIPT` |
| lat / lon | `lat` / `lon` | `location.latitude` / `.longitude` | `Latitude` / `Longitude` | WKT `POINT (lon lat)` | `LATITUDE` / `LONGITUDE` |
| status | `publish`, `streamable` | `public` | `Views[].Status` | `images[].disabled` / `blocked` / `videoDisabled`, `visible` | none |
| last-updated | resource `Last-Modified` / `ETag` | `lastUpdated`, `views[].imageTimestamp` (epoch ms) | unknown | `lastUpdated` (null), `created` | `TIMESTAMP` (string, no TZ) |
| still URL | `https://video.dot.state.mn.us/video/image/metro/{name}` | `views[].videoPreviewUrl` / `views[].url` | `Views[].Url` | `https://fl511.com` + `images[].imageUrl` | `IMAGE` |
| video | HLS `…/public/{name}.stream/playlist.m3u8` (if `streamable`) | `views[].url` (`type: WMP`) | n/a | tokenised; do not use | n/a |

---

## 4. Fixtures

All fixtures are under `apps/api/tests/fixtures/cameras/`. Arrays are trimmed; kept elements are verbatim; wrapper counts (for example `recordsTotal: 4960`) are left as served.

| File | Source | Contents |
|---|---|---|
| `mn_mndot_iris/camera_pub.json` | `https://data.dot.state.mn.us/iris/camera_pub` | 15 cameras, original one-object-per-line layout. Chosen to cover: metro HLS (C909, C4952, C001 `#Preset`), District 6 (D6-C002), still-only (C30803), multi-view (C30198, C30337), `#d3` (C1504), `#WisDOT` (C870), `N-S` direction (C047), `publish:false` with coordinates (C027, C791 `#MnRoad`), `publish:false` without coordinates (C1911), and test cameras without coordinates (C20000, CTEST-Rise4) |
| `mn_mndot_iris/metro_config.xml` | `https://data.dot.state.mn.us/iris_xml/metro_config.xml.gz` (decompressed) | Full original DTD and root `time_stamp`, plus 13 `<camera>` elements (same cameras, where present). Other element types were trimmed. It is well-formed XML |
| `mn_511mn_cars/internal_cameras_v1_api_cameras.json` | `https://mntg.carsprogram.org/cameras_v1/api/cameras` (**undocumented internal**) | 13 cameras: HLS, STILL_IMAGE, multi-view with `coLocatedWeatherStationId`, and views with `imageTimestamp` |
| `fl_fl511/internal_list_getdata_cameras.json` | `https://fl511.com/List/GetData/Cameras` (**undocumented internal, robots-disallowed**) | 15 records across 5 DIVAS sources, with and without `videoUrl`. The duplicate `dotDistrict` key is preserved |
| `fl_fl511/internal_map_mapicons_cameras.json` | `https://fl511.com/map/mapIcons/Cameras` (**undocumented internal, robots-disallowed**) | 15 icons (10 `videoEnabled:true`, 5 `false`) |
| `fl_fdem_arcgis/fl511_traffic_cameras_query.json` | FDEM FeatureServer `query?where=1=1&outFields=*&resultRecordCount=15&f=json` | The complete 15-feature response (stale snapshot) |

No fixture was saved for the FL511 keyed API (a key is required) or for images.

---

## 5. Blockers and open questions

1. **FL: FDOT written consent** is required before any commercial display of FL511 content (§2.7). The operator must request it from the FDOT FL511 program.
2. **FL: FL511 API key.** The operator must request one from FDOT; there is no self-service developer portal. Also unverified until a key exists: the FL response schema, rate limit, CORS on success, and whether a key alone grants commercial use (it probably does not, given §2.7).
3. **FL: platform churn.** FL511 and DIVAS are being re-procured (ITN 2026), so URLs and schemas may change.
4. **MN: no explicit license.** The data is public and nothing prohibits reuse, but a courtesy confirmation with MnDOT RTMC before commercial launch is advisable. Ask MnDOT to confirm:
   - the HLS URL pattern;
   - the supported still URL for the 148 multi-view RWIS cameras (the official `?view=n` behaviour was inconsistent);
   - whether referencing the Castle Rock mirror `public.carsprogram.org/cameras/MN/…` is acceptable.
5. **MN: blocked or failed cameras.** MnDOT operators can un-publish or block cameras during sensitive incidents. I could not observe what the still servlet returns for a blocked or offline single-view camera. The adapter should treat non-200, 0-byte or non-JPEG responses as offline.
6. **Not verified at all:** rate limits for any MN or FL host (none are documented); how FL511 `blocked` / `disabled` cameras render; the 511MN deep-link format `https://511mn.org/@{lng},{lat},{zoom}?show=normalCameras` (seen in the site bundle, not tested in a browser).

## 6. Evidence links

- IRIS REST API (public resources): <https://mnit-rtmc.github.io/iris/rest_api.html>
- IRIS cameras (publish flag, video servlet): <https://mnit-rtmc.github.io/iris/cameras.html>
- IRIS `CAMERA_PUB` SQL: <https://github.com/mnit-rtmc/iris/blob/master/honeybee/src/query.rs>
- IRIS XML directory: <https://data.dot.state.mn.us/iris_xml/>
- IRIS public directory: <https://data.dot.state.mn.us/iris/>
- MnDOT disclaimer and legal notices: <https://www.dot.state.mn.us/information/disclaimer.html>
- 511MN terms of use: <https://511mn.org/help/terms-of-use.html>
- 511MN about: <https://511mn.org/help/About.html>
- Minnesota Statutes §13.03: <https://www.revisor.mn.gov/statutes/cite/13.03>
- MnDOT video systems engineering document (2019), which describes blocking live video for outside users: <https://www.dot.state.mn.us/its/projects/2016-2020/systemsengineeringforitsandcav/videose.pdf>
- FHWA TMC video recording and archiving case studies: <https://ops.fhwa.dot.gov/publications/fhwahop16033/chap8.htm>
- Castle Rock XML data feeds: <https://www.castlerockits.com/xml-data-feeds>
- FL511 conditions and privacy: <https://fl511.com/privacy>
- FL511 about and embed: <https://fl511.com/about>, <https://fl511.com/Map/EmbeddedMapSetup>
- FL511 robots.txt: <https://fl511.com/robots.txt>
- FDOT FL511 program page: <https://www.fdot.gov/traffic/its/fl511>
- FDOT DIVAS architecture: <https://teo.fdot.gov/architecture/architectures/statewide/html/projects/projarch17.html>
- FDOT D6 embed example: <https://sunguide.info/cameras-map-service/>
- FL511 and DIVAS ITN summary: <https://floridaprocurements.com/fdot-fl511-itn-divas-consolidation-2026/>
- FDEM FL511 camera layer: <https://services.arcgis.com/3wFbqsFPLeKqOlIK/arcgis/rest/services/FL511_Traffic_Cameras/FeatureServer/0>
- Sibling IBI 511 cameras API doc (schema family): <https://511ga.org/help/endpoint/cameras>
