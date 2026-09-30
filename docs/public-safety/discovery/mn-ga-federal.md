# Public Safety Network: source discovery for Minnesota, Georgia, and federal/national feeds

Researched 2026-09-30, 09:40–12:30 UTC (04:40–07:30 CDT / 05:40–08:30 EDT). This is research only: no application code was written. Fixtures are listed in [section 6](#6-fixtures).

Scope:
- **Minnesota (deep, Minneapolis first):**
  - Minneapolis 911 calls, police incidents and fire.
  - St. Paul, including Ramsey County dispatch.
  - Hennepin County.
  - MnDOT, IRIS and 511MN.
- **Georgia:** Atlanta police open data, Atlanta Fire Rescue and GA511.
- **Federal / national:**
  - NWS active alerts.
  - USGS earthquakes.
  - NIFC/WFIGS wildfire points and perimeters.
  - National road-closure feeds.

Method:
- **User-Agent:**
  - Until the coordinator's hygiene note: `LeadCommand-Discovery (ops.leadcommand.ai)`, the string in the task brief.
  - After the note: `LeadCommand-Discovery (+https://ops.leadcommand.ai)`.
  - No personal data was ever sent in a header, query or body.
- **Requests made:** metadata requests, aggregate queries (`outStatistics`, `groupByFieldsForStatistics`, SoQL `$group`), small samples (≤ 16 rows per query) and HEAD requests.
- **Three larger id-only pulls:**
  - Minneapolis 911: 5,794 rows of `Master_Incident_Number`/`Agency_Type`/`OBJECTID`, no geometry, to test id uniqueness.
  - St. Paul: 1,000 rows of `CASE_NUMBER`/`INCIDENT_TYPE`, for the same test.
  - WFIGS perimeters: 129 geometries with `OBJECTID` only, to pick the smallest polygons for the fixture.
- **No bulk crawls.** The only full snapshots downloaded were the files a live adapter would poll anyway: IRIS `incident.xml.gz` three times (≤ 1 KB each), MN WZDx twice (1.2 MB), NWS `/alerts/active` twice (1.1 MB) and USGS `all_day` once (0.2 MB).
- **No access circumvention.** We did not register, did not use a key or token, and did not bypass auth, CAPTCHA or bot protection. The FHWA page returned an Akamai 403; it was not retried. We did not scrape HTML for incident data.
- **"Observed lag"** means `max(event timestamp)` compared with the time of the check.

Vocabulary, shared with `ca-breadth.md`:
- **Location precision label:** `EXACT_PUBLIC_POINT`, `APPROXIMATE_POINT`, `BLOCK_LEVEL`, `INTERSECTION`, `AREA`, `ZONE`, `WITHHELD`.
- **Canonical family:** `POLICE`, `FIRE`, `MEDICAL`, `TRAFFIC`, `HAZARD`, `EMERGENCY`, `PROPERTY_INCIDENT`, `OTHER`. `OTHER` means "not mapped", not a guess.
- **`drop`** means the row must never be stored or shown. This is the shared sensitive deny-list: domestic, sex offences, juvenile, mental-health/crisis, welfare checks, missing persons, overdose, suicide/jumper, "slumper"/person-down, and victim-count rows.

---

## 0. Ranked recommendation (summary)

| # | source_id | What | Live? | Real cadence (documented / observed) | Precision label | Blocker to enabling |
|---|---|---|---|---|---|---|
| 1 | `us_nws_alerts` | NWS watches, warnings and advisories | **LIVE** | Poll ≥ 30 s (documented). Collection `updated` was ~50 s old. | `AREA` (polygon) / `ZONE` | None. Public domain; User-Agent required. See the robots.txt note in §7. |
| 2 | `mn_mndot_iris_incidents` | MnDOT RTMC freeway incidents: crash, stall, hazard, roadwork | **LIVE** | 30 s (documented). File was 25–27 s old at fetch. | `EXACT_PUBLIC_POINT` | **Terms**: no feed-specific licence. Only MnDOT's generic "as is" disclaimer applies. Confirm with RTMC. |
| 3 | `mn_mndot_wzdx` | MnDOT WZDx: work zones, closures and detours | **LIVE** | 60 s (documented in the feed). `update_date` was 16 s old. | `EXACT_PUBLIC_POINT` (line) | None (CC0 declared in the feed). One 504 was seen, so retry with backoff. |
| 4 | `us_usgs_earthquakes` | USGS earthquakes (GeoJSON summary) | **LIVE** | 1 min (documented) | `EXACT_PUBLIC_POINT` (epicentre) | None (public domain) |
| 5 | `us_nifc_wfigs_incidents` / `_perimeters` | Wildfire points and perimeters | **LIVE** | 5 min IRWIN sync; hourly fall-off (documented) | `APPROXIMATE_POINT` / `AREA` | None. The NIFC disclaimer applies; no licence is stated. |
| 6 | `ga_atlanta_police_crime` | APD NIBRS crime reports | **NEAR-LIVE** (hourly) | Hourly (documented). Observed: layer edited 10:43Z and 11:45Z; newest `ReportDate` 09:56Z. | Source publishes exact points; **we must degrade to `BLOCK_LEVEL`** | **Privacy**: exact residential addresses and a family-violence flag, so suppression and generalisation are mandatory. **Terms**: "no cost" statement only, no licence. |
| 7 | `mn_minneapolis_911_incidents` | Minneapolis 911 incidents (police, fire, BCR) | **HISTORICAL** (D+1) | Daily (documented). Observed: last refresh Sun 2026-09-27 14:10Z; newest call 2026-09-27 05:28 local. **~3.2 days stale** at check time. | `BLOCK_LEVEL` | None for terms (CC0). Freshness is unreliable. |
| 8 | `mn_minneapolis_crime_data` | Minneapolis NIBRS offences, shots-fired calls | **HISTORICAL** | Daily by 9:30 AM CT (documented). Same stale refresh as #7. | `BLOCK_LEVEL` | Licence is blank on the item; CC0 appears on sibling items, so confirm. |
| 9 | `mn_stpaul_crime_incidents` | St. Paul PD incidents (crime and proactive visits) | **HISTORICAL** (twice daily) | "Added twice daily" (documented). Edited 05:31Z; newest `DATE` 05:01Z. | `BLOCK_LEVEL` (string only, no coordinates) | Needs a block geocoder. Redistribution must carry the city disclaimer. |
| 10 | `mn_511_events_iowadot_mirror` | MN 511 events (crashes, closures, restrictions) via Iowa DOT | **LIVE** (10 min) | 10 min (documented). Observed: edits at 10:41Z and 12:11Z. | `EXACT_PUBLIC_POINT` (start point) | **Terms**: CC BY 4.0, but described as "a courtesy … for use by Iowa DOT web mapping applications". Confirm with MnDOT / Iowa DOT. |
| 11 | GA511 API | Georgia DOT traffic events | **LIVE** | Unknown until keyed | `EXACT_PUBLIC_POINT` + polyline | **Key**: free developer key requires account registration (not done). The GEMA mirror (`ga_511_events_gema_mirror`, 15 min) has **unconfirmed redistribution terms**. |
| 12 | `mn_ramsey_ecc_incidents` | Ramsey County 911 dispatch (St. Paul police and fire, suburbs) | **HISTORICAL** (monthly) | Monthly (documented). Data through 2026-08-31, published 2026-09-01. | `AREA` (city centroid) | No licence stated. |
| 13 | `mn_minneapolis_mfd_fires` / `_calls_for_service` | Minneapolis Fire NFIRS incidents | **HISTORICAL** | Nightly publish (03:01Z), but content ends **2026-06-06** (~116-day lag) | `EXACT_PUBLIC_POINT` (address) | **Privacy**: exact address plus apartment for EMS calls. Drop or aggregate MEDICAL. |
| — | `us_dot_wzdx_feed_registry` | National directory of WZDx work-zone feeds | Registry | Updated 2026-09-10 | n/a | None. This is discovery metadata, not events. |

**Best Minneapolis near-live source.** No official machine-readable near-live 911 or police feed exists for Minneapolis.
- The city's "911 and Emergency Communications Center Incidents Dashboard" says it "refreshes approximately every half hour" and covers "the past 12 hours". It is a **Tableau view, not a feed**, so we did not use it.
- The best Minneapolis public-safety feed is **`Incidents_Reported_911`**: daily, `BLOCK_LEVEL`, CC0. It was stale by ~3.2 days when checked.
- The best **near-live** feed covering Minneapolis is **MnDOT IRIS `incident.xml.gz`**: a 30 s cadence with exact freeway points. It covers metro freeways, plus a few trunk highways outstate (T.H.52 at Rochester appeared).

---

## 1. Findings that change the design

1. **Timezone semantics differ per source, and Minneapolis is a trap.**
   - Minneapolis `Response_Date`, `Reported_Date` and `reportedDateTime` are stored as **local America/Chicago wall-clock encoded as a UTC epoch**. The layer declares `dateFieldsTimeReference: UTC`, and the item text says "shown in UTC".
   - Evidence:
     - In 30 days of 911 calls, the hour histogram minimum is at hours 4–6 and the maximum at 15–19.
     - Shots-fired calls peak at 21–02.
     - `Police_Incidents_2026.reportedTime = 1049` pairs with `reportedDateTime = …10:49:00Z`.
   - **Fix**: take the epoch's UTC wall-clock fields and re-interpret them as `America/Chicago`.
   - St. Paul and Atlanta store **true UTC**. Their histogram minima are at 07–10Z and 08–12Z, and both portals document the UTC-on-export behaviour.
   - Ramsey County (Socrata) uses **floating local** timestamps.
   - IRIS uses Java `Date.toString()` strings with `CDT`/`CST`.
   - The MN 511 mirror uses local strings with no zone. GA511 uses Unix **seconds**, NWS uses ISO-8601 with offsets, and USGS uses epoch **ms** UTC.
2. **IDs are not stable in several places.**
   - Minneapolis layers are truncate-and-reloaded, so `OBJECTID` is not an identity. Use `Master_Incident_Number` (911), `Case_Number` (crime), `caseNumber` (incidents) and `incident_number` (MFD).
   - IRIS assigns a **new `name` on edit** and links it via `replaces='<old name>'`, so the adapter must follow the chain.
   - NWS updates carry **new ids** and list superseded ids in `references`.
   - Atlanta publishes **one row per offence** (`ReportNumber` `-1`, `-2`, all sharing `IncidentNumber`).
   - The USGS `id` is the preferred id; `ids` lists every associated id.
3. **Most Minnesota publishers pre-generalise location; Atlanta and Minneapolis Fire do not.**
   - Minneapolis 911 uses a block centre, or a census block-group centroid for sensitive calls, with no flag saying which.
   - Minneapolis crime uses hundred-block plus "anonymized" coordinates.
   - St. Paul publishes a hundred-block string only. Ramsey publishes the city centroid only.
   - Atlanta publishes **exact street addresses and rooftop coordinates**. That includes `RESIDENCE_HOME`/`APARTMENT` rows (1,503 of 4,217 rows in September) and `GAFamilyViolenceIndicator = YES` (317).
   - Minneapolis Fire publishes **street number plus apartment number** for EMS calls.
   - The adapter must degrade these and apply the deny-list. It must never upgrade precision.
4. **⚠ Atlanta PD ArcGIS org has a public layer that looks like an internal CAD export. DO NOT USE.**
   - The layer is `services3.arcgis.com/Et5Qfajgiyosiw4d/arcgis/rest/services/OnlineCADData/FeatureServer/0` (item `a33a09c7230945238bd834a91845118f`).
   - It is `access: public`, created 2026-07-28, not linked from the APD open data site, and owned by an individual staff account.
   - Its schema contains `CallerName`, `CallerPhone`, `PrimaryOfficerName1`, `AllComments` (free text) and `Apartment`.
   - We read **only metadata**: service root, item and layer schema. Zero records requested, no fixture saved.
   - It is not a documented open dataset; it appears to be an unintended exposure. We recommend LeadCommand **never ingest it** and consider a responsible-disclosure note to APD (apdwebmaster@atlantaga.gov is the contact the portal lists).
5. **No single official national incident or road-closure feed exists.**
   - The closest is the **USDOT WZDx Feed Registry**: a public-domain Socrata dataset listing each state's work-zone feed, with a `needapikey` flag.
   - Minnesota's feed is keyless and CC0. **Georgia is not in the registry.**
   - FHWA's "National Traffic and Road Closure Information" is an HTML link list, now at `highways.dot.gov/traffic-info`. It returned an Akamai 403 to us, which was not retried.
6. **Keys and terms blockers.**
   - GA511 needs a developer key (free registration).
   - Direct 511MN/CARS-Hub feeds need a developer agreement.
   - These have no explicit licence: MnDOT IRIS XML, Ramsey County, the Atlanta PD portal, Minneapolis `Crime_Data` and the MFD items. Their terms need confirmation before commercial redistribution.

---

## 2. Minnesota

### 2.1 `mn_minneapolis_911_incidents`: Minneapolis "Incidents Reported 911"

| Item | Finding |
|---|---|
| Provider / owner / jurisdiction | City of Minneapolis, Minneapolis Emergency Communications Center (MECC). Covers the city of Minneapolis. ArcGIS Online item `c0ee6f12407044a09d8d48b2c7da3ada`, owner `City_of_Minneapolis`. |
| Access | ArcGIS FeatureServer (hosted) with the query API. Also downloadable from the Hub. |
| Endpoint | `https://services.arcgis.com/afSMGVsC7QlRK1kZ/arcgis/rest/services/Incidents_Reported_911/FeatureServer/0` |
| Example query | `…/0/query?where=Response_Date >= TIMESTAMP '2026-09-26 00:00:00'&outFields=*&orderByFields=Response_Date DESC&resultRecordCount=100&outSR=4326&f=json` (URL-encode the values) |
| Paging | `maxRecordCount` 16000, `supportsPagination` true. Use `resultOffset`/`resultRecordCount`. `OBJECTID` is not stable across reloads, so page within one `editingInfo.dataLastEditDate` value. |
| Live / historical | **HISTORICAL**, rolling 6 years (min `Response_Date` 2020-09-27; 1,650,159 rows). |
| Cadence | Documented: "The data set is refreshed daily by ." (sic, the time is missing). Observed: `dataLastEditDate` 2026-09-27T14:10:18Z (a Sunday); still unchanged at 2026-09-30T12:16Z. The newest call was 2026-09-27 05:28 local, so the lag was **~3.2 days** at check time. The Mon and Tue refreshes did not happen. |
| Coordinates | `Latitude`/`Longitude` attributes and point geometry in NAD83 (wkid 4269), 5 decimals. The item says: "Location is anonymized to the nearest street centerline for most cases and anonymized to the nearest Census block group centerline for cases that require a higher level of privacy protection." The city dashboard notes say block-group anonymisation applies to calls that "relate to any of the following: Certain medical conditions Involve juveniles Domestic in nature We show all other calls on the center of the city block". No flag distinguishes the two. `0,0` appears for missing locations (21 of 26,008 in 30 days). |
| Category fields | `Agency_Type`: `POLICE` 19,770; `FIRE` 5,423; `BCR` 815 (Behavioral Crisis Response). Counts are for 30 days.<br>`Problem__Final_` has 199 distinct values; the final code differs from `Initial_Problem` (436 distinct) when reclassified. Initial codes sometimes carry a `~PD`/`~FIRE` suffix.<br>Top values: Unknown Wireless/Cell Phone(P), Unwanted Person (P), Disturbance (P), Check the Welfare (P), Receive Information (P), Shortness of Breath (FE), Suspicious Person (P), Domestic (P), Audible Business Alarm (P), Behavioral Crisis Welfare Ck, Down Outside-One (PE), Unknown Trouble (P), Heart (FE), Unconscious (FE), Person In Crisis (P), Narcotics (Drug) Activity (P), Suspicious Vehicle (P), Domestic Abuse-In Progress (P), Theft (P), Assault in Progress (P), Property Damage Accident (P), Personal Injury Accident (FE), F Alarm-Residential-Multi (F), Sound of Shots Fired (P), Outside Fire (F).<br>`Initial_Priority`/`Final_Priority`: 0–4.<br>`Division`/`Jurisdiction`: precincts, and MFD with the ambulance provider, e.g. `Minneapolis Fire (MPD-HCMC)`. |
| Status | No status field. `Call_Disposition` has 31 values: null 7,633 (mostly FIRE/BCR), RPT-Report, ADV-Advised, AOK- All OK, AST-Assist, GOA-Gone on Arrival, CNL-Cancel, UTL-Unable to Locate, AQT-All Quiet, SNT-Sent, INF-Information, NOS-No Service, UNF-Unfounded, INS-Inservice, TRN-Transport, BKG-Booking, FAL-False, RFD-Refused, SEC- Secured, TAG-Tagged, TOW-Towed, … |
| Timestamps | `Response_Date` only (call created). It is **local wall-clock mislabelled UTC** (see §1.1). There is no updated or closed time. |
| ID | `Master_Incident_Number`, unique per row (0 duplicates in 5,794 rows over 7 days). Police ids look like `26-280179`; fire ids like `26-0047944`. It is reused across refreshes; problem and disposition are final values. |
| Privacy | No names, phones or narratives. Location is already generalised. Sensitive categories (domestic, crisis, welfare, medical) are present **as categories**. |
| Terms | "To the extent possible under law, City of Minneapolis has waived all copyright and related or neighboring rights to Open Data." (CC0, item `licenseInfo`). Disclaimer: "The City of Minneapolis does not warrant or guarantee that the Geographic Information Systems (GIS) data or maps are complete, current, or accurate." |
| Attribution | None required (CC0). Suggest "Source: City of Minneapolis Open Data". |
| Rate limit / key / CORS | No key. No published rate limit (ArcGIS Online). `Access-Control-Allow-Origin: *`; `Cache-Control: max-age=30`. |
| Volume | ~750–940 rows/day (Sep 10–26: 742–939/day). |
| **Recommendation** | Adapter `arcgis_feature_query`. **HISTORICAL** "recent calls" layer.<br>Freshness: fresh if `dataLastEditDate` is within **48 h** (2× daily). Otherwise label it "stale since …" (it would be stale today).<br>Precision `BLOCK_LEVEL`; `0,0` becomes `WITHHELD`.<br>Mapping: `Agency_Type=BCR` → **drop**. Deny-list problems (Domestic*, Person In Crisis, Check the Welfare, Missing Person, Overdose*, Slumper, Down Outside*, Luring, anything juvenile/CSC) → **drop**. `*Accident*`, `Hit & Run`, `Hotrodders` → TRAFFIC. FIRE + medical codes (Shortness of Breath, Heart, Unconscious, Fall, Seizure, Stroke, Severe Bleeding, Assist a Disabled Person, Assist EMS Crew) → MEDICAL, shown **aggregated to `AREA` only**. FIRE + `F Alarm*`/`Outside Fire`/`Smoke*`/`Fire in*`/`Explosion*` → FIRE. FIRE + `Haz Mat*`/`Gasoline Leak*`/`Odor*`/`CO Alarm*` → HAZARD. Remaining `POLICE` → POLICE. Everything else → OTHER. |

### 2.2 `mn_minneapolis_crime_data`: Minneapolis "Crime_Data" (NIBRS plus shots fired)

| Item | Finding |
|---|---|
| Provider / owner | City of Minneapolis / MPD. PIMS records system; CAD for shots-fired calls. Item `dfbae39fd25d45838a649d0fc27be4fb`. |
| Endpoint / example | `https://services.arcgis.com/afSMGVsC7QlRK1kZ/arcgis/rest/services/Crime_Data/FeatureServer/0/query?where=Reported_Date >= TIMESTAMP '2026-09-20 00:00:00'&outFields=*&orderByFields=Reported_Date DESC&f=json`. `maxRecordCount` 16000, paginated. Geometry is Web Mercator (102100), so request `outSR=4326`. |
| Live / historical | **HISTORICAL** from 2019-01-01 (392,959 rows). Documented: "The data set is refreshed on a daily basis by 9:30 AM." Observed: edited 2026-09-27T13:52Z; newest `Reported_Date` 2026-09-26 23:48 local. **Stale ~3 days** at check time. |
| Coordinates | Field docs ("Crime Dashboard Document", PDF item `30ffb1f74c104066afc1d71d65b6b73a`): "Address … Anonymized address based on the address listed in PIMS" and "Latitude Decimal Anonymized latitude". `Address` is hundred-block, e.g. `0016XX HILLSIDE AVE N`, or an intersection `8TH ST SE / 9TH AVE SE`. `wgsXAnon`/`wgsYAnon` equal `Latitude`/`Longitude` to within 0.3 m. |
| Categories | `Type`: Crime Offenses (NIBRS) 3,824; Shots Fired Calls 341; Additional Crime Metrics 97; Gunshot Wound Victims 19 (30 days).<br>`NIBRS_Crime_Against`: `Property `, `Person `, `Society `, `Non NIBRS Data`. Note the trailing spaces.<br>`Offense_Category` (23): Larceny/Theft Offenses, Destruction/Damage/Vandalism of Property, Assault Offenses, Shots Fired Calls, Motor Vehicle Theft, Burglary/Breaking & Entering, Fraud Offenses, Drug/Narcotic Offenses, Subset of NIBRS Assault Offenses, Robbery, Weapon Law Violations, Sex Offenses, Stolen Property Offenses, Gunshot Wound Victims, Counterfeiting/Forgery, Kidnapping/Abduction, Homicide Offenses, Arson, …<br>Additional Crime Metrics has only two offences: "Domestic Aggravated Assault - Subset of Assault" and "Carjacking - Subset of Robbery".<br>`DID` (Yes/No/null) is **undocumented**. |
| Status / timestamps | No status. `Reported_Date` is when the case was entered in PIMS; `Occurred_Date` is when the incident is believed to have occurred. Both are **local wall-clock mislabelled UTC**. |
| ID | `Case_Number` (e.g. `26-279923`), plus `Case_NumberAlt` (`MP2026…`). Rows are per offence or victim, so one case can have multiple rows. |
| Privacy | No names. "Gunshot Wound Victims" and "Domestic Aggravated Assault" are victim- or domestic-centric rows at hundred-block level. |
| Terms | The item `licenseInfo` is **blank**. The sibling items (`Incidents_Reported_911`, `Police_Incidents_2026`, `Shots_Fired`) carry the CC0 statement quoted in §2.1. **Confirm** that the same applies. |
| Volume | ~140 rows/day. Alternate layer: `Shots_Fired` (item `f9ae3bef2ccd4792b1835e2744de017f`, CC0, 2007→present, 108,912 rows) covers the same shots-fired calls. |
| **Recommendation** | `arcgis_feature_query`, **HISTORICAL**, freshness 48 h, `BLOCK_LEVEL`; intersection addresses become `INTERSECTION`.<br>Mapping: NIBRS rows → POLICE, except Sex Offenses, Pornography/Obscene Material and Kidnapping → **drop**. Additional Crime Metrics: Domestic → **drop**; Carjacking → POLICE. Gunshot Wound Victims → **drop** (victim record). Shots Fired Calls → POLICE. Arson → POLICE (crime record; not guessed as FIRE). |

### 2.3 `mn_minneapolis_police_incidents`: "Police_Incidents_2026" (legacy offence layer)

| Item | Finding |
|---|---|
| Endpoint | `https://services.arcgis.com/afSMGVsC7QlRK1kZ/arcgis/rest/services/Police_Incidents_2026/FeatureServer/0` (item `1e98b5322dd64605ae9947762292a76f`). There are also per-year layers from 2010 and `Police_Incidents_Last_2Years`. `maxRecordCount` 16000. |
| Cadence | Item: "Please note that the responseDate is shown in UTC time, not local time. The data set is refreshed on a daily basis by 9:30 AM." Observed: edited 2026-09-27T13:54Z; newest `reportedDateTime` 2026-09-26 10:49 local. The value is **local wall-clock** despite the note (`reportedTime` 1049 = 10:49Z). |
| Fields | `publicaddress` is a hundred-block or intersection. `caseNumber` (`MP2026279168`), `offense`/`description` (35 values in 30 days: THEFT, TFMV, AUTOTH, BURGD, BIKETF, TMVP, ASLT2, SHOPLF, DASTR, BURGB, ROBPAG, THFTSW, CSCR, DASLT2, ASLT3, ROBPER, …). Also `UCRCode`, `centerLat`/`centerLong` (block centre), `lastchanged` and `LastUpdateDateETL`. |
| Volume / terms | ~65 rows/day (17,364 YTD). CC0 (the item carries the statement). |
| **Recommendation** | Redundant with `Crime_Data`. Use it only if a simpler UCR-style offence list is wanted. `BLOCK_LEVEL`. `DASTR`/`DASLT*`/`CSC*` → **drop**; everything else → POLICE. |

### 2.4 `mn_minneapolis_mfd_calls_for_service` and 2.5 `mn_minneapolis_mfd_fires`: Minneapolis Fire (NFIRS)

| Item | Finding |
|---|---|
| Provider | Minneapolis Fire Department, new records system since August 2025. The item snippet: "All calls for service taken by Minneapolis Fire since August 2025. This dataset replaces the Fires Reported 2025 dataset as the department has moved to a new records management system." Items `063e3907cf9e49259b8292dd57f9cc20` (all calls) and `5ba5a2ab2add4eca9135c9006a62f86b` (fires only; adds `alarms`, `property_use`, `fire_spread`, `property_losses`, `content_losses`). |
| Endpoints | `https://services.arcgis.com/afSMGVsC7QlRK1kZ/arcgis/rest/services/MFD_Calls_For_Service/FeatureServer/0`<br>`https://services.arcgis.com/afSMGVsC7QlRK1kZ/arcgis/rest/services/MFD_Fires/FeatureServer/0`<br>Both are 16000-record pages. |
| Cadence | The layers are republished nightly (`dataLastEditDate` 2026-09-30T03:01Z). The **content ends 2026-06-06** (max `alarm_date`). That is a ~116-day lag, consistent with NFIRS report completion. **HISTORICAL**. |
| Fields / timestamps | `alarm_date` is a date only (midnight "UTC"); `alarm_time` is a separate `HH:MM:SS` local string, as are `cleared_date`/`cleared_time`. The address is split into `street_number`, `street_prefix`, `street_name`, `street_type`, `street_suffix`, **`apartment_number`**, `city`, `zip_code` and `cross_street`. `latitude`/`longitude` are **strings** at 6 decimals (rooftop). |
| Categories | `incident_type_code`/`incident_type` use NFIRS codes (96 distinct since May). Top values: 300B EMS-Asst Medics, 321 EMS call, 300A EMS-Arrive & Cancelled, 611 Dispatched and cancelled en route, 745 Alarm activation no fire, 622 No incident found, 554 Assist invalid, 743 Smoke detector activation, 311 Medical assist, 151 Outside rubbish fire, 444 Power line down, 412 Gas leak, 322/323/324 Motor vehicle accident, 111 Building fire, 131 Passenger vehicle fire, 143 Grass fire.<br>Fires layer, 27 codes: 151 (647), 111 Building fire (184), 113 Cooking fire confined (145), 131 (144), 118, 154, …<br>`property_use` has 67 values, e.g. 1 or 2 family dwelling, Multifamily dwelling, Vacant lot.<br>`fire_spread`: Confined to room/building/object/floor of origin, Beyond building of origin. |
| ID | `incident_number` (`26-0026882`). It appears to be the same series as the 911 `Master_Incident_Number` for FIRE rows (`26-0047944` on 9/27). The format matches, and the ~21k numbers issued between 6/6 and 9/27 match MFD call volume. Unverified. |
| Privacy | **Exact address plus apartment number on EMS calls**; `EMS-*` codes attach health events to a dwelling unit. |
| Terms | Item `licenseInfo` is blank (see the CC0 note in §2.2). |
| Volume | Calls: ~150–195/day. Fires: ~5.5/day (1,604 since 2025-08-19). |
| **Recommendation** | `arcgis_feature_query`, **HISTORICAL** (label it "reported through ‹max alarm_date›"). Precision: source `EXACT_PUBLIC_POINT`.<br>`PROPERTY_INCIDENT`: NFIRS 111 Building fire, 112 Fires in structure other than building, and 120–123. These are confirmed after the incident and matter most for real-estate context. Show at building level and never show `apartment_number`.<br>FIRE: 113–118 (confined), 13x (vehicle), 14x (vegetation), 15x/16x (outside/rubbish).<br>TRAFFIC: 322/323/324/300E.<br>HAZARD: 2xx, 411/412/424/444/445.<br>MEDICAL: 300A–D, 311, 320, 321, 554 → **drop street number and apartment; AREA aggregate only**.<br>OTHER: 5xx, 6xx, 7xx and 9xx (false alarms, good intent, service). The recommended default is hidden. |

### 2.6 Minneapolis: evaluated and not usable

- **"911 and Emergency Communications Center Incidents Dashboard"** (Hub page `941ea758c1d84188a53a10610e08c77d`). It embeds Tableau `tableau.minneapolismn.gov/views/911Dashboard/911Calls`: "Data refreshes approximately every half hour", "over the past 12 hours". It is not a machine-readable feed, so it was **not scraped**. If the city would expose the same extract as a feed, it would become the Minneapolis near-live source. **Ask the city.**
- **`msvcMPD_ShootingCFS`** (item `56ab3ec9e988466b87fa55231866ea09`): `dataLastEditDate` 2019-05-02. It is **stale**, and its fields include `Address` and `Apartment`. Do not use.
- **`Police_Stop_Data`, `Police_Use_of_Force`, `Officer_Conduct_Data`**: person-level policing data with demographics, not incident context. **Out of scope.**

### 2.7 `mn_stpaul_crime_incidents`: St. Paul "Crime Incident Report"

| Item | Finding |
|---|---|
| Provider / owner | City of Saint Paul / Saint Paul Police Department. Item `a2ef17136fe84735b469c04975dc3df1`, owner `CityofSaintPaul_BI`. The portal is ArcGIS Hub (`information.stpaul.gov`); the old Socrata id `gppb-g9cg` is gone. |
| Endpoint / example | `https://services1.arcgis.com/9meaaHE3uiba0zr8/arcgis/rest/services/Crime_Incident_Report_-_Dataset/FeatureServer/0/query?where=DATE >= TIMESTAMP '2026-09-24 00:00:00'&outFields=*&orderByFields=DATE DESC&f=json`. It is a **table** (no geometry). `maxRecordCount` **1000**, paginated. |
| Live / historical | Snippet: "Incidents from Aug 14 2014 through the most recent available in the City of Saint Paul. Data is added twice daily." Observed: edited 2026-09-30T05:31Z; newest `DATE` 05:01Z (00:01 CDT). **Recent-historical** (≤ 12 h). 581,432 rows. |
| Coordinates | None. `BLOCK` is a hundred-block string (`15XX LORIENT ST`, `XX EXCHANGE ST W`, `1XX MTAIRY ST`). Also `POLICE_GRID_NUMBER`, `NEIGHBORHOOD_NUMBER` and `NEIGHBORHOOD_NAME`; the District Councils polygons are item `1228fa76fd4a4d9ca501f22a7178e302`. |
| Categories (Sep 1–30) | `INCIDENT` (13): Proactive Police Visit 1,289; Theft 540; Narcotics 221; Criminal Damage 176; Burglary 113; Auto Theft 101; Discharge 61; Agg. Assault 61; Simple Assault Dom. 32; Community Event 20; Robbery 19; Agg. Assault Dom. 11; Rape 10.<br>`INCIDENT_TYPE` has 53 finer values, e.g. THEFT-FROM AUTO, WEAPONS-DISCHARGING A FIREARM IN THE CITY LIMITS. `CODE` is numeric (9954 = proactive visit). |
| Status | `CALL_DISPOSITION_CODE`/`CALL_DISPOSITION`: A Advised, RR/R Report Written, G Gone on Arrival. |
| Timestamps | `DATE` is **true UTC**. The item: "Upon downloading or exporting the data, any date/time columns are converted to Coordinated Universal Time (UTC)." The hour histogram minimum is 07–10Z. `TIME` is always null. |
| ID | `CASE_NUMBER` (integer, e.g. 26177318), unique per row in the sample. |
| Privacy | No names or narratives. The data description lists domestic assaults and rape as categories. |
| Terms | "Public Domain" … "If you transmit or provide the data (or any portion of it) to another user, the data must include this disclaimer." **LeadCommand must carry the St. Paul disclaimer** wherever it redistributes these rows. The description also notes: "Statistics displayed do not reflect official crime index totals, and may change after full investigation." |
| Attribution / key / CORS | "Source: City of Saint Paul (Saint Paul Police Department)". No key. `Access-Control-Allow-Origin: *`. |
| Volume | ~60–145 rows/day, including ~43/day proactive visits. |
| **Recommendation** | `arcgis_feature_query` (table) plus a hundred-block geocoder. **Recent-historical**; fresh if the edit is within **24 h** (2 × 12 h). `BLOCK_LEVEL` once geocoded; `AREA` (neighbourhood) otherwise.<br>Mapping: Theft, Auto Theft, Burglary, Criminal Damage, Robbery, Narcotics, Discharge, Agg. Assault, Homicide, Arson → POLICE. Simple Assault Dom., Agg. Assault Dom., Rape → **drop**. Proactive Police Visit and Community Event → **drop** (not incidents). |

### 2.8 `mn_ramsey_ecc_incidents`: Ramsey County ECC "Emergency Communications Center Incident Data" (St. Paul dispatch)

| Item | Finding |
|---|---|
| Provider | Ramsey County Emergency Communications Center. It dispatches St. Paul Police and Fire, the Ramsey County Sheriff and suburban departments. Socrata dataset `khr9-xwfu` on `opendata.ramseycountymn.gov`, category "Public Safety and Justice". |
| Endpoint / example | `https://opendata.ramseycountymn.gov/resource/khr9-xwfu.json?$where=response_date >= '2026-08-01T00:00:00'&$order=response_date DESC&$limit=1000` (page with `$offset`). |
| Live / historical | **HISTORICAL**, monthly. Metadata: "Frequency": "Monthly". `rowsUpdatedAt` 2026-09-01T20:26Z; data through 2026-08-31 23:59:41. Coverage 2017-01-01 onward (4,952,246 rows). |
| Coordinates | Description: "Geolocation references city and zip code, not a precise location." `geocoded_column_1` is a **city-level point** (e.g. St Paul 44.94339,-93.09648). `street_name` is the street name only (no number). 196 rows in Aug–Sep had no geocode. |
| Categories | `agency_type`: Law Enforcement 40,541; Medical/Fire 9,397 (August). `problem` has 118 distinct values.<br>Law Enforcement top values: TRF - Traffic Stop, PPV - Police Proactive Visit, AMA - Assist Medical Agency, DOC - Disorderly Conduct, PRK - Parking Complaint, SUS - Suspicious Activity, 911 - Investigate 911 Hangup, RCIV - Civil Div Paper Serve, WEL - Welfare Check, DOM -Domestic Fam Relationship, ALA - Alarm Sounding, THF - Theft, APD - Accident Property Damage, PIC - Person in Crisis, AHR - Accident Hit and Run, CDP - Criminal Damage Property, ASS - Assault, MSP - Missing Person, Juvenile.<br>Medical/Fire: MEDICAL 7,534, ALM - Alarm Sounding, DOW - Person Down, LIFT - Lift Assist, NAT - Natural Gas Odor, CO - CO Detector No Symptoms, IBURN - Illegal Burn, RUB - Rubbish Fire, BRU - Brush Fire, SMK - Smoke in the Area, VEH - Vehicle Fire, Slumper, APTS - Smoke in an Apartment, WIR - Wire Down, DWLF - Dwelling Fire, JUM - Jumper, APTF - Apartment Fire, WATR - Water Rescue, GARF - Garage Fire, COMF - Commercial Fire. |
| Pre-redaction by source | Lineage: "Filter for incidents entered into pending or active queue, remove all LAW incidents with Child Abuse, Criminal Sexual Conduct, Juvenile Incident and Predatory Offender. Specific medical type codes converted to generic "MEDICAL" label." |
| Timestamps / ID | `response_date` is a **floating local** timestamp (Socrata `calendar_date`); the hour minimum is at 04–05. `master_incident_number` (`20260831-0521147`) is unique per row. |
| Terms | No licence on the dataset. Portal statement: "The Open Data Portal, Open Ramsey County, makes data generated by the county openly available to the public to increase transparency, accountability and comparability, promote economic development and research, and improve performance management." **Terms need confirmation.** Attribution field: "Ramsey County Emergency Communications Center". |
| Rate limit / key / CORS | No key needed. A Socrata app token is optional and free via a Socrata profile (not registered). SODA docs: "IP addresses that make too many requests during a given period may be subject to throttling." With a token: "Currently we do not throttle API requests that are using an application token, unless those requests are determined to be abusive or malicious." `Access-Control-Allow-Origin: *`. |
| Volume | ~1,600 rows/day (49,938 in August 2026). |
| **Recommendation** | `socrata_soql`. **HISTORICAL**; fresh if `rowsUpdatedAt` is within 62 days. `AREA` (city) only, so it is useful for monthly context layers, not pins.<br>Mapping: `Accident*` → TRAFFIC. DWLF/APTF/GARF/COMF/VEH/RUB/BRU/SMK/*S smoke/ALM/IBURN → FIRE. NAT/CO/ODR/WIR/WIRF → HAZARD. MEDICAL/DOW/LIFT → MEDICAL (AREA aggregate). DOM, PIC, WEL, MSP*, JUM, Slumper, HRS → **drop**. Traffic stops, proactive, admin, civil-paper, warrant and transport → **drop**. Remaining Law Enforcement → POLICE. Rescues/ELV/LRT/SER/KEY → OTHER. |

### 2.9 Hennepin County

- **No machine-readable incident, CAD or 911 dataset exists.**
- The Hennepin County Hub (`gis-hennepin.hub.arcgis.com`) search for "sheriff", "911", "crime", "incident" and "calls for service" returned 0 results. Only police and fire station points exist.
- `gis.hennepin.us/arcgis/rest/services/HennepinData` has only BOUNDARIES, CLIMATE, ENVIRONMENT, HEALTH, HEAT_WATCH, LAND_PROPERTY, LANDSLIDE, PLACES and TRANSPORTATION.
- The Sheriff's Emergency Communications Facility data is available only via data requests ([hennepinsheriff.org/services/data-requests](https://www.hennepinsheriff.org/services/data-requests)).
- Suburban Hennepin coverage has to come from MnDOT (freeways) and NWS/WFIGS.

### 2.10 `mn_mndot_iris_incidents`: MnDOT RTMC IRIS `incident.xml.gz`

| Item | Finding |
|---|---|
| Provider | MnDOT Regional Transportation Management Center (RTMC), IRIS ATMS. Names like `L004_15764987` look like an automated import, possibly State Patrol CAD (unverified). Operator-entered names are timestamp-like, e.g. `2026093003583318`. |
| Access | Gzipped XML snapshot over HTTPS. The directory index is `https://data.dot.state.mn.us/iris_xml/`. |
| Endpoint | `GET https://data.dot.state.mn.us/iris_xml/incident.xml.gz`. There are no parameters. |
| Documentation | IRIS project docs (MnDOT's open-source ATMS): "Active incidents are written to an XML file, which can be processed by external systems." ([incidents.md](https://github.com/mnit-rtmc/iris/blob/master/docs/incidents.md)). The XML output table lists: "`incident.xml.gz` \| 30 seconds \| Current incident information" ([troubleshooting.md](https://github.com/mnit-rtmc/iris/blob/master/docs/troubleshooting.md)). |
| Live | **LIVE** snapshot, active plus recently cleared. `Last-Modified` 10:42:07Z vs fetch 10:42:34Z. The `time_stamp` attribute read 06:55:07 CDT vs fetch 11:55:32Z. `Cache-Control: max-age=20`. |
| Lookback | None. Cleared incidents "remain in the list for some time afterward"; the default `incident_clear_secs` is "300 seconds (5 minutes)". |
| Structure | `<active_incidents time_stamp>` containing `<incident name replaces? event_type event_date detail? lane_code road dir location? lon lat camera impact cleared confirmed/>`. It has an inline DTD, and `confirmed` is **not declared** in it. Use a non-validating parser and disable DTD/external entities (XXE). |
| Coordinates | `lat`/`lon` at 5 decimals: an operator-placed point on the roadway. |
| Categories | `event_type`: INCIDENT_CRASH, INCIDENT_STALL, INCIDENT_HAZARD, INCIDENT_ROADWORK (IRIS `EventType` enum).<br>`detail` examples: Rollover, Pedestrian on Highway.<br>`lane_code`: Mainline, plus Exit, Entrance and CD Road per the docs.<br>`impact` has one character per lane including both shoulders: `.` free flowing, `?` affected, `!` blocked (`LaneImpact.java`). |
| Status | `cleared` and `confirmed` (true/false). |
| Timestamps | `event_date='Wed Sep 30 03:58:33 CDT 2026'`: Java `Date.toString()`. Map `CDT` to -05:00 and `CST` to -06:00. |
| ID | `name` (`L004_15764987` from CAD or `2026093003583318` from the operator). **An edit creates a new name with `replaces='<old>'`**; follow the chain to keep identity. |
| Privacy | None: no names or free text beyond `detail`. |
| Terms | **No feed-specific licence.** MnDOT disclaimer ([dot.state.mn.us/information/disclaimer.html](https://www.dot.state.mn.us/information/disclaimer.html)): "The user accepts the data "as is" and assumes all risks associated with its use." Also: "Due to the dynamic nature of the Internet, resources that are free and publicly available one day may require a fee or restricted access the next, and the location of items may change as menus, homepages, and files are reorganized." **Needs terms confirmation** (RTMC) for commercial display. |
| Attribution / key / CORS | Suggest "Source: Minnesota Department of Transportation (MnDOT RTMC)". No key. **No CORS header**, so fetch server-side. An F5 cookie is set. robots.txt returns 404. |
| Volume | 4 active at 05:42 CDT and 14 at 06:55 CDT (rush hour). It covers metro freeways plus some trunk highways. |
| **Recommendation** | Adapter `xml_snapshot` (IRIS). **LIVE**. Freshness: live if `time_stamp` is within **60 s** (2 × 30 s); hide the feed if older than 5 min. Ids that disappear from two consecutive snapshots are closed.<br>`EXACT_PUBLIC_POINT`.<br>Mapping: CRASH, STALL, ROADWORK → TRAFFIC; HAZARD → HAZARD. |

### 2.11 `mn_mndot_wzdx`: MnDOT Work Zone Data Exchange (WZDx v4.0)

| Item | Finding |
|---|---|
| Provider | MnDOT via Castle Rock CARS (`publisher: MnDOTCastleRock`). It is registered in the USDOT WZDx Feed Registry: `state=minnesota`, `feedname=mndot`, `needapikey=false`, `datafeed_frequency_update=1m`. |
| Endpoint | `GET https://mn.carsprogram.org/carsapi_v1/api/wzdx` returns GeoJSON FeatureCollection with `road_event_feed_info`. There are no parameters or paging; it is a full snapshot of 1.2 MB. |
| Live | **LIVE**. `road_event_feed_info.update_frequency: 60`. `update_date` 11:14:36Z vs fetch 11:14:52Z. One call returned **HTTP 504**; it was 200 on retry 40 min later. |
| Coordinates | `LineString` (393) or `MultiPoint` (212). `beginning_accuracy`/`ending_accuracy` are `estimated`. **`bbox` is in `[lat, lon, lat, lon]` order** (non-compliant), so ignore it. |
| Categories | `core_details.event_type`: work-zone 435, detour 170.<br>`vehicle_impact`: unknown, all-lanes-closed 108, some-lanes-closed 70, flagging, temporary-traffic-signal.<br>`types_of_work`: surface-work, below-road-work.<br>`description` examples: "Closed, Construction Work, Detour In Operation", "Exit Ramp Closed", "Road Maintenance Operations, Work Zone Is Active". `restrictions` (reduced width/height/length), `worker_presence`, `reduced_speed_limit_kph`. |
| Status | `event_status`: active 74, pending 89, planned 2, absent 440. `start_date`/`end_date` are ISO UTC. |
| ID | Feature `id` = CARS id plus segment: `CARSx-97810-1`; detours use `-D1`. `core_details.relationship` links parents and children. The same CARS numbers appear in 511MN (`https://511mn.org/event/CARSx-…`). |
| Privacy | Feed metadata `contact_name`/`contact_email` hold a named MnDOT employee. They are redacted in the fixture and must not be stored. Events carry no personal data. |
| Terms | Feed-declared `"license": "https://creativecommons.org/publicdomain/zero/1.0/"` (CC0). The registry is public domain. |
| CORS / key | No key. No CORS header seen, so fetch server-side. |
| **Recommendation** | Adapter `wzdx_geojson` (generic across the registry). **LIVE**. Freshness: `update_date` within 2 min. Drop events past `end_date`.<br>`EXACT_PUBLIC_POINT` (line geometry).<br>Mapping: work-zone and detour → TRAFFIC. Full closures (`all-lanes-closed`) are the "road closure" signal. |

### 2.12 `mn_511_events_iowadot_mirror`: "511 Traveler Information - Minnesota" (hosted by Iowa DOT)

| Item | Finding |
|---|---|
| Provider | MnDOT 511 (CARS) events, republished by Iowa DOT. Item `081587d29d944a89ad189b1633e509e4`, owner `IowaDOT_SODA`, `accessInformation` "Minnesota Department of Transportation, Iowa Department of Transportation". |
| Endpoint | `https://services.arcgis.com/8lRhdTsQyJpO52F1/arcgis/rest/services/CARS511_MN_Events_View/FeatureServer/0/query?where=1=1&outFields=*&outSR=4326&f=json`. 338 rows; `maxRecordCount` 2000. |
| Cadence | Item: "Current 511 Events for Minnesota. This data is updated every 10 minutes." Observed: `dataLastEditDate` 10:41:06Z, then 12:11:06Z. `EditDate` is the load time for **every** row, not a per-event time. |
| Fields | `ID` (`CARSx-144319`), `STYLE`, `headline`, `phrase`, `cause`, `Route`, `Priority`, `linktxt`. Times are local strings with no zone: `StartTime` "09:00 AM", `UpdateDate` "09/26/2026", `UpdateTime` "08:24 AM", `IssueDate` "20260926", `IssueTime` "082442", `ExpireDate`/`ExpireTime`, `EndTime`. Crash rows carry a placeholder `ExpireDate` of 2030. |
| Categories | `STYLE`: roadwork 128, closure 77, warning 57, future_event 46, restriction 19, lane_closure 6, priority_warning 5.<br>`phrase` examples: Construction Work, Closed, Road Maintenance Operations, Exit Ramp Closed, Entrance Ramp Closed, Gross Weight Limit, Bridge Construction, Length Limit, **Crash**, Reduced To One Lane, Height Limit.<br>Crashes appear as `priority_warning`, e.g. "I-35E: Crash". |
| Coordinates | A single point, the event start, in Web Mercator. Lines are not included. |
| Terms | Licence: "This work is licensed under a Creative Commons Attribution 4.0 International License". Iowa DOT GIS terms: "These licenses allow you to copy, share, adapt, transform, and build upon the Data for any purpose, including commercial use, provided that you give appropriate credit to the Data source, which may be the Iowa Department of Transportation or a third party, and comply with the terms of the applicable license." But the item description says: "This layer is provided as a courtesy from Iowa DOT for use by Iowa DOT web mapping applications." The additional-terms link points at the MnDOT CARS-Hub terms (§2.13). **Needs terms confirmation.** |
| **Recommendation** | `arcgis_feature_query`. **LIVE**; freshness `dataLastEditDate` within 20 min. `EXACT_PUBLIC_POINT` (start point only).<br>Mapping: `phrase=Crash` → TRAFFIC. Closure/roadwork/lane_closure/future_event/restriction → TRAFFIC. Weather-related warnings → HAZARD. Unknown warnings → OTHER.<br>Prefer IRIS for crashes and WZDx for work zones. Use this only for statewide crash coverage outside the IRIS network, and only once terms are confirmed. |

### 2.13 511MN / CARS-Hub direct feeds

- `511mn.org` is a JavaScript single-page app. Its sitemap lists no developer pages, and `/developers` returns the app shell.
- The "Minnesota 511 Terms of Use" link is at [dot.state.mn.us/metro/developer.html](http://www.dot.state.mn.us/metro/developer.html), titled "Developer's Agreement". It is the **CARS-Hub Terms and Conditions of Use and Access**. Two clauses matter:
  - "Both Castle Rock and the Minnesota Department of Transportation shall have the authority to terminate the use of the feed by a third party at their discretion. We may impose or adjust the limit on the number of transactions private access users may send or receive through the Hub, at our discretion."
  - An indemnity: "Users of the CARS-Hub data feeds agrees to defend, indemnify, and hold harmless Castle Rock and the Minnesota Department of Transportation … arising out of the use of the data maintained on the CARS-Hub sites."
- Access is a developer agreement or registration, **not done**. The 511mn.org app's internal JSON endpoints are **undocumented** and were **not used**.

---

## 3. Georgia

### 3.1 `ga_atlanta_police_crime`: Atlanta Police Department open data (NIBRS, 2021–2026)

| Item | Finding |
|---|---|
| Provider | Atlanta Police Department. Portal: `opendata.atlantapd.org` (ArcGIS Hub site `f1eb8117c123485ba79c9f34ff647686`). The "2021-2026 Crime Data" experience (`d5dd2be2977d40acb340ef42f80671b8`) reads this layer. |
| Endpoint / example | `https://services3.arcgis.com/Et5Qfajgiyosiw4d/arcgis/rest/services/OpenDataWebsite_Crime_view/FeatureServer/0/query?where=ReportDate >= TIMESTAMP '2026-09-29 00:00:00' AND ReportDate < TIMESTAMP '2026-10-01 00:00:00'&outFields=*&orderByFields=ReportDate DESC&f=json` (item `774475034b694ce68b6d2e887aa96544`). `maxRecordCount` 2000, paginated. 308,138 rows since 2021-01-01. |
| Cadence | Portal: "Crime data on this website is updated hourly, and some reports may be reclassified or removed due to duplication." Observed: layer edits 10:43:39Z and 11:45:09Z. Newest `ReportDate` 09:56Z at the ~11:00Z check, i.e. about a **1 h lag**. **NEAR-LIVE** reports, not calls. |
| Coordinates | **Exact.** `StreetAddress` is a full street number ("2261 CASCADE RD SW"); `Latitude`/`Longitude` are rooftop at 6 decimals (wkid 4326). Portal: "all data published on this website must include valid latitude and longitude coordinates. If a report does not have this data, it will be temporarily excluded until it can be corrected." |
| Categories (Sep 2026) | `NIBRS_Bucket` (25): All Other Offenses 986, Assault Offenses 549, Drug/Narcotic Offenses 526, All Other Larceny 423, Theft From Auto 318, Damage to Property 275, Fraud Offenses 207, Aggravated Assault 207, Shoplifting 199, Auto Theft 186, Burglary 122, Weapon Law Violations 76, Robbery 43, Sex Offenses 30, Homicide 12, Rape 9, Arson 5, …<br>`NIBRS_Offense` has 46 values; `NibrsUcrCode` e.g. 23F, 13A, 90C.<br>`Crime_Against`: Property/Society/Person. `Part`: Part I/II.<br>`LocationType` (39): RESIDENCE_HOME 959, HIGHWAY_ROAD_ALLEY_STREET_SIDEWALK 853, APARTMENT 544, PARKING_DROP_LOT_GARAGE 437, CONVENIENCE_STORE, AIR_BUS_TRAIN_TERMINAL, SERVICE_GAS_STATION, …<br>Also `FireArmInvolved` yes/no, `GAFamilyViolenceIndicator` YES 317/NO, `event_watch` (Morning/Day/Evening Watch), `Zone` (Zone 1–6, Airport), `BEAT`, `NPU`, `NhoodName`. |
| Status | None. Reports can be "reclassified or removed". |
| Timestamps | `ReportDate`, `OccurredFromDate`, `OccurredToDate` are **true UTC** epoch ms. The portal notes that exports convert to UTC; the hour minimum is 08–12Z. **Data-quality defect:** `ReportDate` contains garbage years (min 1015, max **2124**), so reject values outside [2021-01-01, now + 1 day]. |
| ID | `IncidentNumber` (`262730134`), with **one row per offence** in `ReportNumber` (`262730134-1`). Two rows can share one incident, e.g. Disorderly Conduct plus Aggravated Assault. `OBJECTID` is large and not stable. `ChargeId_First` is mostly null. |
| Privacy | **Exact residential addresses**: RESIDENCE_HOME and APARTMENT are ~36% of rows. `GAFamilyViolenceIndicator`, `Vic_Count`, `IsBiasMotivationInvolved`, `CriminalGangActivityInvolved`. Sex offences and rape carry exact points. |
| Terms | "The data found on this website can not be used to recreate any official crime report." "Anyone can use this data at no cost." The site footer "Terms of Service" link is a placeholder (`href="#"`). There is **no formal licence**, so confirm redistribution terms with APD. |
| Attribution / key / CORS | "Source: Atlanta Police Department Open Data". No key. `Access-Control-Allow-Origin: *`. |
| Volume | ~120–160 rows/day. |
| **Recommendation** | `arcgis_feature_query`, **NEAR-LIVE**. Freshness: `dataLastEditDate` within **2 h** (2 × hourly).<br>**Degrade to `BLOCK_LEVEL`:** truncate `StreetAddress` to its hundred-block (e.g. `22XX CASCADE RD SW`), snap or round the coordinates to the block, and never store the original.<br>**Drop** if any of these hold: `GAFamilyViolenceIndicator=YES`, `NIBRS_Bucket` in (Sex Offenses, Rape, Pornography/Obscene Material, Kidnapping/Abduction), or `LocationType` in (RESIDENCE_HOME, APARTMENT, HOTEL_MOTEL_ETC) with `Crime_Against=Person`.<br>Collapse rows to one event per `IncidentNumber`.<br>Mapping: everything that remains → POLICE. Arson stays POLICE (a crime record). |

### 3.2 Atlanta: `OnlineCADData` DO NOT USE

See §1.4.
- It is a public ArcGIS layer in the APD org containing caller name and phone, officer names and free-text comments.
- It is not a published open dataset (not in the Hub catalog, owned by an individual account, created 2026-07-28, last edited 2026-07-28).
- **Excluded.** No records were requested and there is no fixture.

### 3.3 Atlanta Fire Rescue

- **No official incident dataset was found.**
- The APD org has `AFRD_Battalion_ServiceArea` (polygons) and AFRD publishes station points (`AFRD_FireStations_Public2020`).
- Incident data is available by open-records request only (the [Atlanta Fire Rescue open records page](https://www.atlantafirerescue.com/how-do-i/open-record-request)).
- Fire context for Atlanta must come from NWS, WFIGS and the GA511 "Vehicle on fire" events.

### 3.4 GA511 developer API (Georgia DOT) — **blocked: key required**

| Item | Finding |
|---|---|
| Provider | Georgia DOT, 511GA platform. Docs: [511ga.org/developers/doc](https://511ga.org/developers/doc) and [511ga.org/help/endpoint/event](https://511ga.org/help/endpoint/event). |
| Access | REST JSON or XML: `GET https://511ga.org/api/v2/get/event?key=<KEY>&format=json`. Our one unauthenticated probe returned HTTP 400. |
| Key / limits | "Requires a developer key. For most calls, query string 'key' parameter is required." "Throttling is enabled. Ten calls every 60 seconds." "A registered account is needed before you can sign up for a Developer API key." The key is free with a 511GA account. **Not registered.** |
| Documented schema | `ID`, `SourceId`, `Organization`, `RoadwayName`, `DirectionOfTravel`, `Description`, `Reported`/`LastUpdated`/`StartDate`/`PlannedEndDate` (**Unix seconds**), `LanesAffected`, `Latitude`/`Longitude`, `LatitudeSecondary`/`LongitudeSecondary`, `EventType` (roadwork, closures, accidentsAndIncidents, specialEvents), `IsFullClosure`, `Severity`, `Comment`, `EncodedPolyline` (Google polyline), `Restrictions`, `DetourPolyline`, `DetourInstructions`, `Recurrence`, `RecurrenceSchedules`, `Subtype`. |
| Terms | The developer terms are **not visible without an account**. The `/developers/daa` path redirects to "notfound". Terms are **unverified**. |
| **Recommendation** | Register a key under the LeadCommand org account and read the terms at signup (a human decision). Adapter `ga511_rest`, **LIVE**, poll ≥ 60 s (10 calls/min shared). `EXACT_PUBLIC_POINT` plus polyline.<br>Mapping: accidentsAndIncidents → TRAFFIC; closures → TRAFFIC; roadwork → TRAFFIC; specialEvents → TRAFFIC (a road closure for a parade or filming). |

### 3.5 `ga_511_events_gema_mirror`: "GDOT 511 Events Public View" (GEMA/HS)

| Item | Finding |
|---|---|
| Provider | Georgia Emergency Management and Homeland Security Agency (GEMA/HS). The owner's public profile identifies it as the GEMA/HS GIS function. Item `24c16968306b42779776ec24a88574ee`. |
| Endpoint | `https://services1.arcgis.com/2iUE8l8JKrP2tygQ/arcgis/rest/services/GDOT_511_Events_Public_View/FeatureServer/0/query?where=1=1&outFields=*&outSR=4326&f=json`. 139 rows; `maxRecordCount` 1000. |
| Cadence | Item: "Data comes from GDOT's 511 website using their developer API." "Data is overwitten every 15 minutes." (sic). Observed edits 11:13:47Z and 12:13:47Z. Newest `LastUpdated` 11:23Z. |
| Fields / values | The same schema as GA511, flattened. Dates are Esri epoch ms UTC. `IsFullClosure` is a **string** "True"/"False". `Restriction_*` fields are strings.<br>`EventType`: closures 57, roadwork 38, specialEvents 30, accidentsAndIncidents 14. `Severity`: minor 98, major 41. `Organization`: GA-Events.<br>Descriptions look like "Debris on roadway on I-85 Northbound at SR 34. 1 lane blocked." and "Parade on SR 3 Northbound at PIRATE DRIVE . All lanes closed." |
| Terms | **No licence on the item.** It is derived from the keyed GA511 API, whose redistribution terms are unverified. **Needs terms confirmation (GDOT and GEMA)** before production use. The fixture is kept for schema tests only. |
| **Recommendation** | Do not enable until GDOT confirms. If confirmed: `arcgis_feature_query`, **LIVE**, freshness within 30 min (2 × 15), `EXACT_PUBLIC_POINT`, same mapping as §3.4. |

---

## 4. Federal / national

### 4.1 `us_nws_alerts`: NWS active alerts (api.weather.gov)

| Item | Finding |
|---|---|
| Provider | NOAA National Weather Service. CAP v1.2 content served as GeoJSON / JSON-LD. |
| Endpoint / examples | `GET https://api.weather.gov/alerts/active?status=actual&area=MN` with `Accept: application/geo+json`. Other filters: `area=GA`, `zone=MNZ059`, `point=44.98,-93.27`, `message_type`, `event`, `severity`, `urgency`, `certainty`. Zone polygon: `GET https://api.weather.gov/zones/forecast/MNZ059`. No paging (the active set is returned whole). |
| Required headers | "A User Agent is required to identify your application." We sent `LeadCommand-Discovery (…ops.leadcommand.ai)`. |
| Cadence / rate | Alerts doc: "We recommend you make requests of the server no more than every 30 seconds." API doc: "The rate limit is not public information, but allows a generous amount for typical use. If the rate limit is execeed a request will return with an error, and may be retried after the limit clears (typically within 5 seconds)." (sic). `Cache-Control: max-age=4, s-maxage=5`. The collection `updated` was 11:15:06Z at an 11:15:57Z fetch. |
| Lookback | Active only. "The /alerts endpoint contains alerts issued over the past seven days." |
| Geometry | **Only 30 of 217** active alerts carried a polygon: warnings such as Flood/Flash Flood/Marine. The rest are **zone-based**: `affectedZones` (URLs) and `geocode.UGC`/`geocode.SAME`. `area=MN` returns multi-state alerts, so `affectedZones` included Iowa zones; filter by UGC prefix if needed. |
| Categories (national, 11:15Z) | `event`: Small Craft Advisory 90, Flood Watch 37, Dense Fog Advisory 15, Flood Warning 14, Special Weather Statement 11, Beach Hazards Statement 8, Flash Flood Warning 8, Gale Warning 8, Coastal Flood Advisory 6, Flood Advisory 5, Hydrologic Outlook 4, Coastal Flood Statement 3, Heavy Freezing Spray Warning 2, **Test Message 1**, Marine Weather Statement, Extreme Heat Watch, Heat Advisory, Rip Current Statement, Winter Weather Advisory.<br>`category`: Met. `severity`: Minor/Moderate/Severe/Unknown. `certainty`: Likely/Possible/Observed/Unknown. `urgency`: Expected/Future/Immediate/Unknown. `response`: Avoid/Prepare/Execute/Monitor/None. |
| Status | `status`: Actual 216, **Test 1** (a `KEEPALIVE` heartbeat, id `urn:oid:2.49.0.1.840.0-KEEPALIVE-…`). `messageType`: Alert 137, Update 80 (Cancel is possible). |
| Timestamps / ID | `sent`, `effective`, `onset`, `expires`, `ends` are ISO-8601 with offset. `id` = CAP identifier (`urn:oid:…`). **Updates get new ids**, and `references[]` lists superseded ids. Supersede on Update/Cancel; otherwise expire at `ends ?? expires`. |
| Privacy | Weather narratives only. Beware relayed non-weather CAP events: "Child Abduction Emergency" descriptions contain personal descriptions, so drop them. |
| Terms | "All of the information presented via the API is intended to be open data, free to use for any purpose. As a public service of the United States Government, we do not charge any fees for the usage of this service." Suggest attribution "Source: NOAA/National Weather Service". |
| CORS / key | `Access-Control-Allow-Origin: *`. No key. |
| Volume | ~200–300 active nationally (217 observed; 3 touching MN, 6 touching GA). |
| **Recommendation** | Adapter `nws_cap_geojson`. **LIVE**, poll every 60 s (≥ 30 s). Freshness: collection `updated` within 5 min.<br>`AREA` when a polygon is present; otherwise **`ZONE`**. Resolve and cache zone geometry from `/zones/forecast|county|fire/{id}` (it changes rarely).<br>Filter `status=actual`.<br>Mapping: `category=Met` → HAZARD. Non-weather civil events (Civil Emergency Message, Evacuation Immediate, Shelter In Place Warning, Hazardous Materials Warning, Law Enforcement Warning, Nuclear Power Plant Warning, Fire Warning) → EMERGENCY. Child Abduction Emergency → **drop**. Test/KEEPALIVE → **drop**. |

### 4.2 `us_usgs_earthquakes`: USGS earthquake GeoJSON summary feeds

| Item | Finding |
|---|---|
| Endpoints | `https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson`. Also `all_day`, `all_week`, `all_month`, plus magnitude variants (`2.5_day`, `4.5_week`, `significant_month`, …). For history, the FDSN event API. |
| Cadence | Documented: "Updated every minute". `Cache-Control: max-age=60`; `metadata.generated` equals the fetch time. Newest `updated` was ~7 min before fetch. |
| Fields | `mag`, `place`, `time`/`updated` (epoch ms UTC), `tz` (null), `url`, `detail`, `felt`, `cdi`, `mmi`, `alert` (PAGER: null/green; yellow/orange/red possible), `status`, `tsunami`, `sig`, `net`, `code`, `ids`, `sources`, `types`, `nst`, `dmin`, `rms`, `gap`, `magType`, `type`, `title`. Geometry is `[lon, lat, depth_km]`. |
| Observed values (all_day, 221 events) | `type`: earthquake 218, explosion 3. `status`: automatic 147, reviewed 74. `magType`: ml, md, mb, mww, mw. `net`: nc, ak, ci, us, tx, av, hv, uw, nn, pr. `alert`: null 215, green 6. |
| ID | `id` is the preferred event id, e.g. `nn00925077`. `ids`/`sources` are comma-wrapped lists, e.g. `,av,ak,`, for events solved by several networks. ComCat docs describe `ids` as "a comma-separated list of event ids that are associated to an event". Dedupe on any overlapping id. |
| Terms | "USGS-authored or produced data and information are considered to be in the U.S. Public Domain." Requested credit: "Credit: U.S. Geological Survey" ([usgs.gov copyrights-and-credits](https://www.usgs.gov/information-policies-and-instructions/copyrights-and-credits)). |
| CORS / key | `Access-Control-Allow-Origin: *`. No key. |
| **Recommendation** | Adapter `usgs_geojson_summary`. **LIVE**, poll `all_hour` every 60 s. Freshness: `metadata.generated` within 3 min. `EXACT_PUBLIC_POINT` (epicentre; show with the reported uncertainty radius).<br>Mapping: `type=earthquake` → HAZARD. Explosion / quarry blast / other → OTHER. Hide `mag` below 2.5 by default (product choice). |

### 4.3 `us_nifc_wfigs_incidents`: WFIGS "Current Wildland Fire Incident Locations"

| Item | Finding |
|---|---|
| Provider | National Interagency Fire Center: Wildland Fire Interagency Geospatial Services (WFIGS), sourced from IRWIN. Item `4181a117dc9e43db8598533e29972015`, owner `NIFC_Authoritative`. |
| Endpoint / example | `https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Incident_Locations_Current/FeatureServer/0/query?where=POOState IN ('US-MN','US-GA')&outFields=*&outSR=4326&f=json`. `maxRecordCount` 2000; 440 rows nationally. |
| Cadence | "Data are refreshed from IRWIN every 5 minutes. Fall-off rules are enforced hourly." Fall-off, first rule quoted: "Fire size is less than 10 acres (Size Class A or B), and fire information has not been updated in more than 3 days". The other thresholds are 8 days for 10–100 acres and 14 days above 100 acres. Only fires "not been declared contained, controlled, nor out" are included. Observed `ModifiedOnDateTime_dt` max 08:43Z; the layer `lastEditDate` advanced 11:06Z → 12:05Z. |
| Fields (95) | Key fields: `IrwinID` (`{GUID}`), `UniqueFireIdentifier` (`2026-MNSUF-002396`), `IncidentName`, `IncidentTypeCategory` (WF 318 / RX 120 / CX 2), `IncidentSize` (acres), `PercentContained`, `FireDiscoveryDateTime`, `ContainmentDateTime`/`ControlDateTime`/`FireOutDateTime`, `ModifiedOnDateTime_dt`, `FireCause` (Undetermined/Natural/Human), `POOState` (`US-MN`), `POOCounty`, `InitialLatitude`/`InitialLongitude`. All dates are true UTC. |
| Coordinates | Point of origin as reported, in NAD83 (4269). Accuracy is not stated, so use `APPROXIMATE_POINT`. |
| Privacy | `IncidentShortDescription` is free text (e.g. "5 Miles S from Lac la Croix, MN") and is redacted in the fixture. `IncidentName` can be a road name (e.g. "Jack Pine Lane"). Small fires on private land pinpoint parcels. |
| Terms | Disclaimer: "The National Interagency Fire Center shall not be held liable for improper or incorrect use of the data described and/or contained herein. … The information contained in these data is dynamic and may change over time." No explicit licence; federal and interagency (incl. National Association of State Foresters). Attribution: "Source: National Interagency Fire Center (WFIGS/IRWIN)". |
| CORS / key | `Access-Control-Allow-Origin: *` (`max-age=300`). No key. |
| **Recommendation** | `arcgis_feature_query`, **LIVE**. Poll every 5 min. Freshness: layer `lastEditDate` within 2 h (the fall-off job runs hourly); show per-incident "as of `ModifiedOnDateTime_dt`".<br>`APPROXIMATE_POINT`.<br>Mapping: WF and CX → FIRE. RX (prescribed) → FIRE with `prescribed=true`, hidden by default. Drop `IncidentShortDescription`. |

### 4.4 `us_nifc_wfigs_perimeters`: WFIGS "Current Interagency Fire Perimeters"

| Item | Finding |
|---|---|
| Endpoint | `https://services3.arcgis.com/T4QMspbfLg3qTGWY/arcgis/rest/services/WFIGS_Interagency_Perimeters_Current/FeatureServer/0/query?where=1=1&outFields=poly_IncidentName,poly_GISAcres,poly_DateCurrent,attr_IrwinID,attr_UniqueFireIdentifier,attr_PercentContained,attr_POOState&geometryPrecision=5&outSR=4326&f=geojson` (item `d1c32af3212341869b3c810f1a215824`). 129 polygons. |
| Cadence / rules | The same IRWIN criteria and fall-off as §4.3. "Perimeters are not available for every incident." `poly_DateCurrent` max was 03:33Z; `dataLastEditDate` 12:05Z. |
| Fields | `poly_*` fields (polygon source): `poly_IncidentName`, `poly_FeatureCategory` (Wildfire Daily Fire Perimeter 127 / Prescribed Fire 2), `poly_MapMethod` (Mixed Methods, IR Image Interpretation, Auto-generated for InFORM, Hand Sketch, GPS-*, …), `poly_GISAcres`, `poly_PolygonDateTime`, `poly_IRWINID`. Plus `attr_*` fields that mirror the incident attributes. |
| **Recommendation** | `arcgis_feature_query`, **LIVE**, poll every 15 min, `AREA`, FIRE. Join to incidents on `attr_IrwinID`, which is the incidents layer's `IrwinID`. Use `maxAllowableOffset` or `geometryPrecision` to limit payloads. |

### 4.5 National road closures: `us_dot_wzdx_feed_registry`

| Item | Finding |
|---|---|
| What | The USDOT ITS JPO "Work Zone Data Feed Registry". Socrata `69qe-yiui` on `data.transportation.gov`. Rows updated 2026-09-10. |
| Endpoint | `https://data.transportation.gov/resource/69qe-yiui.json?$where=active=true` |
| Fields | `state`, `issuingorganization`, `feedname`, `url`, `format`, `active`, `datafeed_frequency_update`, `version`, `sdate`, `edate`, `needapikey`, `apikeyurl`, `geocoded_column`. 43 feeds. |
| MN / GA | Minnesota: `mndot`, `https://mn.carsprogram.org/carsapi_v1/api/wzdx`, 1m, v4, **no key** (§2.11). **Georgia: none.** |
| Other notable rows | NPS `roadevents` (key required). Several feeds need keys, e.g. CA MTC, CO, IL (IDOT CWZ and Tollway), MA, MI, OH, OR, PA Turnpike, TX and VA. Two registry rows (FL, OK) embed a publisher-issued key in the URL but are marked `needapikey=false`; they are not copied into the fixture. |
| Terms | Licence "Public Domain U.S. Government". Recommended citation: "U.S. Department of Transportation Intelligent Transportation Systems Joint Program Office. (2020). Work Zone Data Exchange (WZDx) Feed Registry. [Dataset]. Provided by ITS DataHub through Data.transportation.gov. Accessed YYYY-MM-DD from http://doi.org/10.21949/1518702". Description: "Some links provide direct access, while others require a user to create their own API access key for authentication." |
| Not machine-readable | FHWA "National Traffic and Road Closure Information" (`fhwa.dot.gov/trafficinfo` → `highways.dot.gov/traffic-info`). It is an HTML link list, and returned an **Akamai 403** to our request. Not retried, not used. |
| **Recommendation** | No single national incident or closure feed exists. Use the registry as a **discovery table**: one generic `wzdx_geojson` adapter, enabled per state where `needapikey=false`, with terms confirmed per feed. `EXACT_PUBLIC_POINT` (lines). TRAFFIC. It covers **work zones, closures and detours only, not crashes**. |

### 4.6 Also noted, not evaluated in depth (no fixture)

- **OpenFEMA `IpawsArchivedAlerts`** (`https://www.fema.gov/api/open/v1/IpawsArchivedAlerts`).
  - Keyless, `Access-Control-Allow-Origin: *`.
  - It is an archive of all IPAWS CAP messages, including **non-NWS civil alerts** (state EMA tests, evacuation, shelter-in-place) with polygons and SAME codes.
  - The newest `sent` was 2026-09-29T11:00Z at a 2026-09-30T11:25Z check, so about a **24 h lag**. It is HISTORICAL context for the `EMERGENCY` family.
  - Child Abduction Emergency messages carry personal descriptions and must be dropped.
  - Worth a follow-up evaluation.

---

## 5. Consolidated family mapping notes

- **CAD nature codes are unconfirmed at call time.** This covers Minneapolis 911 `Problem__Final_` and Ramsey `problem`. Map them to FIRE/HAZARD/TRAFFIC/POLICE/MEDICAL, and **never to `PROPERTY_INCIDENT`**.
- **`PROPERTY_INCIDENT` is reserved for confirmed post-incident records about a structure.** Today that means only Minneapolis Fire NFIRS 111, 112 and 120–123.
- **MEDICAL** exists only as aggregated `AREA` counts. No source's MEDICAL rows may be pinned.
- **Traffic sources** all map to TRAFFIC: IRIS, WZDx, 511 mirrors and GA511. The IRIS `INCIDENT_HAZARD` event type is the only one that maps to HAZARD.
- **Weather and geophysical** map to HAZARD (NWS Met, USGS). **Wildfire** maps to FIRE (WFIGS). Civil CAP maps to EMERGENCY.
- **Anything not listed** in the per-source rules → OTHER, never guessed.

---

## 6. Fixtures

All files are under `apps/api/tests/fixtures/public-safety/`.
- **Structure and field names are original.** ArcGIS files are the Esri JSON `f=json` envelope: `objectIdFieldName`, `uniqueIdField`, `globalIdFieldName`, `geometryType`, `spatialReference`, `fields`, `features`.
- **Several ArcGIS fixtures merge the features of several small `where=` queries into the first response's envelope,** to cover the category mix. `exceededTransferLimit` was removed from the merged envelope.
- **Redaction:** personal-information values are replaced with `"[redacted]"` and the field is kept.
- **Row selection:** rows were chosen at public places or hundred-block level where possible, so no residential exact address is committed.

| Path | Records | Redacted values | Source / selection |
|---|---|---|---|
| `mn_minneapolis_911_incidents/incidents_reported_911_sample.json` | 13 | 0 | `Incidents_Reported_911/0`: POLICE, FIRE and BCR; one `Latitude=0` (WITHHELD); `Is_City_Call='N'`; a disposition; one reclassified problem. |
| `mn_minneapolis_crime_data/crime_data_sample.json` | 11 | 0 | `Crime_Data/0`: NIBRS Property/Person/Society, ShotSpotter plus sound-of-shots, carjacking, domestic subset, GSW victims, `DID=Yes`. Includes deny-list categories for suppression tests. |
| `mn_minneapolis_police_incidents/police_incidents_2026_sample.json` | 9 | 0 | `Police_Incidents_2026/0`: latest, one intersection address, one BURGB. |
| `mn_minneapolis_mfd_calls_for_service/mfd_calls_for_service_sample.json` | 13 | 1 (`apartment_number`) | `MFD_Calls_For_Service/0`: alarms, gas leak, fires, MVAs, EMS at intersections only, cancelled en route. |
| `mn_minneapolis_mfd_fires/mfd_fires_sample.json` | 12 | 1 (`apartment_number`) | `MFD_Fires/0`: 111 building fires (multifamily, 1–2 family, care facility), 112 beyond origin, 113, 131, 151, 154, 143. |
| `mn_stpaul_crime_incidents/crime_incident_report_sample.json` | 13 | 0 | St. Paul table: one to two rows per `INCIDENT` value, including proactive visit, discharge and a domestic row. |
| `mn_ramsey_ecc_incidents/ecc_incident_data_sample.json` | 12 | 0 | SoQL, 2026-08-31 evening: SPPD, other police, MEDICAL, fire/alarm. |
| `mn_mndot_iris_incidents/incident_sample.xml` | 14 | 0 | Verbatim, decompressed `incident.xml.gz` at 11:55:32Z. Includes `replaces`, `cleared='true'`, `confirmed='true'` and a `!` lane impact. |
| `mn_mndot_wzdx/wzdx_feed_sample.json` | 15 | 4 (feed `contact_name`/`contact_email` ×2) | MN WZDx snapshot 11:14Z: a parent/detour pair, active with workers, all-lanes-closed, planned, pending, restrictions, speed limit, MultiPoint. |
| `mn_511_events_iowadot_mirror/cars511_mn_events_sample.json` | 14 | 0 | Two rows per `STYLE`. |
| `ga_atlanta_police_crime/opendata_crime_view_sample.json` | 12 | 0 | Non-residential `LocationType` and `GAFamilyViolenceIndicator='NO'` rows only. Includes a two-offence incident and the corrupt year-2124 `ReportDate` row. |
| `ga_511_events_gema_mirror/gdot_511_events_sample.json` | 12 | 0 | Three rows per `EventType`. **Terms unconfirmed**, so use for schema tests only. |
| `us_nws_alerts/alerts_active_area_MN_sample.json` | 3 | 0 | Verbatim `?area=MN` (zone-based, multi-state zones). |
| `us_nws_alerts/alerts_active_area_GA_sample.json` | 6 | 0 | Verbatim `?area=GA`. |
| `us_nws_alerts/alerts_active_national_subset_sample.json` | 7 | 0 | Five polygon alerts, the KEEPALIVE `Test`, and a zone-based `Update` with `references`. |
| `us_nws_alerts/zone_MNZ059_sample.json` | 1 | 0 | Verbatim `/zones/forecast/MNZ059` (Wright County polygon). |
| `us_usgs_earthquakes/all_hour_sample.json` | 7 | 0 | Verbatim `all_hour.geojson` (the complete response). |
| `us_nifc_wfigs_incidents/incident_locations_current_sample.json` | 12 | 3 (`IncidentShortDescription`) | MN wildfires and prescribed fires, GA RX, one CX complex. |
| `us_nifc_wfigs_perimeters/perimeters_current_sample.json` | 3 | 0 | The three smallest current perimeters (5 vertices each), all attributes. |
| `us_dot_wzdx_feed_registry/feed_registry_sample.json` | 15 | 0 | Registry rows for MN and 14 other keyless or placeholder-key feeds. Rows with embedded keys are excluded. |

No fixtures for:
- Hennepin County and Atlanta Fire: no source exists.
- GA511 API: key required.
- CARS-Hub: agreement required.
- The Minneapolis Tableau dashboard: not a feed.
- Atlanta `OnlineCADData`: PII exposure, excluded.
- `msvcMPD_ShootingCFS`: stale.
- OpenFEMA: not evaluated in depth.

---

## 7. Request hygiene and disclosures

- **User-Agent.**
  - Before the coordinator's note, every curl and Python request used `LeadCommand-Discovery (ops.leadcommand.ai)`, the string in the task brief.
  - After it, every request used `LeadCommand-Discovery (+https://ops.leadcommand.ai)`.
  - No email or personal data was ever sent.
  - Eight documentation pages were read with the WebFetch tool, which sends **its own User-Agent**, not ours: two weather.gov doc pages, two earthquake.usgs.gov pages, usgs.gov copyrights, dev.socrata.com app-tokens, mnit-rtmc.github.io incidents, and the opendata.atlantapd.org home page.
- **robots.txt.** robots.txt was not checked before the coordinator's rule. A retroactive audit of every non-API path we requested found:
  - **One disallowed non-API request.** A HEAD to `https://data.ramseycountymn.gov/`, which 302-redirected to `/login`; its robots.txt says `User-agent: * / Disallow: /`. One `/api/catalog/v1` call also went to that host. No data or fixture came from that host; all Ramsey data came from `opendata.ramseycountymn.gov`, which is allowed.
  - **`api.weather.gov` robots.txt is `User-agent: * / Disallow: /`.** Our requests there were to the documented NWS API: `/alerts/active` and `/zones/forecast/*`. **The four NWS fixtures come from those API paths.** We kept them because the NWS publishes this API for programmatic use and rule 2 exempts API paths. **If the coordinator reads rule 3 literally, delete `us_nws_alerts/*`.**
  - **`gis.hennepin.us` robots.txt is `Disallow: /`.** We made two ArcGIS REST directory requests (API paths, JSON). No fixture.
  - **Fetched before reading robots.txt, but not disallowed:** `511mn.org` (disallows only `/images/`) and `511ga.org` (disallows `/my511/`, `/map/map*/`, `/list/getdata/`, `/eventdetails/`, …). None of the paths we requested are disallowed.
  - **Everything else was allowed or had no robots.txt:** `highways.dot.gov` (robots itself returned 403), `services*.arcgis.com` and `www.fema.gov` (robots 403, API paths only), `data.dot.state.mn.us`, `earthquake.usgs.gov`, `www.weather.gov` and `www.minneapolismn.gov` (robots 404).
- **Undocumented or internal endpoints.**
  - **Atlanta `OnlineCADData`:** three metadata reads (service root, item, layer schema) plus the org's service list that revealed it. **Zero record requests.**
  - **511mn.org app JSON:** not used.
  - **IRIS XML:** documented by MnDOT's own IRIS project docs. It is labelled "needs terms confirmation" because no feed-specific licence exists.
- **Other.**
  - One public ArcGIS **user profile** was read to confirm the GEMA/HS affiliation of the GA511 mirror's owner. The returned name is not recorded here.
  - One irrelevant PDF (a Ramsey County procurement document containing staff contact details) was downloaded while looking for portal terms. It was **deleted and not used**.
  - A single keyless probe of `511ga.org/api/v2/get/event` returned 400. No attempt was made to obtain or bypass a key.

---

## 8. Unverified or open questions

- **Minneapolis refresh cadence.** Is the 911 / `Crime_Data` refresh really daily? No refresh was observed for Mon 9/28 or Tue 9/29. Re-check `dataLastEditDate` after 14:30Z on a weekday.
- **Minneapolis licence.** Does the CC0 statement cover `Crime_Data` and the MFD items, whose `licenseInfo` is blank?
- **`DID` in `Crime_Data`.** The meaning is undocumented.
- **Minneapolis 911 anonymisation.** No field distinguishes block-centre rows from block-group-centroid rows. Also unverified: whether the open dataset applies the same exclusions as the "911 Service Calls Dashboard" (child abuse, juvenile, CSC victims, protected parties).
- **IRIS coverage.** The geographic coverage is not documented; T.H.52 near Rochester appeared. The daily incident volume was not measured.
- **Terms not yet confirmed:**
  - Written confirmation for MnDOT IRIS XML.
  - Iowa DOT / MnDOT for the CARS511 mirror.
  - APD for its open data.
  - GDOT/GEMA for the GA511 mirror.
  - Ramsey County ECC.
  - The GA511 developer terms, which are only visible after registration.
- **USGS id semantics.** Whether the preferred `id` can change across updates was not verified from a live docs page; ComCat's field-definition page now redirects.
- **GA511 key-based event volume and exact update cadence** were not measurable without a key.
