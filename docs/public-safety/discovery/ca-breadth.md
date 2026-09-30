# Public Safety Network: source discovery for California (deep) and the breadth markets

Researched 2026-09-30, 09:40–12:30 UTC. This is research only: no application code was written. Fixtures are listed in [section 6](#6-fixtures).

Scope:
- **Deep:** California. CHP, Caltrans, San Francisco, Los Angeles, San Diego, Sacramento, Oakland and San Jose.
- **Breadth, lighter depth:** Kansas City, St. Louis, Indianapolis, Chicago, Phoenix, Columbus, Cincinnati, Cleveland, Philadelphia, Pittsburgh, Oklahoma City, Tulsa, Charlotte, Raleigh, Nashville and Memphis.
- **Reference:** Seattle "Real Time Fire 911 Calls".

Method:
- **User-Agent:**
  - Until about 12:13 UTC, requests used `LeadCommand-PublicSafetyDiscovery/0.1 (official open-data source discovery; low-volume research)`. It contained no personal information.
  - From about 12:13 UTC, when the coordinator's request-hygiene rules arrived, requests used exactly `LeadCommand-Discovery (+https://ops.leadcommand.ai)`.
- **robots.txt:** it was not checked before those rules arrived. It has been audited retroactively; see [§10](#10-request-hygiene-and-compliance-disclosures) for the violations found.
- **Request types:** metadata requests, aggregate queries (`max`, `count`, `group by`), small samples (`$limit`, `resultRecordCount`), HEAD requests and byte-range requests.
- **Downloads:** there were no bulk crawls. The only full-file downloads were San Diego's 2026 police calls CSV (one streamed pass, 33 MB, needed because the file is unsorted) and one Caltrans District 11 JSON (1.2 MB).
- **Access:** we did not register or use a key. We did not bypass any auth, CAPTCHA or bot protection. We did not scrape HTML for incident data.
- **Breadth research:** it was delegated to three parallel researcher passes that used the same rules. Their findings are in [§7](#7-breadth-markets-coverage-matrix). Seattle, Cleveland, Tulsa, Nashville NFD and Cincinnati `qiik-bpks` were spot-re-verified directly; everything else in §7 is as reported by those passes.
- **Lag:** "observed lag" means `max(event timestamp)` compared with the time of the check. Local times are Pacific Daylight Time (UTC−7) unless noted.

Vocabulary used in the recommendations:
- **Location precision label:** `EXACT_PUBLIC_POINT`, `APPROXIMATE_POINT`, `BLOCK_LEVEL`, `INTERSECTION`, `AREA`, `ZONE`, `WITHHELD`.
- **Canonical family:** `POLICE`, `FIRE`, `MEDICAL`, `TRAFFIC`, `HAZARD`, `EMERGENCY`, `PROPERTY_INCIDENT`, `OTHER`. `OTHER` means "not mapped", not a guess.

---

## 0. Findings that change the design

1. **Near-live official sources in scope are rare.** These are the ones that exist:
   - SF police CAD, real-time: about a 20–25 minute lag.
   - Caltrans lane closures: 5 minutes.
   - Seattle Fire 911: the reference feed, 8–15 minutes.
   - Tulsa TFD dispatch: documented as updated each minute; the file was 3–17 minutes old when checked.
   - Nashville NFD and MNPD "active" tables: about 9 minutes, but ZIP-only or with no coordinates.
   - OKC Emergency Responses: 5-minute cadence, but the table contains stuck rows.
   - CHP CAD media XML: under 1 minute, but **undocumented**.
   - Cincinnati's `qiik-bpks` is documented at 15 minutes, but it was **stale by ~29.5 h** when checked.

   Everything else in California and the breadth cities is a daily-to-quarterly batch. The UI must label freshness honestly, per source.
2. **Location is deliberately degraded by most publishers, and the method varies by source.** The adapter has to carry the label from the source; it must never upgrade precision.

   | Method | Sources |
   |---|---|
   | Nearest intersection | San Francisco |
   | Hundred-block address plus a block point | LAPD NIBRS, Oakland, Sacramento `79XX` |
   | Block address, no coordinates | San Diego, San Jose `[500]-[600]` |
   | Division or reporting district only | LAPD calls for service |
   | ZIP only | San Diego Fire/EMS |
   | Street name only | San Jose Fire |
   | Random skew within the block | Cincinnati |
   | Census tract | Cleveland EMS |

3. **Sensitive categories are often published *with* coordinates, so suppression has to be ours.**
   - LAPD NIBRS 2026: 1,230 rape, sodomy and fondling offences, all with hundred-block coordinates.
   - Oakland CrimeWatch: "FORCIBLE RAPE" and "OTHER SEX OFFENSES" rows with block addresses.
   - The Ohio and Pennsylvania breadth research found the same in Cleveland NIBRS, Philadelphia Carto and Columbus. Columbus maps missing persons, domestic violence, suicides and overdoses.
   - CHP SILVER alerts put the **missing person's name** in `LocationDesc`.

   The adapter needs one shared deny-list: sex offences, domestic violence, juvenile, suicide/5150/mental health, missing person or alerts, overdose, death, and homelessness-status calls. It needs a free-text field drop-list too.
4. **Re-identification terms apply to LeadCommand directly.** The DataSF terms say: "You hereby understand and agree that You will not take any measures to re-identify the Data or to contact individuals whose information is represented by the Data. You shall not combine the Data with data from any other data sets for the purpose of re-identification." ([DataSF Terms of Use](https://www.sf.gov/reports--april-2017--datasf-terms-use), also at https://data.sf.gov/terms-of-use)

   A real-estate lead product must never join incident points to parcel, owner or contact records, or use them to target people. Events should be map context only and must not become lead attributes. We recommend applying this rule to every source, not just San Francisco.
5. **Platforms:**
   - SF moved domains: `data.sfgov.org` now 301-redirects to `data.sf.gov`, and one aggregate query on the old host returned an nginx 403. Adapters should use `data.sf.gov`.
   - LAPD's pre-2024 crime dataset is frozen because the legacy records system was retired. Current LAPD crime data is the NIBRS dataset, refreshed "bi-weekly".

---

## 1. California: statewide sources

### 1.1 `ca_chp_cad` — CHP CAD "Media" incident XML (sa.xml)

**Does an official public XML feed exist?** Yes: `https://media.chp.ca.gov/sa_xml/sa.xml`, served by the CHP's own media host. It is **undocumented**, though:
- Neither https://media.chp.ca.gov/ ("Media CHP Traffic Incident Information") nor https://cad.chp.ca.gov/Traffic.aspx links to it.
- `https://media.chp.ca.gov/sa_xml/` returns 403.
- We found no feed-specific terms.

Verdict: **needs terms confirmation**. The content itself falls under the CHP public-domain clause. `media.chp.ca.gov/robots.txt` returns 404, so no path is disallowed. However, the endpoint is **undocumented**, so **no fixture is kept**: one was created and then deleted under the request-hygiene rules. Get written confirmation from CHP before building an adapter.

| Item | Finding |
|---|---|
| Provider / owner / jurisdiction | California Highway Patrol: CAD of CHP Communications Centers. Covers state highways and unincorporated roads statewide. |
| Access | XML snapshot over HTTPS (HTTP also 200). Single file, no query parameters. |
| Endpoint / example | `GET https://media.chp.ca.gov/sa_xml/sa.xml` |
| Live vs historical | **LIVE**, active incidents only. Nothing is retained after an incident closes. |
| Cadence | Not documented. Observed `Last-Modified` vs fetch time: 10:14:07Z vs 10:14:18Z; 10:35:50Z vs 10:36:01Z; 11:32:39Z vs 11:32:46Z. The file is regenerated at least every few minutes and was ≤ 11 s old each time. |
| Lookback | None; it is a snapshot. 114 logs at 10:14Z and 88 at 11:32Z. Between the two snapshots, 44 IDs disappeared, 18 were new, and 70 persisted, of which 19 changed. |
| Structure | `State > Center ID (SAHB, GGHB, LAHB, INHB) > Dispatch ID > Log ID`. `Log` contains `LogTime, LogType, Location, LocationDesc, Area, ThomasBrothers, LATLON, LogDetails{details{DetailTime, IncidentDetail}*, units{UnitTime, UnitDetail}*}`. Element text includes literal double quotes, e.g. `<LogTime>"Sep 30 2026  2:02AM"</LogTime>`. |
| Dispatch centres | 16 appeared in the snapshot: SACC, TKCC, UKCC, HMCC, GGCC, MYCC, SLCC, LACC, MRCC, BFCC, FRCC, BCCC (Border/San Diego), ICCC, INCC, BSCC (Barstow), OCCC. The CHP page lists 25 centres in total. Centres with no active incidents are absent (UNVERIFIED whether some centres are never published). |
| Coordinate precision | `LATLON "38593204:121392178"` = 38.593204, −121.392178: 6 implied decimals, and longitude is written positive with west implied. It is the dispatcher-geocoded CAD location, usually "highway / cross-street or ramp".<br>• `"0:0"` means no location (9 of 114).<br>• Some non-incident logs (1013 Road/Weather, SILVER alerts) carry the **communications centre's own coordinates**. For example, 34144921:118227297 is the LA centre at "2901 W Broadway". |
| Category field (`LogType`) | Values across the two snapshots, with counts from the 114-log snapshot: CZP-Assist with Construction (59), 1179-Trfc Collision-1141 Enrt (11), MZP-Assist CT with Maintenance (8), CLOSURE of a Road (7), 1125-Traffic Hazard (6), SILVER-Missing Elderly (6), 1013-Road/Weather Conditions (6), 1182-Trfc Collision-No Inj (3), CFIRE-Car Fire (2), TADV-Traffic Advisory (2), 1181-Trfc Collision-Minor Inj (2), 20002-Hit and Run No Injuries (1), FIRE-Report of Fire (1).<br>The second snapshot added 1180-Trfc Collision-Major Inj. Details also reference 1183-Trfc Collision-Unkn Inj. |
| Status | No status field. `UnitDetail` has exactly 4 values: Unit Assigned, Unit Enroute, Unit At Scene, Unit Cleared. An incident is cleared when its Log ID disappears. |
| Timestamps | `"Sep 30 2026  2:02AM"`: Pacific local time with no offset, and a double space before single-digit hours. |
| ID semantics | Log ID `YYMMDD` + 2-letter centre + sequence (e.g. `260930SA0045`). It is **stable**, and the record is updated in place: details and units are appended, and `LogType` can change. Two IDs changed type between snapshots (1179→1181, 1179→1180). |
| Privacy-sensitive fields | `IncidentDetail` is dispatcher free text: reporting-party statements, vehicle descriptions, tow-company phone numbers, witness notes. SILVER-Missing Elderly logs put the **missing person's name** in `LocationDesc`. The feed has no redaction. |
| Terms | CHP Conditions of Use: "In general, information presented on this web site, unless otherwise indicated, is considered in the public domain. It may be distributed or copied as permitted by law." ([chp.ca.gov/about-us/conditions-of-use](https://www.chp.ca.gov/about-us/conditions-of-use/), policy dated 2000)<br>The same page warns against attempts "to utilize this system for other than its intended purposes". This is one more reason to get written confirmation for automated polling. |
| Attribution | None specified. Suggest "Source: California Highway Patrol". |
| Rate limits / key / CORS | Nothing documented. No key. F5 load-balancer cookies are set. **No `Access-Control-Allow-Origin`** header, so fetch server-side only. File size is 140–170 KB. |
| Volume | About 90–115 active logs statewide at any moment in the snapshots. Roughly half are CZP/MZP construction or maintenance assists. |
| **Recommendation** | • Adapter: `xml_snapshot` (bespoke). Conditional GET using `If-Modified-Since`/ETag, every 60–120 s. Diff by Log ID and emit CLEARED on disappearance.<br>• Freshness rule: live if `Last-Modified` < 5 min. Otherwise mark the whole source stale.<br>• Precision: `APPROXIMATE_POINT`. Use `WITHHELD` when LATLON is `0:0` or equals a known comm-centre point.<br>• Family:<br>&nbsp;&nbsp;– `TRAFFIC`: 1179/1180/1181/1182/1183 collisions, 20002 hit-and-run, 1125 hazard, CLOSURE, TADV, 1013, and CZP/MZP. Consider hiding CZP/MZP by default because they duplicate Caltrans LCS.<br>&nbsp;&nbsp;– `FIRE`: CFIRE and FIRE.<br>&nbsp;&nbsp;– **Drop** SILVER and any other alert types (person-level).<br>&nbsp;&nbsp;– `OTHER` for anything else.<br>• Never store `IncidentDetail`. |
| Evidence | https://media.chp.ca.gov/sa_xml/sa.xml · https://media.chp.ca.gov/ · https://cad.chp.ca.gov/Traffic.aspx · https://www.chp.ca.gov/about-us/conditions-of-use/ |

### 1.2 `ca_caltrans_lcs` — Caltrans Lane Closure System (CWWP2)

| Item | Finding |
|---|---|
| Provider / owner / jurisdiction | Caltrans, via the Commercial Wholesale Web Portal (CWWP2). Covers the State Highway System in 12 districts. |
| Access | Static files per district in 4 formats with identical content: JSON, XML, CSV, and TXT (0xFF-delimited). |
| Endpoint / example | `https://cwwp2.dot.ca.gov/data/d{N}/lcs/lcsStatusD{NN}.json` for N = 1..12, e.g. https://cwwp2.dot.ca.gov/data/d11/lcs/lcsStatusD11.json (D4 Bay Area = `d4/lcs/lcsStatusD04.json`, D7 LA = `d7/lcs/lcsStatusD07.json`). |
| Live vs historical | **LIVE** (planned and current closures). |
| Cadence | Documented: "Every five minutes LCS reports all approved closures planned for the next 7 days, plus all current lane, ramp, and road closures due to maintenance, construction, special events, etc."<br>Observed `Last-Modified` at a 10:37:24Z check: D4 10:28:41Z, D7 10:34:45Z, D11 10:35:47Z. D11 `recordEpoch` was 10:33:03Z. |
| Lookback | Current closures plus the next 7 days. Long-term closures persist: D11 start dates ranged 2026-06-15 to 2026-10-05. |
| Coordinate precision | `begin`/`end` longitude and latitude (6 decimals), route, postmile, milepost, direction, county and nearby place. This is public infrastructure, not people. |
| Category fields | **typeOfWork** (D11, 25 values): Electrical Work 90, Sign Work 35, Highway Construction 32, Bridge Work 31, Utility Work 31, Shoulder Work 25, Striping Operation 20, Drainage Work 19, Landscape Work 18, Concrete Barrier Work 15, AC Paving 13, Guardrail Work 9, Pavement Work 9, Miscellaneous Work 9, Falsework Installation 9, Pavement Marker Replacement 9, Slab Replacement 8, Roadway Excavation 6, Emergency Work 4, Maintenance Operation 3, Core Drilling 2, Drainage Cleaning 2, Attenuator Repair 1, Curb/Gutter/Sidewalk Work 1, Grinding Operation 1.<br>**typeOfClosure:** Lane 185, Full 173, One-Way Traffic 37, Moving 8.<br>**facility:** Surface Street 92, Mainline 87, On Ramp 79, Off Ramp 75, Conventional Hwy 44, Connector 25, HOV On Ramp 1.<br>**durationOfClosure:** Standard 391, Intermittent 7, Long Term 5. |
| Status | Per the field description: `code1097.isCode1097` means "has the closure started?"; `code1098` means "has the closure ended?"; `code1022` means "has the closure been cancelled?"; none set means approved/planned.<br>D11 snapshot: 293 planned, 52 active (1097 only), 34 ended (1097+1098), 24 cancelled. |
| Timestamps | `*Date`/`*Time` fields are "PST or PDT" local. `*Epoch` fields are Unix seconds (UTC). For example, `closureStartEpoch` 1790701260 = 2026-09-29T17:01Z = 10:01 PDT. |
| ID semantics | `index` (e.g. `C5AC-0002-2026-09-29-10:01:00` = closureID-logNumber-start) was unique in D11. `closureID`+`logNumber` alone was **not** unique (8 duplicate pairs). Status is updated in place under the same `index`. |
| Privacy | None. |
| Terms | CWWP2: "These files are available for integration into your application and are available via the HTTPS protocol. There is no charge for the use of this data." ([lcs.htm](https://cwwp2.dot.ca.gov/documentation/lcs/lcs.htm))<br>Caltrans Conditions of Use (dated 2021-07-19): "In general, information presented on this website, unless otherwise indicated, is considered in the public domain. It may be distributed or copied as permitted by law." ([dot.ca.gov/conditions-of-use](https://dot.ca.gov/conditions-of-use)) |
| Attribution | Not required. Suggest "Source: Caltrans". |
| Rate limits / key / CORS | Nothing documented. No key. `Access-Control-Allow-Origin: *`. Files are large (D4 about 4.0 MB, D7 about 10.4 MB, D11 about 1.2 MB), so use `If-Modified-Since` and poll at most every 5 min. |
| Volume | D11 had 403 closures; statewide is likely in the low thousands (UNVERIFIED). |
| **Recommendation** | • Adapter: `static_json_file`, per district.<br>• Freshness: live if the file `Last-Modified` < 15 min. Show a closure as ACTIVE only if 1097 is true and 1098 and 1022 are false; otherwise SCHEDULED, ENDED or CANCELLED.<br>• Precision: `EXACT_PUBLIC_POINT` (a begin/end segment).<br>• Family: `TRAFFIC`. |
| Evidence | https://cwwp2.dot.ca.gov/documentation/lcs/lcs.htm · https://cwwp2.dot.ca.gov/documentation/lcs/lcs-field-description.htm · https://cwwp2.dot.ca.gov/ |
| Fixture | `apps/api/tests/fixtures/public-safety/ca_caltrans_lcs/lcsStatusD11_sample.json` |

**Caltrans incidents.** CWWP2 publishes no incident dataset; its datasets are Chain Controls, CCTV, CMS, LCS, RWIS, TT and WT. CCTV is out of scope (cameras). Caltrans QuickMap shows CHP incidents from undocumented KML endpoints: `https://quickmap.dot.ca.gov/data/chp-only.kml` and `…/lcs2way.kml`. Both returned 200 to a HEAD request; we did not read them. They are **undocumented internal endpoints, so they need terms confirmation**. Prefer 1.1 and 1.2.

### 1.3 `ca_calfire_incidents` — CAL FIRE incident list (statewide wildfire, supplementary)

- **Endpoint:** `https://incidents.fire.ca.gov/umbraco/api/IncidentApi/List?inactive=false`. A `GeoJsonList` variant is referenced by the community.
- **What it returned:** JSON, `Cache-Control: no-cache`.
  - Fields: `Name, Final, Updated (UTC Z), Started, AdminUnit, County, Location, AcresBurned, PercentContained, Longitude, Latitude, Type (Wildfire), UniqueId (GUID), Url, IsActive, CalFireIncident`.
  - Near-live: `Updated` was about 9 h before the check for active fires, which is how often CAL FIRE updates.
- **Status:** it powers the fire.ca.gov incident map but is **not documented**. **`incidents.fire.ca.gov/robots.txt` is `User-Agent: * / Disallow: /`.** Our single GET was made before robots.txt was checked (disclosed in §10). The `www.fire.ca.gov` host returned an Akamai 403 to our User-Agent; we did not work around it.
- **Recommendation:** **do not poll it.** It is robots-disallowed and undocumented. Ask CAL FIRE for a sanctioned feed. The documented alternative for wildfire is the NIFC/WFIGS feeds covered by the other researchers (`us_nifc_wfigs_*`). If CAL FIRE sanctions a feed: `APPROXIMATE_POINT`, family `FIRE`.

### 1.4 `ca_chp_ccrs_crashes` — California Crash Reporting System (CCRS), `data.ca.gov` CKAN (statewide, historical)

- **Endpoint:** package `ccrs` (https://data.ca.gov/dataset/ccrs), owner California Highway Patrol.
  - `Crashes_2026` resource: `b8ce0ca4-b4e9-490d-b4d1-1f4ec48cbefb`.
  - Download (robots-allowed): `https://data.ca.gov/dataset/80c6a49d-c6b3-40ba-86d8-379c9741b4be/resource/b8ce0ca4-b4e9-490d-b4d1-1f4ec48cbefb/download/crashes_2026.csv`
  - **robots.txt disallows `/api/` and `/datastore/*`**, so the CKAN API should not be used. Our `package_show` and `datastore_search_sql` queries predated the robots check (disclosed in §10).
- **Licence:** `license_title` "Other (Public Domain)".
- **Freshness:** resources were re-published 2026-09-29 to 09-30. Max `Crash Date Time` 2026-09-29T10:40 and max `CreatedDate` 2026-09-29T18:57, but volume builds up over about 4 weeks as reports are filed. Weekly counts: Aug 17 = 6,661; Sep 7 = 4,534; Sep 21 = 1,506. Treat it as **historical**, complete after about 30 days.
- **Size and location:** 266,546 crashes in 2026. 207,328 (78%) have `Latitude`/`Longitude`. `PrimaryRoad`/`SecondaryRoad` can be an exact street address (e.g. `1303 W BLAINE ST`, a "Late-Reported / Private Property" crash).
- **Other fields:** `Collision Id` (key), `Report Version`, `Is Preliminary`, `Collision Type Description`, `NumberInjured`/`NumberKilled`, `HitRun`, weather, lighting.
- **Privacy:** the sibling resources `Parties_*` and `InjuredWitnessPassengers_*` are person-level; do not ingest them.
- **Recommendation:** `csv_file` on the resource download URL, not the CKAN API (robots); historical (alarm if not re-published within 3 days); `APPROXIMATE_POINT`, downgraded to `BLOCK_LEVEL` for display when `PrimaryRoad` is a house-number address; family `TRAFFIC`.

**Bay Area 511 (`api.511.org`, MTC).** `https://api.511.org/traffic/events` returns 401 "The API key is not provided", so it **needs registration**. Its robots.txt is `Disallow: /`. Our single probe predated the robots check (disclosed in §10). It is not usable keyless.

---

## 2. San Francisco (DataSF, Socrata at `data.sf.gov`)

Portal terms apply to every SF dataset below:
- **Licence:** PDDL. Each dataset's `license` field says "Open Data Commons Public Domain Dedication and License". The terms say: "Except where otherwise stated in the file containing such Data or on the page from which such Data is accessed, including its metadata, Data is made available under the Public Domain Dedication and License v1.0."
- **Re-identification clause:** see §0.4.
- **Warranty:** "The City makes no representation or warranty that the information contained in the Data is accurate, true or correct."
- **Attribution:** not required under PDDL.
- **CORS:** `Access-Control-Allow-Origin: *`.
- **Keys and throttling:** no key needed. Socrata throttles requests without an app token; tokens are optional (https://dev.socrata.com/docs/app-tokens.html).
- **Timestamps:** `floating_timestamp` = Pacific wall-clock with no offset. This is confirmed by the real-time max, which was 19 min behind the check time.

### 2.1 `ca_sf_police_realtime_calls` — Law Enforcement Dispatched Calls for Service: Real-Time (`gnap-fj3t`)

| Item | Finding |
|---|---|
| Provider / owner | Department of Emergency Management (DEM) CAD. Primary agencies: Police, Sheriff, MTA and HEART. Jurisdiction: City and County of San Francisco. |
| Access / endpoint | Socrata SODA2: `https://data.sf.gov/resource/gnap-fj3t.json` (page: https://data.sf.gov/d/gnap-fj3t) |
| Example query | `https://data.sf.gov/resource/gnap-fj3t.json?$where=call_last_updated_at > '2026-09-30T03:00:00'&$order=call_last_updated_at ASC&$limit=1000` |
| Live vs historical | **NEAR-LIVE.** Documented: "It is both updated every 10 minutes and delayed by an additional 10 minutes." |
| Observed lag | At 09:45Z the max `received_datetime` was 02:26:41 PDT, about **19 min** behind; `data_as_of` was 02:44:15 and `rowsUpdatedAt` 09:45:50Z. At 11:24Z the max was 04:00:11 PDT, about **24 min** behind. |
| Lookback | "a rolling 48 hour window of calls for service. It contains both open and closed calls." Calls that are still open stay in: rows went back to 2026-04-11. |
| Coordinate precision | "All Calls for Service locations are shown at the intersection level only" ([explainer](https://sfdigitalservices.gitbook.io/dataset-explainers/law-enforcement-dispatched-calls-for-service)). The fields are `intersection_name` (e.g. `PACIFIC AVE \ PHOENIX TER`), `intersection_id` and `intersection_point`.<br>Sensitive calls have all location fields suppressed: 1,003 of 3,682 rows were `sensitive_call=true` with no point. Another 32 non-sensitive rows had no point. |
| Category values | `call_type_final_desc` (call counts in window): TRAF VIOLATION CITE 763, PASSING CALL 575, SUSPICIOUS PERSON 386, TRAFFIC STOP 252, FIGHT NO WEAPON 157, TRAF VIOLATION TOW 116, TRESPASSER 110, WELL BEING CHECK 101, MEET W/CITY EMPLOYEE 91, NOISE NUISANCE 76, SUSPICIOUS VEHICLE 75, BURGLARY 66, AUDIBLE ALARM 63, HOMELESS COMPLAINT 58, TOW TRUCK 57, SIT/LIE ENFORCEMENT 50, THREATS / HARASSMENT 49, MEET W/CITIZEN 41, ASSAULT / BATTERY 41, PETTY THEFT 29, INJURY VEH ACCIDENT 27, TRAFFIC HAZARD 18.<br>`agency`: Police 2,631; Municipal Transportation Agency 896; Sheriff 89; HEART 66. |
| Status | Open means `close_datetime` is null (523); closed = 3,159.<br>`disposition` codes: HAN Handled, GOA Gone on Arrival, ADV Advised, CIT Cited, REP (report), UTL Unable to Locate, NOM No Merit, ND No Disposition, ARR Arrest, NCR Non-Criminal, ABA Abated, ADM Admonished, CAN/22 Cancel, plus PAS, SFD, GEN.<br>`priority_final`: A = "Present or imminent danger to life, major property damage"; B = "potential for damage to property"; C = "no present or potential danger"; I = information-only. |
| Timestamps | `received_datetime`, `entry_`, `dispatch_`, `enroute_`, `onscene_`, `close_datetime`, `call_last_updated_at`, `data_as_of`, `data_loaded_at`. All are floating Pacific. |
| ID semantics | `id` and `cad_number` are each unique per row (3,672/3,672). Rows are **updated in place** as calls progress: `call_type_final` "may continue to change" for open calls. |
| Privacy / redactions | For sensitive types the explainer suppresses "call_type_original_notes, intersection_point, intersection_id, intersection_name, supervisor_district, analysis_neighborhood, police_district, census_tract_geoid". The types include truancy, juvenile, child abuse, sexual assault, elder abuse, DV, suicide attempt, death, 5150 and more. The call type text is **not** suppressed: the fixture has a sensitive `SUICIDE ATTEMPT` row. In practice TRAFFIC STOP, PASSING CALL and alarms are also flagged sensitive. `call_type_*_notes` is dispatcher free text; the values we saw were codes such as `22500E` or `DRUGS`. `onview_flag = HSOC` (Healthy Streets Ops Center) and agency HEART relate to homelessness and behavioural health. |
| Volume | About 1,750 dispatched calls per day; about 3,700 rows in the window. |
| **Recommendation** | • Adapter: `socrata_soda`, incremental on `call_last_updated_at`, every 10 min.<br>• Freshness: live if the source max(`received_datetime`) is within 45 min of now; otherwise the source is stale.<br>• Precision: `INTERSECTION`; `WITHHELD` for `sensitive_call`.<br>• Family: `POLICE` by default; `TRAFFIC` for 519 INJURY VEH ACCIDENT and 586 TRAFFIC HAZARD.<br>• **Suppress:** `sensitive_call=true`, 903 PASSING CALL, 585 TRAFFIC STOP, MEET W/*, PRISONER TRANSPORT, TRAF VIOLATION CITE/TOW (MTA parking), HOMELESS COMPLAINT, SIT/LIE, HEART, HSOC.<br>• Drop the `*_notes` fields. |
| Fixture | `apps/api/tests/fixtures/public-safety/ca_sf_police_realtime_calls/realtime_calls_sample.json` |

### 2.2 `ca_sf_police_closed_calls` — Dispatched Calls for Service: Closed Calls (`2zdj-bwza`)

- Same schema and privacy rules as 2.1. It is updated once every 24 h (per the explainer).
- Observed max `received_datetime` was 2026-09-28 23:53, so it runs through the previous day. It has 7,938,508 rows.
- **Historical backfill only.** `socrata_soda`, `INTERSECTION`, `POLICE`.

### 2.3 `ca_sf_fire_ems_calls` — Fire Department and Emergency Medical Services Dispatched Calls for Service (`nuek-vuh3`)

| Item | Finding |
|---|---|
| Endpoint | `https://data.sf.gov/resource/nuek-vuh3.json`. Example: `?$where=received_dttm > '2026-09-29T00:00:00'&$order=received_dttm DESC` |
| Live vs historical | **HISTORICAL**, daily: "This dataset updates daily via automated data pipeline." |
| Observed | The load runs about 04:05 PDT (`data_loaded_at` 2026-09-30T04:06:51, `rowsUpdatedAt` 11:07:46Z) and includes calls up to about 03:20 PDT. Effective lag is 0–25 h depending on the time of day. |
| Granularity | **One row per responding unit.** `rowid` = `call_number-unit_id`. Deduplicate on `call_number` (or `incident_number`). Last 7 days: 8,361 rows for 4,147 calls, about 590 calls per day. |
| Precision | "Addresses are associated with an intersection or call box, not a specific address." The `address` field is described as "obfuscated address to protect caller privacy" (e.g. `BAY ST/JONES ST`). The point is in `case_location`. |
| Categories (calls, last 30 d) | `call_type` / `call_type_group`: Medical Incident 11,492, Alarms 1,630, Citizen Assist / Service Call 571, Outside Fire 357, Other 558, Traffic Collision 402, Electrical Hazard 130, Gas Leak 120, Elevator / Escalator Rescue 112, Structure Fire / Smoke in Building 129, Smoke Investigation (Outside) 55, Vehicle Fire 34, Fuel Spill 18, Water Rescue 17, Odor (Strange / Unknown) 10, HazMat 7, Mutual Aid 4, Extrication 2, High Angle Rescue 1. |
| Status | `call_final_disposition`: Code 2 Transport, Fire, Other, Code 3 Transport, Unable to Locate, Cancelled, Medical Examiner, Multi-casualty Incident, Duplicate. Also `priority` / `final_priority` (2 = non-emergency, 3 = emergency) and `number_of_alarms`. |
| Privacy | Medical calls are health information at intersection level. The dataset also has transport and hospital timestamps and "Medical Examiner" dispositions. Do not display disposition, transport fields or medical sub-type. |
| **Recommendation** | • Adapter: `socrata_soda`, daily incremental on `data_loaded_at`.<br>• Freshness: historical; alarm if max `received_dttm` > 36 h old.<br>• Precision: `INTERSECTION`.<br>• Family: Medical Incident → `MEDICAL` (show generic "medical response" only, or aggregate); Structure/Outside/Vehicle Fire, Smoke, Alarms → `FIRE`; Traffic Collision → `TRAFFIC`; Gas Leak, Electrical Hazard, HazMat, Fuel Spill, Odor → `HAZARD`; Water/High Angle Rescue, Extrication, Elevator → `EMERGENCY`; Citizen Assist, Other, Mutual Aid, Administrative → `OTHER`. |
| Fixture | `apps/api/tests/fixtures/public-safety/ca_sf_fire_ems_calls/fire_ems_calls_sample.json` |

### 2.4 `ca_sf_police_incident_reports` — Police Department Incident Reports: 2018 to Present (`wg3w-h783`)

- **Freshness:** "Updated automatically daily by 10:00 Pacific". Observed max `report_datetime` 2026-09-29 06:15, about 20 h behind; max `incident_datetime` 2026-09-28 23:33.
- **Precision:** "All incident locations are mapped to nearby intersections to ensure anonymity." The fields are `intersection`, `cnn`, `latitude/longitude`. Locations before 2024-04-24 use a slightly different intersection set. 56 of 1,834 rows in the last 8 days had no coordinates. Label: `INTERSECTION`.
- **Categories (30 d):** Larceny Theft 1,444, Drug Offense 804, Assault 619, Warrant 606, Other Miscellaneous 582, Malicious Mischief 439, Non-Criminal 393, Burglary 331, Motor Vehicle Theft 269, Lost Property 266, Fraud 262, **Missing Person 250**, Disorderly Conduct 212, Miscellaneous Investigation 175, Suspicious Occ 169, Recovered Vehicle 168, Other Offenses 142, Robbery 117, Traffic Violation Arrest 107, **Offences Against The Family And Children 103**.
- **Resolution values:** Open or Active, Cite or Arrest Adult, Unfounded, Exceptional Adult.
- **IDs:** `row_id` is unique. `incident_id` repeats once per incident code, and supplements are separate rows (`report_type_description`). Records "may be removed … to seal records".
- **Terms:** PDDL; metadata attribution "Police Department".
- **Volume:** about 230 rows (about 170 incidents) per day.
- **Recommendation:** `socrata_soda`, historical daily; `INTERSECTION`.
  - Family `POLICE`. Larceny Theft, Burglary, Motor Vehicle Theft, Malicious Mischief, Stolen Property, Recovered Vehicle → `PROPERTY_INCIDENT`.
  - Suppress Missing Person, family/children offences, sex offences and Non-Criminal.

### 2.5 `ca_sf_fire_incidents` — Fire Incidents (`wr8u-xric`)

- NFIRS-style incident records. Max `alarm_dttm` 2026-09-24, about 6 days behind; 733,061 rows.
- Historical only; lower value than 2.3. Not profiled further.

---

## 3. Los Angeles (Socrata at `data.lacity.org`, plus LAFD)

LA portal terms:
- **No explicit licence.** "Public data sets made available on the Site are provided for informational purposes, and provided for the convenience of the reader. While every effort is made to keep such information accurate and up-to-date, the City does not warranty the completeness, accuracy, content or fitness of any public data set made available on the Site for any particular purpose or use." ([data.lacity.org/terms-of-use](https://data.lacity.org/terms-of-use))
- The LAPD datasets have `license: null`, so **commercial redistribution needs terms confirmation**. The LAFD Response Metrics dataset is CC0.
- CORS `*`; no key.

### 3.1 `ca_la_lapd_calls_for_service` — LAPD Calls for Service 2024 to Present (`xjgu-z4ju`)

- **Endpoint:** `https://data.lacity.org/resource/xjgu-z4ju.json`
- **Fields:** `incident_number` (e.g. `PD26091500002134`), `area_occ`, `rpt_dist`, `dispatch_date`, `dispatch_time` (text), `call_type_code`, `call_type_text`. There is **no location beyond area and district**; the metadata says "Location Specified: No".
- **Freshness:** metadata says "Refresh rate: Weekly" and "Automated?: No". Observed max `dispatch_date` 2026-09-26, about 4 days behind; `rowsUpdatedAt` 2026-09-29.
- **Volume:** 4,113,012 rows since 2024-01-01, about 3,850 per day.
- **Categories (Sept):**
  - Call types: 006 CODE 6 46,330 (officer-initiated), 902 TRAFFIC STOP 7,753, 906B1 CODE 30 RINGER 2,738, 415M 415 MAN 2,142, 904A 904 AMB 1,347, 415G 1,208, 9212 921 TRESPASS SUSP 1,084, 507R 507 RADIO 1,039, 900 UNKNOWN TROUBLE 974, 620D 620 DOM VIOL 862, 507P 507 PARTY 829, 620M 780, 620N 743, 245SN 245 SUSP NOW 683, 907A2 907 AMB O/D 632, 594SN 625, 242SN 621, 242D 242 DOM VIOL 599, 459I 459 INVEST 567, 484SN 539.
  - `area_occ`: 21 LAPD areas plus "Outside" (21,560).
- **Recommendation:** `socrata_soda`, historical weekly; `ZONE` (area and reporting district). Aggregate only; never draw points. Family `POLICE`.
  - Suppress: DV codes (620D, 242D), 907A2 overdose, CODE 6, 902 and 906B1.

### 3.2 `ca_la_lapd_nibrs_offenses` — LAPD NIBRS Offenses Dataset (`k7nn-b2ep`)

- **Endpoint:** `https://data.lacity.org/resource/k7nn-b2ep.json`
- **Freshness:** the description says the NIBRS datasets "are refreshed on a bi-weekly schedule" (from the 2020–2024 dataset notice). Observed `rowsUpdatedAt` 2026-09-29 and max `date_rptd` 2026-09-28T19:52, but daily volume falls from about 620 to under 200 after 2026-09-18. The **effective lag is about 12 days**, with a trickle of newer rows. Max `date_occ` 2026-09-19.
- **Size and coverage:** 489,955 rows. It covers all records entered into the new records system from its 2024-03-07 go-live, "from any date".
- **Precision:** `hndrdth_loc_chk` = "Street address of crime incident rounded to the nearest hundred block to maintain anonymity" (e.g. `5400 W 111th St` or an intersection). `hndrdth_lat` and `hndrdth_lon` have 4 decimals. Label `BLOCK_LEVEL`.
- **Categories:** `nibr_description` (Aug–Sep): Grand Theft Auto 2,182, Vandalism ≥$400 2,086, Simple Battery 1,799, Petty Theft 1,403, Burglary From Motor Vehicle 1,186, Shoplifting 1,158, Grand Theft 1,082, Identity Theft 1,038, IPV w/ Injury 900, Theft from MV >$950 892, ADW 846, Robbery 842, Residential Burglary 777, Intimate Partner Battery 740, Vandalism <$400 734, Criminal Threats 548, Bench Warrant 540.
- **Status and ID:**
  - `crime_against`: Property / Person / Society.
  - `status_desc`: Investigation Continued, Open, City Attorney Review, Cleared by Arrest (CA/DA Filed), District Attorney Review, Cleared Other (DA/CA Reject, Exceptional), Non-Crime/Other, Unfounded.
  - `uniquenibrno` = CaseNo + NIBR code + offence sequence; one case has many rows.
- **Privacy:**
  - Flags `domestic_violence_crime`, `hate_crime`, `gang_related_crime`, `homeless_victim_crime`, `homeless_suspect_crime`, `homeless_arrestee_crime`, `victim_shot`, `totalvictimcount`. Drop all of them.
  - **1,230 rape, sodomy and fondling offences in 2026 all have hundred-block coordinates.** Exclude them.
  - The companion *NIBRS Victims* dataset (`gqf2-vm2j`) is person-level. Do not ingest it.
- **Recommendation:** `socrata_soda`; historical (alarm if the dataset is not refreshed within 16 days); `BLOCK_LEVEL`.
  - Family: `crime_against=Property` → `PROPERTY_INCIDENT`; otherwise `POLICE`.

### 3.3 `ca_la_lapd_crime_2020_2024` — Crime Data from 2020 to 2024 (`2nrs-mtv8`): frozen

- The notice says "the legacy system is no longer active, and no new information will be entered."
- Max `date_rptd` 2025-03-28; 1,004,894 rows. Historical backfill only; `BLOCK_LEVEL` (hundred block).

### 3.4 `ca_la_lafd_alerts_rss` — LAFD Alerts RSS

| Item | Finding |
|---|---|
| Endpoint | `https://lafd.org/alerts-rss.xml`, linked from https://lafd.org/alerts |
| Nature | Curated public-information alerts, not a full CAD feed. It holds the 10 most recent items. `lastBuildDate` was Tue 29 Sep 2026 12:21 −0700, and items from 25–28 Sep were present. |
| Item content | The `title` contains an HTML `<a>` element, e.g. `Grass Fire [Now Out] 09/28/2026 INC#1055`. The `description` is a semicolon-separated string: type; INC#; time; **street address or freeway location** (e.g. `11644 N Herrick Av`, `Wb 118 Fy`); a bit.ly map link; community; narrative; FS; Batt; Bureau; Council District; units; channel; **PIO name**. `category` values include the type (Grass Fire, KNOCKDOWN Structure Fire, …), the bureau (Valley) and the community (Chatsworth). `pubDate` is not RFC-822 (e.g. `Monday, September 28, 2026 - 14:37`). |
| ID | Each update is a new item with a different slug (…`-inc1055` "Grass Fire" vs "Grass Fire [Now Out]"). Correlate updates by `INC#` plus date. |
| Freshness | Near-live when an alert is posted (minutes to hours), but low volume. The response header `cache-control: max-age=2764800, public` (32 days) means a CDN may serve stale content, so revalidate. |
| Terms | No feed-specific terms found (UNVERIFIED). **Needs terms confirmation.** |
| **Recommendation** | • Adapter: `rss` (bespoke parser).<br>• Precision: exact published address, needing geocoding. Because this is a real-estate product, **downgrade to `BLOCK_LEVEL` for display** and never link it to a parcel.<br>• Family: fires → `FIRE`; rescues → `EMERGENCY`; hazmat → `HAZARD`; traffic collisions → `TRAFFIC`; else `OTHER`.<br>• Drop the PIO name. |

### 3.5 `ca_la_lafd_response_metrics` — LAFD Response Metrics, Raw Data (`n44u-wxe4`)

- Quarterly; last `rowsUpdatedAt` 2026-02-10. CC0.
- No location except `first_in_district` (fire station district) and no date field. Incident numbers are randomized "for the purposes of medical patient protection".
- **Not usable for map events.** At most, `ZONE` aggregates.

### 3.6 `ca_la_traffic_collisions` — Traffic Collision Data from 2010 to Present (`d5tf-ez2w`)

- Stalled: max `date_rptd` 2025-03-08. It has not been updated since the records-system transition (the cause is inferred).
- Historical only. `TRAFFIC`.

---

## 4. San Diego (static CSV files at `seshat.datasd.org`)

Terms:
- **Licence:** each dataset page's "View License" links to ODC-PDDL (https://opendefinition.org/licenses/odc-pddl/).
- **Portal terms:** https://data.sandiego.gov/help/guides/terms/ is modelled on SF's but has no re-identification clause: "The City makes no representation or warranty that the information contained in the Data is accurate, true or correct."
- **CORS:** no header was observed on `seshat.datasd.org`.

### 4.1 `ca_sd_police_calls_for_service` — Police Calls for Service

| Item | Finding |
|---|---|
| Endpoint | `https://seshat.datasd.org/police_calls_for_service/pd_calls_for_service_2026_datasd.csv`: one file per year, 2015–2026. Dictionaries: `pd_cfs_calltypes_datasd.csv`, `pd_dispo_codes_datasd.csv`, `pd_cfs_priority_defs_datasd.pdf`. Page: https://data.sandiego.gov/datasets/police-calls-for-service/ |
| Live vs historical | **HISTORICAL**, "Update Frequency: Daily". File `Last-Modified` 2026-09-30T00:02:44Z. The rows are **not sorted**, so one full pass is needed. |
| Observed lag | Max `DATE_TIME` 2026-09-28 23:48:04, about 27 h behind at the time of the check. 361,690 rows for 2026, about 1,200–1,500 per day. |
| Columns | `INCIDENT_NUM, DATE_TIME, DAY_OF_WEEK, ADDRESS_NUMBER_PRIMARY, ADDRESS_DIR_PRIMARY, ADDRESS_ROAD_PRIMARY, ADDRESS_SFX_PRIMARY, ADDRESS_DIR_INTERSECTING, ADDRESS_ROAD_INTERSECTING, ADDRESS_SFX_INTERSECTING, CALL_TYPE, DISPOSITION, BEAT, PRIORITY` |
| Precision | "Street Number of Incident, Abstracted to block level" (e.g. `6600 ALVARADO RD`). Some rows are intersections: 6,229 of 35,355 September rows had an intersecting street, and 6,611 had house number `0`. **No coordinates**, so geocoding is required. BEAT `-1` means unknown (576). |
| Categories | September `CALL_TYPE`, with dictionary text: 415 DISTURBING PEACE 3,084; SELENF SELECTIVE ENFORCEMENT 2,467; CW CHECK THE WELFARE 1,927; T TRAFFIC STOP WITH PLATE 1,860; 459A BURGLARY ALARM 1,315; 1186 SPECIAL DETAIL 1,273; 415V DISTURBING PEACE W/VIOLENCE 911; MPSSTP TRAFFIC STOP FROM THE MOBILE COMPUTER 884; 586 ILLEGAL PARKING 861; 1151 PED STOP/FIELD INTERVIEW 837; **5150 MENTAL CASE 792**; 911 UNK EMERG, HANG UP/OPEN LINE 779; 1183 NO DETAIL ACCIDENT 746; 415N NOISE ONLY 645; 1016 PRISONER IN CUSTODY 590; HZRD HAZARDOUS CONDITION 538; AU2 ALL UNITS INFORMATION 526; FD FLAG DOWN 492; 1021 PHONE YOUR STATION 489; 1185 REQUEST FOR TOW TRUCK 487; 602 TRESPASSING 484; AU23103 RECKLESS DRIVING 466; PARTY LOUD PARTY 461. |
| Status | `DISPOSITION`: K no report required 16,254; O other 4,887; KHR 3,222; CAN 2,860; W no dispatch 2,715; R report 1,915; A arrest 1,242; DEF; U unfounded; DUP. `PRIORITY` 0–4 and 9. |
| ID | `INCIDENT_NUM` (e.g. `E26080043632`). The file is regenerated daily; whether rows are corrected in place is UNVERIFIED. |
| Privacy | 5150 (mental health) and welfare checks with block addresses. The `*HR` dispositions indicate crisis-response-team calls. |
| **Recommendation** | • Adapter: `csv_file` (daily; streamed parse of the current-year file).<br>• Precision: `BLOCK_LEVEL` (`INTERSECTION` when an intersecting street is present), after geocoding.<br>• Family: `POLICE`; 1183 and 1181–1182-style accident codes → `TRAFFIC`; HZRD → `HAZARD`.<br>• Suppress: 5150, CW, 1016, 1021, MTG, INFO, SELENF, T/MPSSTP stops, 1151, and dispositions W, CAN, DUP. |

### 4.2 `ca_sd_fire_ems_incidents` — Fire-Rescue / EMS incidents

- **Endpoint:** `https://seshat.datasd.org/fire_ems_incidents/fd_incidents_2026_datasd.csv`. Daily; `Last-Modified` 2026-09-30T08:00:49Z.
- **Columns:** `agency_type, call_category, address_city, jurisdiction, problem, date_response, address_state, address_zip, day_response, month_response, year_response`. There is **no incident ID and no location finer than ZIP**.
- **Recommendation:** `ZONE` (ZIP) aggregates only. `MEDICAL` for "Life-Threatening Emergency Response" and "Urgent Response"; `FIRE` for "FIRE"; otherwise `OTHER`.

### 4.3 `ca_sd_police_nibrs` — Police NIBRS offences

- **Endpoint:** `https://seshat.datasd.org/police_nibrs/pd_nibrs_2026_datasd.csv`. Quarterly; `Last-Modified` 2026-09-29.
- **Location fields:** `block_addr` (e.g. `4000 Menlo AVE`), `latitude`/`longitude` with `geocode_status`/`geocode_score`, plus `beat` and `neighborhood`.
- **Other fields:** `ibr_category` and `crime_against`.
- **Recommendation:** `csv_file`; historical quarterly; `BLOCK_LEVEL`. Max occurrence date is UNVERIFIED (22 MB file, not downloaded).

San Diego has a real-time fire dispatch page at `webapps.sandiego.gov/sdfiredispatch`, but it is **HTML only**; we did not scrape it.

---

## 5. Sacramento, Oakland, San Jose

### 5.1 `ca_sac_police_calls_for_service` — Sacramento Call for Service Data 2026 (ArcGIS, City of Sacramento)

| Item | Finding |
|---|---|
| Endpoint | `https://services5.arcgis.com/54falWtcpty3V47Z/arcgis/rest/services/Sacramento%20Call%20for%20Service%20Data%202026/FeatureServer/0` (item `85f5d0bd7f37489ea28ceb64affe89d8`). There is one service per year from 2021. The 2021–2025 services use underscores, e.g. `Sacramento_Call_for_Service_Data_2025`. |
| Example query | `…/query?where=Received_Date_PT LIKE '09/14/2026%'&outFields=*&resultRecordCount=1000&f=json` |
| Freshness | The 2025 item says: "It is updated daily to account for updates to existing records and new records." The 2026 layer's `lastEditDate` was 2026-09-29T11:29Z. The **data ends 09/14/2026** (09/12: 1,036 rows, 09/13: 859, 09/14: 925, 09/15: 0), so the lag is **about 15 days**. This looks like a deliberate delay (UNVERIFIED). |
| Fields | `Record_ID, Call_Number (SA2026…), Occurrence_Date_PT, Call_Type, Description, Report_Created, Location, Police_District, Beat, Council_District, Neighborhood_Association, Day_of_Week, Cleared_By, Cleared_By_Desc, Received/Dispatch/Enroute/At_Scene/Clear_Date_PT, OBJECTID, PBID` |
| Timestamps | "Date/Time fields are string data types and will be viewed and downloaded in US/Pacific time." Format is `MM/DD/YYYY HH:MM`, so lexical max only works within one year. |
| Precision | `Location` is block-masked (`79XX ELDER CREEK RD`). Geometry is a block point in State Plane (wkid 102642 / 2226), identical for every call on the block. "Confidential reports and calls for service will also not have location information displayed". 1,513 September rows have a null `Location`. Label `BLOCK_LEVEL`. |
| Categories (Sept) | DISTURBANCE-CLARIFY 1,797; TRAFFIC STOP 1,585; ADVISED ENTRY 1,325; INCOMPLETE CALL FOR POLICE 881; ALL UNITS BROADCAST 866; WELFARE CHECK 755; SUBJECT STOP 481; ERRAND 334; POP ACTIVITY-OFFICER CONTACT 267; REPORT NUMBER ASSIGNMENT 264; SUSPICIOUS SUBJECT/CIRCUMSTANCE-IN PROGRESS 252; SUSPICIOUS VEHICLE-OCCUPIED 242; DISTURBANCE-DOMESTIC VIOLENCE-VERBAL ONLY 238; ALARM ADVISED-FULL RESPONSE 227; MISDEMEANOR ASSAULT-IN PROGRESS 191; DISTURBANCE-FAMILY 187; VEHICLE ACCIDENT-NO OR UNKNOWN INJURIES 172; VEHICLE ACCIDENT-INJURIES 145; CHECK ON HAZARD 127; MEDICAL AID-CLARIFY IN TEXT 112. |
| Status | `Cleared_By_Desc`: POLICE MATTER RESOLVED AT SCENE, CANCEL, AUTOMATICALLY (for advised entries), TRAFFIC CITATION, OTHER/OUTSIDE AGENCY, MISDEMEANOR CITATION. |
| Terms | The 2026 item has **no licence or description**. The 2025 item's `licenseInfo` links to an ArcGIS Experience "Public Safety Open Data page", which is JS-only and was not read. The portal disclaimer is at https://data.cityofsacramento.org/pages/disclaimer. **No explicit licence, so terms need confirmation.** |
| Rate limits | ArcGIS `maxRecordCount` 1000; no key. |
| **Recommendation** | • Adapter: `arcgis_featureserver`, with the year-rolling service name as configuration.<br>• Freshness: historical; alarm if the lag exceeds 21 days.<br>• Precision: `BLOCK_LEVEL`.<br>• Family: `POLICE`; VEHICLE ACCIDENT-* → `TRAFFIC`; CHECK ON HAZARD → `HAZARD`.<br>• Suppress DV, family, welfare and medical types. |

`ca_sac_police_reports` — Sacramento Report Data 2026 (item `760ff58e4d6842f1876c26717b0b5ade`):
- Same host and pattern as 5.1. `lastEditDate` 2026-09-30T11:09Z, but rows end around 09/15, so the lag is about 15 days.
- Fields: `Offense_Category`, `Description` (penal code text), `Location` (`21XX FLORIN RD`), `Case_Status_Desc`.
- September categories: INCIDENT RPT, LARCENY, TRAFFIC, ASSAULT, NARCOTICS, VANDALISM, VEHICLE THEFT, SAC CITY CODE, BURGLARY, **MISSING PERSON** (suppress), AGG ASSAULT.
- `BLOCK_LEVEL`; `POLICE` / `PROPERTY_INCIDENT`.

### 5.2 `ca_oak_crimewatch` — Oakland CrimeWatch Data (`ppgh-7dqv`, Socrata `data.oaklandca.gov`)

- **Endpoint:** `https://data.oaklandca.gov/resource/ppgh-7dqv.json`
- **Fields:** `crimetype, datetime, casenumber, description, policebeat, address, city, state, location`.
- **Precision:** "Be advised that the exact address of each crime has been substituted with the block address to protect the privacy of the victim." For example `3100 61ST AV` or `17TH AV & FOOTHILL BLVD`, each with a point. Label `BLOCK_LEVEL`.
- **Freshness:**
  - `rowsUpdatedAt` 2026-09-29T12:46Z; max `datetime` 2026-09-28 22:00 local, about 29 h behind at the check (about 02:50 PDT on 09-30). Daily counts: 09-27 = 20, 09-26 = 54, 09-20 = 82.
  - The description says: "Please allow up to 90 days from the end of each month for the data to be completely processed."
- **Size:** 1,285,907 rows (the minimum date 1950-01-04 is bad data).
- **Categories (since Aug 1):** STOLEN VEHICLE 779, MISDEMEANOR ASSAULT 575, **DOMESTIC VIOLENCE 497**, FELONY ASSAULT 339, PETTY THEFT 300, ROBBERY 274, VANDALISM 262, NARCOTICS 210, WEAPONS 206, THREATS 195, OTHER 143, BURG - RESIDENTIAL 125, HOMICIDE 120, RECOVERED O/S STOLEN 107, GRAND THEFT 95, DISORDERLY CONDUCT 87, DUI 72, BURG - COMMERCIAL 66, **FORCIBLE RAPE 32, OTHER SEX OFFENSES 46**.
- **IDs:** `casenumber` is not unique (`00-000000` placeholder; offence-level rows).
- **Terms:** licence null; attribution "Oakland Police Department". Needs terms confirmation.
- **Other datasets:** the 90-day map view (`ym6k-rx7a`) is a filtered copy. There is **no current calls-for-service or fire dataset**; the calls-for-service datasets stop in 2015.
- **Recommendation:** `socrata_soda`; historical daily (treat the last 90 days as provisional); `BLOCK_LEVEL`; `POLICE` / `PROPERTY_INCIDENT`. Suppress DV and sex offences.

### 5.3 `ca_sj_police_calls_for_service` — San Jose Police Calls for Service (CKAN `data.sanjoseca.gov`)

| Item | Finding |
|---|---|
| Endpoint | CKAN package `police-calls-for-service`: one resource per year from 2016, plus a quarterly package. 2026 resource `dc0ec99c-0c6b-45fb-b1ec-faf072fe4833`. |
| Download (robots-allowed) | `https://data.sanjoseca.gov/dataset/c5929f1b-7dbe-445e-83ed-35cca0d3ca8b/resource/dc0ec99c-0c6b-45fb-b1ec-faf072fe4833/download/policecalls2026.csv` |
| robots.txt | **Disallows `/api/` and `/datastore/*`.** The CKAN `datastore_search` and `datastore_search_sql` endpoints work technically, but must not be used. The profile in this section came from API queries that predated the robots check (disclosed in §10). |
| Freshness | Resource `last_modified` 2026-09-30T11:00:57Z. Max `OFFENSE_DATE` 2026-09-28 (time 23:55:26), about 28 h behind at the check. **Daily.** 204,900 rows in 2026, about 700 per day. |
| Fields | `CDTS, EID, CALL_NUMBER (P262710884), PRIORITY, REPORT_DATE, OFFENSE_DATE, OFFENSE_TIME, CALLTYPE_CODE, CALL_TYPE, FINAL_DISPO_CODE, FINAL_DISPO, ADDRESS, CITY, STATE, UNHOUSED` |
| Precision | `ADDRESS` is a block range (`[500]-[600] S 10TH ST`) or an intersection (`N 1ST ST & E JULIAN ST`). **No coordinates.** Label `BLOCK_LEVEL`/`INTERSECTION` after geocoding. |
| Categories (Sept) | DISTURBANCE 2,049; VEHICLE STOP 1,795; WELFARE CHECK 1,522; ALARM, AUDIBLE 1,280; PARKING VIOLATION 1,066; TRESPASSING 807; DISTURBANCE, MUSIC 779; SUSPICIOUS PERSON 748; DISTURBANCE, FAMILY 644; SUSPICIOUS VEHICLE 568; SUSPICIOUS CIRCUMSTANCES 551; RECKLESS DRIVING 500; STOLEN VEHICLE 469; VEHICLE ACCIDENT, PROPERTY DAMAGE 362; THEFT 334; MEET THE CITIZEN 333; PEDESTRIAN STOP 321; UNK TYPE 911 CALL 309; TRAFFIC HAZARD 303; MISDEMEANOR HIT AND RUN 262. |
| Status | `FINAL_DISPO`: No report required; dispatch record only 8,973 · Canceled 4,574 · Report taken 3,171 · Gone on Arrival/unable to locate 662 · Arrest Made 499 · No Disposition 398 · Traffic Citation … |
| Privacy | **`UNHOUSED` flag** (T on 9,342 rows in 2026): housing status of a person. Drop it. DISTURBANCE, FAMILY and WELFARE CHECK are sensitive. |
| Terms | Package licence **Creative Commons CCZero** (http://www.opendefinition.org/licenses/cc-zero). |
| CORS / key | No CORS header observed; no key. |
| **Recommendation** | • Adapter: `csv_file`: daily full download of the current-year resource, diffed on `CALL_NUMBER`. Do not use the CKAN API (robots).<br>• Freshness: historical daily; alarm if > 72 h.<br>• Precision: `BLOCK_LEVEL`.<br>• Family: `POLICE`; VEHICLE ACCIDENT / HIT AND RUN / TRAFFIC HAZARD → `TRAFFIC`.<br>• Suppress stops, parking, welfare and family types, and dispatch-only records if desired. |

### 5.4 `ca_sj_fire_incidents` — San Jose Fire Incidents (CKAN)

- 2026 resource `52a69511-adf4-4294-a191-b6bf26ee6b02`, updated 2026-09-29T13:21Z. Data runs to 09/28/2026 11:59 PM (about 1.5 days); 86,221 rows.
- **Fields:** `Incident_No (F262729002), Date_Time_Of_Event, Dispatched_Time, Unit_On_The_Way_Time, Unit_On_Scene_TimeStamp, On_Scene_Unit, Cleared_TimeStamp, Unit_Count, Priority, Final_Incident_Type (FIRE_OTHER, MEDICAL, …), Final_Incident_Category, Street_Name, Station, Battalion`. Times are local text `MM/DD/YYYY hh:mm AM`.
- **Precision:** **street name only** (`S 9TH ST`), plus station and battalion. Label `ZONE`.
- **Licence:** CC0.
- **Recommendation:** `csv_file` via the resource download URL (robots disallows the CKAN `/api/`); `ZONE` aggregates. `MEDICAL` / `FIRE` by `Final_Incident_Type`; else `OTHER`.

---

## 6. Fixtures

Every fixture is real data from an **official, documented, machine-readable, keyless endpoint that robots.txt allows**. Record structure and field names are exactly as returned. Where a source returns an array, a subset was selected by slicing the original text, so the formatting is preserved; any record that needed redaction was re-serialized.

Personal-information values were replaced with `"[redacted]"`, keeping the field. Publisher-anonymised locations (intersection, block, `XX`) were kept as published.

| # | `source_id` / file | Endpoint and query | Fetched (UTC), User-Agent | Records and redactions |
|---|---|---|---|---|
| 1 | `ca_sf_police_realtime_calls/realtime_calls_sample.json` | `https://data.sf.gov/resource/gnap-fj3t.json?$order=received_datetime DESC&$limit=15` | 11:24:48, old UA | 15 as returned: open and closed, sensitive (location suppressed by the publisher) and not. No redaction needed. |
| 2 | `ca_sf_fire_ems_calls/fire_ems_calls_sample.json` | `https://data.sf.gov/resource/nuek-vuh3.json?$order=received_dttm DESC, unit_sequence_in_call_dispatch ASC&$limit=15` | 11:53:34, old UA | 15 unit rows covering 9 calls, to test deduplication on `call_number`. Addresses are publisher-obfuscated intersections. No redaction needed. |
| 3 | `ca_caltrans_lcs/lcsStatusD11_sample.json` | `https://cwwp2.dot.ca.gov/data/d11/lcs/lcsStatusD11.json` | ≈10:38, old UA | 15 of 403 closures, chosen to cover planned, active (1097), ended (1097+1098) and cancelled (1022) closures; Full, Lane, One-Way and Moving types; and Long Term and Intermittent durations. Original tab formatting kept. No PII. |
| 4 | `wa_seattle_fire_realtime_911/realtime_fire_911_calls_sample.json` | `https://data.seattle.gov/resource/kzjm-xkqj.json?$where=datetime > '2026-09-29T17:00:00'&$order=datetime DESC,incident_number DESC&$limit=120` | 12:17:48, new UA | 15 of 120, chosen for type diversity, including a `TEST - MIS TEST` row. **4 medical rows** at house-number addresses have `address`, `latitude`, `longitude` and `report_location` set to `"[redacted]"`. Intersection-address rows are kept. |
| 5 | `oh_cleveland_police_calls_for_service/cad_police_calls_sample.json` | `https://services3.arcgis.com/dty2kHktVXHrqO8i/arcgis/rest/services/CAD_Police/FeatureServer/0/query?where=1=1&outFields=*&orderByFields=IncidentDate DESC&resultRecordCount=15&outSR=4326&f=json` | 12:19:38, new UA | The full ArcGIS response, including `fields` and `exceededTransferLimit`, with 15 features. **3 sensitive calls** (suicide, suspected overdose, family trouble) have `address`, `census_block`, `latitude`, `longitude` and `geometry.x/y` set to `"[redacted]"`. The other addresses are publisher block-masked (`141XX PURITAS AVE`). |
| 6 | `ok_tulsa_fire_dispatch/tfd_dispatch_sample.json` | `https://www.cityoftulsa.org/apps/opendata/tfd_dispatch.jsn`, documented in the city's index `https://www.cityoftulsa.org/apps/opendata/opendatasets.xml` | 12:21:55 (`Last-Modified` 12:05:02), new UA | 15 of 65 incidents, chosen for problem-type diversity. `Vehicles.Vehicle` appears both as an object (6) and as an array (9), an XML-to-JSON artefact the parser must handle. Addresses are publisher hundred-block. No redaction needed. |

**Not kept:** `ca_chp_cad`. The CHP media XML is undocumented, so a fixture built earlier was **deleted** under the request-hygiene rules. The redaction approach, had it been kept, is recorded in §1.1: free-text `IncidentDetail` and SILVER-alert names in `LocationDesc`.

---

## 7. Breadth markets: coverage matrix

Every source below is keyless (no source needed registration). The lags were measured on 2026-09-30 between about 09:50 and 12:25 UTC.

*Cleveland, Seattle, Tulsa, Nashville NFD and Cincinnati `qiik-bpks` were re-verified directly. All other rows are as reported by the delegated breadth passes, which followed the same rules.*

| City | Portal / platform | Best near-live | Best historical | Precision | Cadence / observed lag | Access | Terms verdict |
|---|---|---|---|---|---|---|---|
| **Kansas City, MO** | Socrata `data.kcmo.org` | none | KCPD Crime Data 2026 `f7wj-ckmw` (per-year IDs). Also 911 CFS `4cef-rqti` (monthly; ~56 d; text-only block/intersection). | `BLOCK_LEVEL` (block-snapped points) | weekly; ~2–9 d | socrata_soda | Public Domain, but portal terms require a **mandatory derivative-app disclaimer**. Person fields (race/sex/age) must be dropped. |
| **St. Louis, MO** | City: slmpd.org files only. County: ArcGIS Online. | none usable (SLMPD calls page is HTML only, ~20 min) | County PD NIBRS FeatureServer (daily, ~33 h); County Vehicle Accidents (~23 h) | Native **exact address** → degrade to `BLOCK_LEVEL` | city monthly ~31 d; county daily | csv_file (city) / arcgis_featureserver (county) | **City restrictive:** "Commercial use of the materials is prohibited without the written permission of the SLMPD." County "All rights reserved" / no licence → **needs terms confirmation**. |
| **Indianapolis, IN** | ArcGIS Enterprise `gis.indy.gov` (data.indy.gov Hub) | none | IMPD `CFS_Public` (`IMPD_Public_Data/FeatureServer/0`, ~14 h) and `Incidents_Public` (/1, ~12 h); Crash_Public (/3) | `BLOCK_LEVEL` (block-snapped); crashes `INTERSECTION` | daily; 12–39 h. Epochs are **local time stored as UTC**. | arcgis_featureserver | IMPD layers have **no licence** (IndyGIS default: unrestricted with acknowledgement) → needs terms confirmation. Drop `Userid` and `AptUnit`; exclude Sex-Offender-Registry calls. |
| **Chicago, IL** | Socrata `data.cityofchicago.org` | none (no public CAD dataset) | Crimes `x2n5-8w5q` / `ijzp-q8t2` (7-day embargo by design); Traffic Crashes `85ca-t3if` (~30 h) | Crimes `BLOCK_LEVEL` ("shifted … but falls on the same block"); crashes `EXACT_PUBLIC_POINT` (roadway) | crimes ~9–10 d; crashes daily | socrata_soda | Open with a **mandatory disclaimer**, revocable ("The City may require a user of this data to terminate …"). CPD: "attempts to derive specific addresses are strictly prohibited". |
| **Phoenix, AZ** | CKAN `phoenixopendata.com` + ArcGIS `maps.phoenix.gov` | none (the Traffic Restrictions MapServer is hourly but covers planned work) | Fire CFS (~5–27 h); Police CFS (7-day embargo, ~8 d) | `BLOCK_LEVEL` (text only; geocoder needed) | daily | **csv_file** via resource downloads. robots.txt disallows `/api/` and `/datastore/`, so do not use `ckan_datastore`. | ODC-BY / CC-BY plus portal terms ("non-exclusive, limited and revocable rights"); attribution. |
| **Columbus, OH** | ArcGIS Hub `opendata.columbus.gov` | none | Police Incident Reports (documented "Delay: New reports appear three days after creation") | `BLOCK_LEVEL`; unmapped rows `WITHHELD` | nightly; ~3.3 d | arcgis_featureserver | **CC0**. An off-catalogue service exposes narrative and arrestee-name fields; do not use it. |
| **Cincinnati, OH** | Socrata `data.cincinnati-oh.gov` | `qiik-bpks` is documented at 15 min but was **stale** (`rowsUpdatedAt` 2026-09-29T23:48Z, re-verified) | PDI Police CFS `gexm-h6bt`; Fire/EMS CAD `vnsz-a3wp`; STARS crime `7aqy-xrv9` | `BLOCK_LEVEL` (`XX` addresses; lat/long "randomly skewed … within the same block") | daily; ~26–31 h | socrata_soda | Public Domain; attribution "City of Cincinnati" (`7aqy` has no licence set). |
| **Cleveland, OH** | ArcGIS Hub `data.clevelandohio.gov` | none under 30 min | **CAD_Police** / CAD_Fire (daily); NIBRS `Crime_Incidents_P1RMS` | `BLOCK_LEVEL` ("Locations are adjusted to the nearest road, and full addresses are not provided"). EMS is `AREA` (tract). | daily in the morning; max 04:48:49Z at 12:19Z check ≈ **7.5 h** | arcgis_featureserver | **ODbL**: attribution, plus share-alike if we publicly distribute a derived database. The City "requests" citation. |
| **Philadelphia, PA** | Carto `phl.carto.com` + ArcGIS | none (911 exists only as static hex bins) | Carto `incidents_part1_part2` | `APPROXIMATE_POINT` (points finer than the block label; undocumented). Show at block level. | daily; ~31.5 h | carto_sql | **"The City of Philadelphia reserves all rights in the database"**, no open licence → needs legal/terms confirmation. |
| **Pittsburgh, PA** | CKAN `data.wprdc.org` | none (30-day blotter dead since 2023-11-14) | Monthly Criminal Activity NIBRS (monthly; ~30 d); Allegheny 911 EMS/Fire = block-group quarterly aggregates | `BLOCK_LEVEL`; 911 data `AREA` | monthly / quarterly | **csv_file** via downloads. robots.txt disallows `/api/`; `Crawl-delay: 10`. | NIBRS "License not specified" → confirm. Allegheny 911 is CC0. |
| **Oklahoma City, OK** | ArcGIS Hub `data.okc.gov` (utility.arcgis.com proxy) | Emergency Responses (5-min cadence, but **stuck 15-day-old rows**; ObjectIDs reassigned) | none found (no police incident or CFS dataset) | `APPROXIMATE_POINT` | live rows 15–28 min | arcgis_featureserver | Open Data Policy: "no restrictions on use or reuse". |
| **Tulsa, OK** | Static files `cityoftulsa.org/apps/opendata` | **TFD Dispatch** `tfd_dispatch.jsn`/`.xml` ("Updated Each Minute"; about 24 h rolling; ~65 incidents; subset of all incidents) | none current | `BLOCK_LEVEL` (hundred-block plus coordinates) | `Last-Modified` 3–17 min old at checks | other (static JSON) | **No licence**; site footer "All Rights Reserved" → **needs terms confirmation**. |
| **Charlotte, NC** | ArcGIS Hub `data.charlottenc.gov` + on-prem `gis.charlottenc.gov` MapServer | none (third-party fdmaps.com excluded) | CMPD Incidents (daily, ~2 d); crashes (~7.5 d) | `BLOCK_LEVEL`; crashes `EXACT_PUBLIC_POINT` (a 2026 coordinate defect has positive longitudes) | daily | arcgis_featureserver (MapServer query) | **CC BY 4.0** (attribution). Trap: layers declare an Eastern time reference and `outStatistics` max is returned unconverted. |
| **Raleigh, NC** | ArcGIS Online (data-ral / data.wake.gov) | none | RPD NIBRS `Police_Incidents` (~4 h); Fire incidents (~8.6 h, EMS excluded); crashes (~19.5 h) | `BLOCK_LEVEL` (+`WITHHELD`); fire `EXACT_PUBLIC_POINT` | daily | arcgis_featureserver | **Restrictive-leaning:** the City may "require the termination of any and all displaying"; RPD warns of prosecution under NC GS § 14-117 for misrepresentation → needs terms confirmation. |
| **Nashville, TN** | ArcGIS Hub `data.nashville.gov` (Socrata retired; old SODA URLs redirect) | NFD Active Incidents (live table, **PostalCode only**; re-verified: `lastEditDate` 12:24:16Z, 38 unit rows); MNPD Active Dispatch (~15 min, exact address text, no coordinates, few rows) | MNPD Incidents (~9 h); MNPD CFS (~30 h; lat/long ~36% present) | `ZONE` (NFD); geocoded address shown at block level (MNPD active); `APPROXIMATE_POINT` / `BLOCK_LEVEL` | live 5–15 min; history daily | arcgis_featureserver | No item licence. **Executive Order 018:** "informational purposes only", cite retrieval date and URL, no claim of Metro approval → needs terms confirmation. |
| **Memphis, TN** | ArcGIS Hub `data.memphistn.gov` (Socrata retired) | none | MPD Public Safety Incidents ("sex crimes and juvenile-specific crime types are omitted") | `BLOCK_LEVEL` | daily by 06:00; ~52 h | arcgis_featureserver | No licence ("provided strictly as a courtesy") → needs terms confirmation. |
| **Seattle, WA (reference)** | Socrata `data.seattle.gov` | **Real Time Fire 911 Calls `kzjm-xkqj`**. Documented "Updated every 5 minutes"; observed 8–15 min, re-verified 04:57 PDT newest at 12:12Z. `incident_number` unique and append-once in practice. | SPD Call Data `33kz-ixgy` (daily, ~3.1 d, beat / hundred-block, DV and crisis "REDACTED") | Fire: **exact address** (`EXACT_PUBLIC_POINT`; `INTERSECTION` when the address contains " / "). Medical rows at house numbers must be degraded to `BLOCK_LEVEL`. | 5 min | socrata_soda | **Public Domain**; "does not require specific attribution"; a list of individuals "is not to be used for a commercial purpose" (not applicable here). |

**State DOT incident feeds (breadth).** None of these is keyless for incidents:
- **Need registration:** OHGO, PennDOT 511PA, DriveNC, AZ511, WSDOT Highway Alerts and Bay Area 511.
- **Keyless, but work zones only (WZDx):** MoDOT, INDOT, DriveNC, WSDOT and Maricopa County DOT. These are covered by the WZDx researchers.
- **Needs a registered key for work zones too:** IDOT.
- **Unverified:** TDOT (the docs page is JavaScript-only).

---

## 8. Adapter families: coverage for the fewest adapters

| Adapter family | Cities covered in this file | Implementation notes |
|---|---|---|
| **`socrata_soda`** | San Francisco, Los Angeles, Oakland, Seattle, Chicago, Kansas City, Cincinnati (7) | • Query with SoQL `$select/$where/$order/$limit`.<br>• Freshness from `/api/views/<id>.json` `rowsUpdatedAt` and the `X-SODA2-Truth-Last-Modified` header.<br>• `floating_timestamp` is **local time with no zone**, so a per-source time-zone config is needed.<br>• Unauthenticated requests are throttled per IP ("IP addresses that make too many requests during a given period may be subject to throttling"). An app token is optional and free, but getting one means registering, which we did not do.<br>• Portal domains move: SF now uses `data.sf.gov`, and Nashville and Memphis have left Socrata. |
| **`arcgis_featureserver`** (FeatureServer and MapServer `/query`) | Sacramento, Cleveland, Columbus, Indianapolis, Charlotte, Raleigh, Nashville, Memphis, OKC, St. Louis County, Phoenix (restrictions) (11) | • Page with `resultOffset`/`resultRecordCount` (`maxRecordCount` 1000–2000). Request `outSR=4326`.<br>• Read freshness from `editingInfo.lastEditDate` plus `orderByFields=<date> DESC` samples. Do not trust `outStatistics` max (the Charlotte trap).<br>• **Per-layer time semantics:** true UTC (Cleveland, Nashville, Memphis, Raleigh NIBRS) vs local time stored as UTC (Indianapolis, Raleigh Fire and Crashes, likely Columbus). Sacramento stores times as **strings**.<br>• Nightly full reloads reassign `OBJECTID` (Cleveland, Columbus, Indianapolis, OKC), so key on the business ID. |
| **`static_file`** (CSV / JSON / XML over HTTPS, including CKAN resource downloads) | San Diego (seshat CSV), San Jose, data.ca.gov CCRS, Phoenix, Pittsburgh (CKAN downloads, **because robots.txt disallows the CKAN `/api/`**), Caltrans LCS (JSON), Tulsa (JSON), St. Louis City CSV (blocked by terms) | • Conditional GET using `If-Modified-Since`/ETag.<br>• Streamed parse, and diff on the business ID.<br>• Some files are unsorted (San Diego).<br>• Geocoding is required where there are no coordinates: San Diego, San Jose, Phoenix, KC 911. |
| `carto_sql` | Philadelphia (1) | Carto SQL API; rate-limit headers are exposed. Terms are the blocker. |
| Bespoke | CHP XML (terms pending), LAFD RSS (terms pending) | Low priority until terms are confirmed. |

**Two families, `socrata_soda` (7) and `arcgis_featureserver` (10, counting Phoenix under `static_file`), cover 17 of the 24 jurisdictions profiled (23 cities plus California statewide).** Adding `static_file` covers 23 of 24; only Philadelphia (Carto) is left.

Every family needs the same post-processing:
- Map each source's time zone.
- Apply the shared deny-list (§0.3).
- Use the precision label from the source, and **never upgrade it**; the only change allowed is a downgrade.
- Drop person fields: race/sex/age, names, `UNHOUSED`, apartment/unit, officer or employee IDs, free-text notes.
- Honour per-source attribution text.

---

## 9. Ranked shortlist

### Best near-live (documented, keyless)

| Rank | Source | Freshness | Blocker |
|---|---|---|---|
| 1 | **SF police real-time** `gnap-fj3t` | 20–25 min | None legal (PDDL). Honour the re-identification clause; throttling without an app token. |
| 2 | **Seattle Fire 911** `kzjm-xkqj` | 8–15 min | None legal (Public Domain). We must degrade exact medical addresses ourselves. Outside the target markets (reference only). |
| 3 | **Caltrans LCS** | 5 min | None (public domain). Covers planned and active closures, not incidents; files are large. |
| 4 | **Tulsa TFD dispatch** | 1-min documented; 3–17 min observed | **No licence / "All Rights Reserved"** → needs terms confirmation. Only a subset of incidents is published. |
| 5 | **CHP CAD media XML** | < 1 min | **Undocumented** endpoint → needs written CHP confirmation. Free-text PII; comm-centre pseudo-locations. |
| 6 | **Nashville NFD / MNPD active** | ~9 min | ZIP-only or no coordinates, tiny volume, EO 018 terms. |
| 7 | **OKC Emergency Responses** | live rows 15–28 min | Stuck stale rows and unstable IDs; terms are open. |
| 8 | **LAFD alerts RSS** | minutes to hours | Curated and low volume; non-standard format; terms unconfirmed. |

Cincinnati `qiik-bpks` is documented at 15 minutes but was stale; re-probe it during US business hours.

### Best historical (documented, keyless)

| Rank | Source | Freshness / precision | Blocker |
|---|---|---|---|
| 1 | **Cleveland CAD Police/Fire + NIBRS** | ~7 h, block-level points | ODbL share-alike on derived databases. |
| 2 | **SF Fire/EMS + Incident Reports + Closed Calls** | daily, intersection level | None beyond the re-identification clause. |
| 3 | **Indianapolis IMPD CFS/Incidents** | ~12–14 h, block level | IMPD layers carry no licence. |
| 4 | **Raleigh NIBRS** | ~4 h | Restrictive disclaimers. |
| 5 | **Cincinnati PDI CFS / Fire CAD** | ~31 h; public domain; skewed block points | None noted. |
| 6 | **Nashville MNPD Incidents** | ~9 h | EO 018 terms; drop the victim demographic fields. |
| 7 | **Charlotte CMPD Incidents** | ~2 d | None: CC BY 4.0, attribution required. |
| 8 | **San Jose CFS** | ~28 h; no coordinates | None: CC0; CSV download only. |
| 9 | **San Diego CFS** | ~27 h; no coordinates | None: PDDL. |
| 10 | **Chicago Crashes / Crimes** | 30 h / 9–10 d | Mandatory disclaimer; revocable. |
| 11 | **LAPD NIBRS** | ~12 d, block level | No licence. |
| 12 | **Phoenix Fire/Police CFS** | 5–27 h / ~8 d; no coordinates | ODC-BY; CSV download only. |

Lower priority:
- **KC:** weekly, with a mandatory disclaimer.
- **Columbus:** 3-day delay, CC0.
- **Memphis:** ~52 h, no licence.
- **Oakland:** ~29 h, no licence.
- **Sacramento:** ~15 d, no licence.
- **Philadelphia:** "reserves all rights".
- **Pittsburgh:** monthly.
- **St. Louis:** restrictive or all rights reserved.

---

## 10. Request hygiene and compliance disclosures

**robots.txt audit.** The audit was run after the coordinator's rules arrived, against every host contacted; the violations were:

| Host | robots.txt rule | Our request(s) | Status |
|---|---|---|---|
| `incidents.fire.ca.gov` | `User-Agent: *` `Disallow: /` | 1 GET of `/umbraco/api/IncidentApi/List` | **Violation** (predates check). Source marked do-not-poll. No fixture. |
| `api.511.org` | `User-agent: *` `Disallow: /` | 1 GET of `/traffic/events` (returned 401) | **Violation** (predates check). |
| `data.sanjoseca.gov` | `Disallow: /api/`, `/datastore/*` | About 8 CKAN API calls (`package_search`, `package_show`, `datastore_search`, `datastore_search_sql`) | **Violation** (predates check). Recommendation changed to CSV downloads. No fixture. |
| `data.ca.gov` | `Disallow: /api/`, `/datastore/*` | About 5 CKAN API calls (`package_search`, `package_show`, `datastore_search`, `datastore_search_sql`) | **Violation** (predates check). Recommendation changed to CSV downloads. |
| `www.phoenixopendata.com` | `Disallow: /api/`, `/datastore/*` | CKAN API calls by the breadth pass | **Violation** (predates check). Recommendation is CSV downloads. |
| `data.wprdc.org` | `Disallow: /api/`; `Crawl-delay: 10` | CKAN API calls by the breadth pass | **Violation** (predates check). Recommendation is CSV downloads. |

All other hosts either allowed every path we fetched, had no robots.txt (4xx), or returned an unusable robots response:
- **`cwwp2.dot.ca.gov`:** returns HTTP **500 for every missing path, including `/robots.txt`**. Its documentation invites integration ("These files are available for integration into your application").
- **`www.fire.ca.gov`:** 403 behind Akamai.
- **`utility.arcgis.com`, `quickmap.dot.ca.gov`, `www.cityoftulsa.org`:** return a 301 or an HTML page instead of a robots file.

**Other disclosures:**
- **User-Agent:** requests before about 12:13 UTC used a different User-Agent (above; no personal information). Fixtures 1–3 were fetched with it. WebFetch documentation lookups (DataSF explainer, DataSF/LA terms, Socrata docs) carry the tool's own User-Agent, which we could not set.
- **Undocumented endpoints:** the CHP media XML fixture was created from an undocumented endpoint and then **deleted**. The Caltrans QuickMap KMLs were only HEAD-requested, and nothing was saved.
- **Scratch files:** temporary parsing files were written under `/tmp` (outside the repo) and deleted at the end. The breadth passes reported brief `/tmp` scratch files, which they deleted. They also reported one harness-cached PDF (Tulsa data-governance PDF) in the session's tool-results directory. No repository files outside `docs/public-safety/discovery/ca-breadth.md` and the fixture directories in §6 were touched.

---

## 11. Unverified or open items

**Terms and endpoint status**
- CHP `sa.xml`: whether its use is sanctioned, and the cadence (not documented).
- The LAFD RSS feed's terms.
- The Sacramento licence, via the Public Safety Open Data page (JS-only).
- Tulsa's data-governance policy (a scanned PDF).
- Whether IMPD, St. Louis County, Nashville and Memphis layers carry licences.
- Philadelphia's formal terms page (JS-only).
- The Phoenix Traffic Restrictions "hourly" claim.
- Whether Cincinnati `qiik-bpks` resumes near-live updates.

**Data behaviour**
- Whether San Diego CFS rows are corrected in place.
- The San Diego NIBRS max date (the file was not downloaded).
- Whether the Sacramento ~15-day delay is intentional.
- Whether CHP ever publishes the centres that were absent from our snapshot (e.g. Redding, Ventura).
- Whether Seattle rows are updated in place after 72 minutes, and why Seattle incident numbers have gaps.
- The Charlotte crash-coordinate defect hypothesis.
- The Nashville 10-code and NFD type lookups, and whether Nashville excludes sex offences.
- The IMPD filtering of domestic and sexual-assault calls.
- Whether KC 911 still includes pre-2026 data.
- Statewide LCS closure volume.
