# Desktop Map Property Card — Data Inventory

Inventory of fields available to the **desktop seller map card** (`SellerMapCard`), derived from:

- `apps/dashboard/src/lib/data/commandMapData.ts` — pin feed selects, detail merge (`loadCommandMapSellerPinDetail`)
- `apps/dashboard/supabase/migrations` — `v_command_map_seller_pin_feed`, `v_seller_work_items`, `inbox_thread_state`
- `apps/dashboard/src/views/map/seller-card/seller-map-card-view-model.ts` — view-model field reads
- `apps/dashboard/src/views/map/seller-card/seller-asset-presentation-registry.ts` — asset-class presentation

**Hydration pipeline**

1. **Pin load** — `get_command_map_seller_pins` RPC returns full `v_command_map_seller_pin_feed` rows (immediate on map render).
2. **Card detail** — On hover/select, `loadCommandMapSellerPinDetail` merges (with 6s timeouts per source):
   - `v_command_map_seller_pin_feed` (`COMMAND_MAP_SELLER_PIN_FEED_SELECT` + phone + identity sub-queries)
   - `inbox_thread_state` (`COMMAND_MAP_THREAD_STATE_SELECT` → `mapThreadStateRow`)
   - `v_seller_work_items` (phone/contact fallback)
   - `properties` + `master_owners` (property enrichment)
3. **Send-time** — Ownership-check / follow-up may call `resolveCommandMapSellerPhone`, `resolveCommandMapSellerIdentity`, `resolveMapOwnershipCheckForSend` (live `prospects` / `master_owners` lookups).

**Card sections**

| Section | Mode | UI location |
|---------|------|-------------|
| **Pin (map layer)** | — | Map marker color, pulse, ring (not inside card shell) |
| **Hover peek** | `peek` | Badges, identity, summary, peek metrics, intel strip (3 cells), contextual line, flags (≤3), activity |
| **Expanded dossier** | `focus` | Focus metrics, full intel strip, flags, activity, Property / Financial / Master Owner / Conversation & Automation grids |
| **Action footer** | `peek` / `focus` | Send Ownership Check / Follow Up + Message |
| **Composer** | `conversation` | Thread header, message list, `Composer` (templates, send, translate) |

**Hydration status legend**

| Status | Meaning |
|--------|---------|
| **yes (pin)** | On initial RPC pin payload |
| **yes (detail)** | Added/confirmed by `loadCommandMapSellerPinDetail` |
| **partial** | Available from some paths, degraded fallbacks, or merge gaps |
| **no** | Read by view-model or send code but not in hydration selects |

**Additional hydration needed** — `yes` if a dedicated query/source extension is required for reliable card display; `no` if already covered or computed client-side.

---

## 1. Identity

| Field | Table / Source | Meaning | Card Section | Asset Types | Fallback Behavior | Hydrated | More Hydration? |
|-------|----------------|---------|--------------|-------------|-------------------|----------|-----------------|
| `property_id` | `properties` → `v_command_map_seller_pin_feed` | Canonical property key | All (record key) | All | Required for pin; synthetic thread `property:{id}` if uncontacted | yes (pin) | no |
| `master_owner_id` | `coalesce(v_seller_work_items, properties)` → feed | Linked master owner | Focus (Master Owner), Composer, send | All | `threadState` → `sellerWorkItem` → `options.masterOwnerId` | yes (pin) | no |
| `prospect_id` | `v_seller_work_items` → feed | Linked prospect for SMS personalization | Composer, ownership-check send | All | `sellerWorkItemContact` → `sellerWorkItem` → `options.prospectId` | yes (pin) | no |
| `thread_key` | `coalesce(v_seller_work_items.thread_key, 'property:' \|\| property_id)` | Conversation thread identifier | Composer, follow-up eligibility | All | Synthetic `property:{property_id}` when no thread | yes (pin) | no |
| `owner_display_name` | `master_owners.display_name` via `v_seller_work_items` → feed | Master owner display name (card headline) | Peek / Focus identity header, Composer | All | `mo.display_name`; view-model chain also checks `owner_full_name`, `owner_name`, `entity_name` | yes (pin) | no |
| `owner_name` | `coalesce(properties.owner_name, mo.display_name)` → feed | Deed / record owner name | Identity fallback chain | All | Falls through to `owner_display_name` in `resolveMasterOwnerName` | yes (pin) | no |
| `owner_full_name` | `coalesce(prospects.full_name, prospects.first_name)` → feed | Prospect full name (owner-adjacent) | Identity fallback | All | Not used as SMS greeting name | yes (pin) | no |
| `entity_name` | feed (`null::text`) | Reserved entity label | — | All | Always `null` in current view | yes (pin, null) | no |
| `seller_display_name` | feed coalesce (prospect → owner → MO) | Seller-facing display (inbox parity) | Not directly rendered; `sanitizeSellerPinRecord` uses `resolveSellerPinDisplayName` | All | Coalesced in view; **not** in `COMMAND_MAP_SELLER_PIN_FEED_SELECT` detail query | partial (pin RPC only) | no — `owner_display_name` covers headline |
| `seller_name` | feed coalesce | Legacy seller label | Send template `owner_name` fallback chain | All | Same as `seller_display_name`; not in detail SELECT | partial (pin RPC only) | no |
| `property_address` | `coalesce(properties.property_address, property_address_full)` | Short situs address | Peek / Focus if `property_address_full` empty | All | → `property_address_full` | yes (pin) | no |
| `property_address_full` | feed coalesce (SWI → properties) | Full situs address | Peek / Focus / Composer header | All | → `property_address` → `"Property Unknown"` | yes (pin) | no |
| `property_address_city` | `coalesce(properties, v_seller_work_items.city)` | City | Composer state routing (secondary) | All | SWI city fallback | yes (pin) | no |
| `property_address_state` | `coalesce(properties, v_seller_work_items.state)` | State | Composer TextGrid routing | All | Parsed from address or market if missing | yes (pin) | no |
| `property_address_zip` | `coalesce(properties, v_seller_work_items.zip)` | ZIP | — | All | SWI zip fallback | yes (pin) | no |
| `market` | `coalesce(properties.market, v_seller_work_items.display_market)` | Human market label | Composer routing | All | `'Unknown'` in SWI | yes (pin) | no |
| `filter_market` | Same as `market` in current view | Filter dimension | — | All | Same coalesce as `market` | yes (pin) | no |
| `latitude` / `longitude` | `properties` → feed | Geo coordinates | Pin placement | All | Duplicated as `lat` / `lng` | yes (pin) | no |
| `lat` / `lng` | feed aliases | RPC / map compatibility | Pin placement | All | Mirror `latitude` / `longitude` | yes (pin) | no |
| `streetview_image` | `properties` | Google Street View URL | Peek / Focus hero image | All | → `map_image` → `satellite_image` → `buildStreetViewUrl(address)` | yes (detail) | no |
| `map_image` | `properties` | Static map image | Hero image fallback | All | Second in image chain | yes (detail) | no |
| `satellite_image` | `properties` | Satellite snapshot | Hero image fallback | All | Third in image chain | yes (detail) | no |

---

## 2. Property Physical

| Field | Table / Source | Meaning | Card Section | Asset Types | Fallback Behavior | Hydrated | More Hydration? |
|-------|----------------|---------|--------------|-------------|-------------------|----------|-----------------|
| `property_type` | `coalesce(properties.property_type, property_class)` → feed | Primary asset type label | Peek badge, summary line, asset inference | All | → `asset_class` → titleized `"Property"` | yes (pin) | no |
| `asset_class` | `coalesce(property_class, property_type)` → feed | Normalized class / subtype source | Asset registry input (`subtype`) | All | Swapped with `property_type` in view | yes (pin) | no |
| `property_class` | `properties.property_class` | Finer asset subtype | Focus Property Profile (`subtype`) | Commercial, MF | Read by `buildAssetInput` as `property_class` / `normalized_asset_class`; **not** in feed SELECT (only via `asset_class` coalesce) | partial | no — covered by `asset_class` / `property_type` |
| `total_bedrooms` | `properties` → feed | Bedroom count | SFR summary, MF totals, focus profile | SFR, MF 2–4 | Zero → null (`nullIfZeroish`) | yes (pin) | no |
| `total_baths` | `properties` → feed | Bathroom count | SFR / MF summary, focus profile | SFR, MF 2–4 | Zero → null | yes (pin) | no |
| `building_square_feet` | `properties` → feed | Building square footage | All built improvements | SFR, MF, commercial | Zero → null; drives `pricePerSqft`, avg/unit | yes (pin) | no |
| `units_count` | `properties` → feed | Unit count | MF, storage; drives asset class inference (≥5 → MF 5+) | MF, storage | Zero → null; ≥2 units triggers MF class | yes (pin) | no |
| `year_built` | `properties` → feed | Original construction year | Summary, focus profile | All with structure | Zero → null | yes (pin) | no |
| `lot_square_feet` | `properties` (feed + enrichment) | Lot size (sqft) | SFR / land focus profile | SFR, land | Pin feed value; enrichment may refresh | yes (pin) | no |
| `lot_acreage` | `properties` (feed + enrichment) | Lot acreage | Land, commercial contextual line | Land, retail, office, industrial | Zero → null; drives `valuePerAcre` | yes (pin) | no |
| `effective_year_built` | `properties` (enrichment) | Effective / rebuilt year | Intelligence strip, SFR summary | SFR (when ≠ `year_built`) | Detail query only | yes (detail) | no |
| `construction_type` | `properties` (enrichment) | Construction material | Intelligence strip, focus profile | SFR, MF 5+, commercial | Titleized for display | yes (detail) | no |
| `building_condition` | `properties` (enrichment) | Condition classification | Intelligence strip, focus profile | SFR, MF, commercial | → `"—"` if empty | yes (detail) | no |
| `stories` | `properties` (enrichment) | Story count | SFR contextual line, office profile | SFR, office | Zero → null | yes (detail) | no |
| `zoning` | `properties` (enrichment) | Zoning code | Land / commercial contextual + profile | Land, retail, office, industrial | Titleized in contextual line | yes (detail) | no |
| `land_use` | `properties.county_land_use_code` (enrichment map) | County land use code | Land focus profile; `occupancyLabel` fallback | Land | Mapped from `county_land_use_code` | yes (detail) | no |
| `occupancy_code` | — | Occupancy classification | Focus (`occupancyCode`) | Commercial | View-model reads; **not** in any hydration select | no | **yes** — add to property enrichment if needed |
| `road_access` | — | Road access type | Land summary / contextual | Land | View-model reads; **not** in hydration | no | **yes** — add to properties select if on schema |
| `vacant` / `is_vacant` | — | Vacancy flag | Flags (derived tag) | All | View-model boolean read; **not** in hydration selects | no | **yes** — if `properties` has column |
| `avgSqftPerUnit` | **computed** | `building_square_feet / units_count` | MF 5+ peek / focus | MF 2–4, 5+, storage | null if missing inputs | yes (computed) | no |
| `avgBedsPerUnit` | **computed** | `total_bedrooms / units_count` | MF contextual line | MF | null if missing inputs | yes (computed) | no |
| `avgBathsPerUnit` | **computed** | `total_baths / units_count` | MF contextual line | MF | null if missing inputs | yes (computed) | no |

---

## 3. Financial

| Field | Table / Source | Meaning | Card Section | Asset Types | Fallback Behavior | Hydrated | More Hydration? |
|-------|----------------|---------|--------------|-------------|-------------------|----------|-----------------|
| `estimated_value` | `properties` → feed | AVM / estimated value | Peek metrics, focus financials | All | Zero → null; primary metric | yes (pin) | no |
| `equity_amount` | `properties` → feed | Dollar equity | Peek metrics, focus financials | All | Zero → null | yes (pin) | no |
| `equity_percent` | `properties` → feed | Equity as % of value | Peek metrics, flags (High Equity / Free & Clear) | All | ≥65% → High Equity tag; ≥95% → Free & Clear | yes (pin) | no |
| `estimated_repair_cost` | `properties` → feed | Repair estimate | Peek metrics (SFR default), focus financials | SFR, unknown | Zero → null | yes (pin) | no |
| `final_acquisition_score` | `properties` → feed | Acquisition score | `render_priority` input | All | Zero → null | yes (pin) | no |
| `motivation_score` | feed `coalesce(structured_motivation_score, swi.priority_score, mo.priority_score)` | Motivation / structured score | Pin priority sampling | All | Used in RPC sort | yes (pin) | no |
| `priority_score` | feed coalesce (`final_acquisition_score`, motivation chain) | Combined priority for pins | Intelligence strip fallback, pin sort | All | Merged with `owner_priority_score` in detail | yes (pin) | no |
| `mortgage_balance` | `properties.total_loan_balance` (enrichment) | Outstanding loan balance | Focus financials, 4th peek metric (non-land/MF) | SFR, commercial | Mapped in `mapPropertyEnrichmentRow`; zero → hidden | yes (detail) | no |
| `loan_count` | `properties` (enrichment) | Number of loans | Focus financials | All | Zero → null | yes (detail) | no |
| `loan_type` | `properties` (enrichment) | Primary loan type | Focus financials | All | Empty → hidden | yes (detail) | no |
| `assessed_total_value` | `properties.assd_total_value` (enrichment) | Assessor total value | Focus financials, contextual (SFR) | SFR, land | Zero → field omitted | yes (detail) | no |
| `assessed_land_value` | `properties.assd_land_value` (enrichment) | Assessed land component | Focus financials | All | Zero → null | yes (detail) | no |
| `assessed_improvement_value` | `properties.assd_improvement_value` (enrichment) | Assessed improvement component | Focus financials | All | Zero → null | yes (detail) | no |
| `annual_taxes` | `properties.tax_amt` (enrichment) | Annual tax amount | Focus financials | All | Zero → field omitted | yes (detail) | no |
| `last_sale_amount` | `properties.saleprice` (enrichment) | Last recorded sale price | Focus financials | All | Zero → field omitted | yes (detail) | no |
| `last_sale_date` | `properties.sale_date` (enrichment) | Last sale date | Focus financials | All | Formatted date or `"—"` | yes (detail) | no |
| `pricePerSqft` | **computed** | `estimated_value / building_square_feet` | Financials object | SFR, commercial | null without value + sqft | yes (computed) | no |
| `pricePerUnit` | **computed** | `estimated_value / units_count` | MF 2–4 peek / focus | MF 2–4 | null without value + units | yes (computed) | no |
| `valuePerAcre` | **computed** | `estimated_value / lot_acreage` | Land peek / focus 4th metric | Land | null without value + acreage | yes (computed) | no |
| `cash_offer` | `v_seller_work_items` / `properties` | Internal cash offer | — | All | Exists in SWI view; **not** read by card VM | no | no (not used by card) |

---

## 4. Ownership / Master Owner

| Field | Table / Source | Meaning | Card Section | Asset Types | Fallback Behavior | Hydrated | More Hydration? |
|-------|----------------|---------|--------------|-------------|-------------------|----------|-----------------|
| `owner_type` | feed `coalesce(mo.owner_type_guess, Corporate/Individual from is_corporate_owner)` | Owner entity classification | Flags (corporate complexity), weighted tags | All | `"Individual"` default | yes (pin) | no |
| `ownership_years` | `properties` (enrichment) | Years of ownership | Focus Master Owner, long/mid-term tags | All | Zero → hidden | yes (detail) | no |
| `tax_delinquent` | `properties` (enrichment) | Tax delinquency flag | Flags, weighted tags | All | `true` only adds tag | yes (detail) | no |
| `absentee_owner` | `properties` (enrichment) | Absentee indicator | Focus Master Owner, flags | All | Yes/No/— tri-state | yes (detail) | no |
| `out_of_state_owner` | `properties` (enrichment) | Out-of-state owner flag | Focus Master Owner, flags | All | Yes/No/— tri-state | yes (detail) | no |
| `active_lien` | `properties` (enrichment) | Active lien flag | Flags, weighted tags | All | Boolean | yes (detail) | no |
| `mailing_address_full` | `master_owners.primary_owner_address` (enrichment) | Owner mailing address | Focus Master Owner | All | Also reads `owner_mailing_address` alias | yes (detail) | no |
| `property_count` | `master_owners.property_count` (enrichment) | Portfolio property count | Focus Master Owner (Portfolio), portfolio tag | All | Zero → hidden; ≥2 → Portfolio Owner tag | yes (detail) | no |
| `owner_priority_score` | `master_owners.priority_score` (enrichment) | MO priority score | Intelligence priority ring, classification | All | Detail merge: `propertyEnrichment` → `sellerWorkItem.priority_score` | yes (detail) | no |
| `owner_priority_tier` | `master_owners.priority_tier` (enrichment) | MO priority tier label | Priority ring classification | All | Text fallback | yes (detail) | no |
| `best_language` | `master_owners.best_language` (enrichment) | Owner language preference | Ownership-check send (`ownerLanguage`) | All | Defaults to `'English'` at send-time via `readMasterOwnerSendSignals` | partial (detail + send lookup) | no — send path re-fetches MO |
| `portfolio_total_value` | `v_seller_work_items` | MO portfolio value | — | All | In SWI view only; not read by card | no | no |
| `owner_property_count` | `v_seller_work_items` | Alias of portfolio count in SWI | — | All | Not mapped to card record | no | no |

---

## 5. Prospect / Contact

| Field | Table / Source | Meaning | Card Section | Asset Types | Fallback Behavior | Hydrated | More Hydration? |
|-------|----------------|---------|--------------|-------------|-------------------|----------|-----------------|
| `prospect_full_name` | `prospects.full_name` → feed (`COMMAND_MAP_SELLER_PIN_IDENTITY_SELECT`) | Prospect-only full name (SMS personalization) | Composer / ownership-check greeting | All | **Not** coalesced to MO name; null = unpersonalized | yes (detail) | no |
| `prospect_first_name` | `prospects.first_name` → identity select | Prospect first name | Ownership-check `seller_first_name` | All | First token used for greeting | yes (detail) | no |
| `sms_eligible` | `prospects.sms_eligible` → identity select | SMS eligibility gate | Composer template gate, weighted tag | All | `false` blocks name personalization; missing = unknown (not blocked) | yes (detail) | no |
| `prospect_language_preference` | `prospects.language_preference` → feed view (migration `20260705210000`) | Template language selection | Ownership-check template picker | All | On view but **not** in `COMMAND_MAP_SELLER_PIN_IDENTITY_SELECT`; preserved from pin RPC snapshot | partial (pin) | **yes** — add to identity SELECT for detail reliability |
| `agent_persona` | `master_owners.agent_persona` → identity select | Assigned SMS agent signal | Composer `agent_first_name` | All | null blocks send (`sender_identity_missing`) | yes (detail) | no |
| `agent_family` | `master_owners.agent_family` → identity select | Agent family name signal | Composer agent fallback | All | Second token in `resolveMapAgentFirstName` | yes (detail) | no |
| `canonical_e164` | feed phone coalesce → detail phone merge | Normalized dialable E.164 | Composer, follow-up, Has Phone tag | All | `resolveCommandMapSellerPhone` chain: feed → SWI → MO `best_phone_1` → prospect → `phones` | partial | no — phone resolver covers gaps |
| `seller_phone` | feed (same as canonical) | Seller phone alias | Composer display | All | Normalized in `sanitizeSellerPinRecord` | partial | no |
| `prospect_best_phone` | `coalesce(SWI, mo.best_phone_1)` → feed phone select | Best prospect phone | Phone picker | All | Part of phone merge | yes (detail) | no |
| `display_phone` | feed phone coalesce | UI display phone | Composer meta | All | `'No Phone'` string in view when missing | partial | no |
| `prospect_contact_score` | `prospects` | Contact quality score | Weighted tags (`strong_contactability`) | All | Read by `seller-weighted-tags`; **not** in hydration | no | **yes** if tag strip should be reliable |
| `prospect_phone_score` | `prospects` / phones | Phone quality score | Weighted tags | All | Same as above | no | **yes** |

**Live fallback resolvers** (not on card record until send):

| Resolver | Source tables | When used |
|----------|---------------|-----------|
| `resolveCommandMapSellerPhone` | feed, `v_seller_work_items`, `properties`, `master_owners`, `prospects`, `phones` | Follow-up / send when hydrated phone missing |
| `resolveCommandMapSellerIdentity` | `prospects`, `master_owners` | Stale cache / missing identity fields at send |
| `readMasterOwnerSendSignals` | `master_owners` | Ownership-check send (phone, agent, language) |

---

## 6. Thread / Contact State

| Field | Table / Source | Meaning | Card Section | Asset Types | Fallback Behavior | Hydrated | More Hydration? |
|-------|----------------|---------|--------------|-------------|-------------------|----------|-----------------|
| `seller_state` | `v_seller_work_items` derived → feed | Map pin conversation state | Pin color / pulse; state badges (via canonical mapper) | All | `not_contacted` default | yes (pin) | no |
| `seller_status` | `v_seller_work_items.status` → feed | Operational status alias | Canonical status input | All | `not_contacted` | yes (pin) | no |
| `execution_state` | `v_seller_work_items` queue-derived → feed | Outbound queue execution phase | Pin ring, focus automation, follow-up | All | `none` default; → `automation_state` in merge | yes (pin) | no |
| `inbox_category` | `v_seller_work_items` → feed; thread `inbox_bucket` | Inbox bucket / category | Messaging block check, follow-up due | All | Thread state overrides; `'not_contacted'` | yes (pin) + partial (detail) | no |
| `lifecycle_stage` | `inbox_thread_state.seller_stage` → `mapThreadStateRow` | Universal lifecycle stage | Peek badges, focus operations | All | Canonical normalizer; feed `seller_status` fallback | partial (detail) | no |
| `operational_status` | `inbox_thread_state.conversation_status` → mapper | Conversation operational status | Peek badges, activity | All | From thread state; `seller_status` fallback | partial (detail) | no |
| `lead_temperature` | `inbox_thread_state.lead_temperature` \|\| `temperature` | Deal temperature | Peek badges, edge accent | All | Normalized to hot/warm/cold | partial (detail) | no |
| `contactability_status` | — (derived) | Contactability enum | Focus Master Owner | All | Built from `suppression_status` / inbox category in canonical presenter | partial | no |
| `latest_message_at` | SWI → feed; thread state | Last message timestamp | Activity, focus operations | All | Thread overrides SWI in merge | yes (pin) | no |
| `latest_direction` | SWI → feed; thread state | Last message direction | Activity derivation | All | Drives inbound vs outbound text split | yes (pin) | no |
| `latest_message_body` | `inbox_thread_state` (thread select) | Last message text | Activity detail when direction matches | All | Mapped to `last_inbound_text` / `last_outbound_text` | yes (detail) | no |
| `inbound_count` | `message_events` aggregate → feed | Inbound message count | Composer thread meta | All | 0 default | yes (pin) | no |
| `outbound_count` | `message_events` aggregate → feed | Outbound message count | Follow-up prior-contact check | All | 0 default | yes (pin) | no |
| `queued_count` | `send_queue` aggregate → feed | Queued messages | — | All | 0 default | yes (pin) | no |
| `scheduled_count` | `send_queue` aggregate → feed | Scheduled messages | — | All | 0 default | yes (pin) | no |
| `ready_count` | `send_queue` aggregate → feed | Ready-to-send messages | — | All | 0 default | yes (pin) | no |
| `sent_count` | `send_queue` aggregate → feed | Sent messages | Prior-contact fallback | All | 0 default | yes (pin) | no |
| `delivered_count` | `send_queue` aggregate → feed | Delivered messages | — | All | 0 default | yes (pin) | no |
| `next_scheduled_for` | `send_queue` min scheduled → feed | Next scheduled send time | Focus operations → `next_action_at` | All | Merged into `next_action_at` | yes (pin) | no |
| `last_inbound_at` | `inbox_thread_state` | Last inbound timestamp | Activity, focus operations | All | Thread detail query | yes (detail) | no |
| `last_outbound_at` | `inbox_thread_state` | Last outbound timestamp | Activity, focus operations | All | Thread detail query | yes (detail) | no |
| `last_inbound_text` | **derived** from `latest_message_body` when direction=inbound | Last seller reply snippet | Activity (LAST REPLY) | All | Falls back to `latest_message_body` | yes (detail) | no |
| `last_outbound_text` | **derived** from `latest_message_body` when direction=outbound | Last outbound snippet | Activity (LAST CONTACTED) | All | Empty if last message inbound | yes (detail) | no |
| `delivery_status` | `inbox_thread_state.latest_delivery_status` | Last delivery outcome | Activity (DELIVERY FAILED), focus ops | All | Failed detection also checks `delivery_failed_at` (not hydrated) | partial (detail) | **yes** for failure detail fields |
| `suppression_reason` | `inbox_thread_state.suppression_status` | Suppression cause | Activity (SUPPRESSED), messaging block | All | Maps `suppression_status` → `suppression_reason` | partial (detail) | no |
| `follow_up_due_at` | `inbox_thread_state.follow_up_at` | Follow-up due timestamp | Focus operations, follow-up eligibility | All | Mapper reads `follow_up_at` but **`follow_up_at` not in `COMMAND_MAP_THREAD_STATE_SELECT`** | partial (broken select) | **yes** — add `follow_up_at` to thread SELECT |
| `next_action_at` | detail merge | Next scheduled action | Focus operations | All | `next_scheduled_for` \|\| `follow_up_due_at` | partial | **yes** — depends on `follow_up_at` fix |
| `automation_state` | detail merge from `execution_state` | Automation lane label | Focus operations, conversation meta | All | `execution_state` alias | yes (pin) | no |
| `campaign_name` | — | Active campaign name | Focus Conversation & Automation | All | View-model reads; **not** in any source | no | **yes** |
| `is_suppressed` | `inbox_thread_state` (selected, not mapped) | Thread suppression flag | Canonical messaging block | All | Selected in thread query; presenter uses `suppression_status` | partial | no |
| `is_urgent` | `inbox_thread_state` | Urgent flag | Weighted tags | All | Read by tags; **not** in hydration select | no | **yes** |
| `delivery_failed_at` | — | Delivery failure time | Activity failed state | All | View-model reads; not hydrated | no | **yes** |
| `delivery_error` / `failure_reason` | — | Delivery error message | Activity failed detail | All | Not hydrated | no | **yes** |

**`inbox_thread_state` columns queried** (`COMMAND_MAP_THREAD_STATE_SELECT`):  
`thread_key`, `property_id`, `master_owner_id`, `canonical_e164`, `seller_phone`, `lead_temperature`, `seller_stage`, `conversation_status`, `temperature`, `inbox_bucket`, `inbox_category`, `suppression_status`, `is_suppressed`, `latest_message_body`, `latest_message_at`, `latest_direction`, `last_inbound_at`, `last_outbound_at`, `latest_delivery_status`, `market`.

**`v_seller_work_items` contact select** (`SELLER_WORK_ITEM_PHONE_SELECT`):  
`prospect_id`, `prospect_best_phone`, `display_phone`, `master_owner_id`.

---

## 7. Tags / Signals

| Field | Table / Source | Meaning | Card Section | Asset Types | Fallback Behavior | Hydrated | More Hydration? |
|-------|----------------|---------|--------------|-------------|-------------------|----------|-----------------|
| `property_flags_text` | feed `coalesce(properties, seller_tags, mo.seller_tags)` | Comma/text flags | Flags, weighted tags | All | Parsed + titleized | yes (pin) | no |
| `property_flags_json` | feed coalesce | Structured flags JSON | Flags, weighted tags | All | Parsed via `parseTagValues` | yes (pin) | no |
| `property_tags_text` | feed (duplicate coalesce of flags) | Tag text alias | Flags | All | Same source as flags_text | yes (pin) | no |
| `property_tags_json` | feed coalesce | Tag JSON alias | Flags | All | Same as flags_json | yes (pin) | no |
| `podio_tags` | feed `coalesce(properties.podio_tags, seller_tags)` | Legacy Podio tags | Flags | All | Included in tag parser list | yes (pin) | no |
| **High Equity** | **derived** from `equity_percent` ≥ 65 | Strong equity signal | Flags (peek ≤3) | All | Client-side in `buildFlags` | yes (computed) | no |
| **Free And Clear** | **derived** from `equity_percent` ≥ 95 | No mortgage signal | Flags, focus Free & Clear | All | Client-side | yes (computed) | no |
| **Tax Delinquent** | `properties.tax_delinquent` | Distress tag | Flags | All | Enrichment + boolean | yes (detail) | no |
| **Absentee Owner** | `properties.absentee_owner` | Motivation tag | Flags | All | Enrichment | yes (detail) | no |
| **Out Of State Owner** | `properties.out_of_state_owner` | Motivation tag | Flags | All | Enrichment | yes (detail) | no |
| **Active Lien** | `properties.active_lien` | Distress tag | Flags | All | Enrichment | yes (detail) | no |
| **Vacant** | `vacant` / flags | Vacancy tag | Flags | All | Boolean or imported flag text | partial | **yes** for boolean source |
| Imported flag labels | `property_flags_*` | Probate, Tired Landlord, Foreclosure, etc. | Flags, weighted tags | All | `TAG_REGISTRY` + titleize fallback | yes (pin) | no |
| `sms_eligible` | prospects → identity | SMS Eligible tag | Weighted tags | All | Tag when `=== true` | yes (detail) | no |
| **Has Phone** | phone fields | Dialable phone present | Weighted tags | All | Client-side phone check | partial | no |
| **Portfolio Owner** | `property_count` ≥ 2 | Multi-property owner | Weighted tags | All | From enrichment | yes (detail) | no |
| **No Contact Yet** | thread / outbound | No prior outbound | Weighted tags | All | Derived from contact history | yes (computed) | no |
| **Unscored** | missing `owner_priority_score` | No MO score | Weighted tags | All | Client-side | yes (computed) | no |

---

## 8. Intelligence

| Field | Table / Source | Meaning | Card Section | Asset Types | Fallback Behavior | Hydrated | More Hydration? |
|-------|----------------|---------|--------------|-------------|-------------------|----------|-----------------|
| `render_priority` | feed computed `greatest(acquisition, motivation, state boosts)` | Map pin sort priority | Pin layer z-order | All | State-based floor scores (e.g. new_reply=98) | yes (pin) | no |
| `pin_color` | feed CASE on `seller_state` / `execution_state` | Pin fill color | Pin layer | All | Hex palette per state | yes (pin) | no |
| `pin_shape` | feed (`'circle'`) | Pin geometry | Pin layer | All | Static circle | yes (pin) | no |
| `pulse_style` | feed CASE on state / execution | Pin pulse animation | Pin layer | All | `none` / `pulse_soft` / `pulse_warning` | yes (pin) | no |
| `execution_ring_color` | feed CASE on `execution_state` | Queue ring color | Pin layer, `SellerMapCardPriorityRing` context | All | `transparent` when idle | yes (pin) | no |
| `owner_priority_score` | `master_owners.priority_score` (enrichment) | MO priority for ring | Intelligence strip priority ring | All | `UNSCORED` when null; classification via tier | yes (detail) | no |
| `owner_priority_tier` | `master_owners.priority_tier` | MO tier label | Priority ring classification | All | Text fallback | yes (detail) | no |
| `final_acquisition_score` | `properties` → feed | Acquisition model score | Priority / pin sort | All | Feeds `render_priority` | yes (pin) | no |
| `motivation_score` | feed coalesce | Motivation / structured score | Pin inventory sort | All | Secondary to `priority_score` | yes (pin) | no |
| `priority_score` | feed coalesce | Combined priority | Intelligence strip numeric fallback | All | Shown when ring score null | yes (pin) | no |
| `building_condition` | properties enrichment | Condition in intel strip | Intelligence strip | All | See Property Physical | yes (detail) | no |
| `effective_year_built` | properties enrichment | Effective year in intel strip | Intelligence strip | All | See Property Physical | yes (detail) | no |
| `construction_type` | properties enrichment | Construction in intel strip | Intelligence strip | All | Titleized | yes (detail) | no |
| `edgeAccent` | **derived** | Activity + temperature accent | Card left edge color | All | suppressed / failed / due / hot / reply / default | yes (computed) | no |
| `contextualLine` | **computed** per asset class | Asset-specific secondary line | Peek / Focus below intel | All | `buildContextualLine` → registry | yes (computed) | no |
| `assetSummaryLine` | **computed** per asset class | Primary physical summary | Peek / Focus under identity | All | `buildSummaryLine` → registry | yes (computed) | no |
| `peekMetrics` | **computed** per asset class | 3 primary financial/physical metrics | Peek metrics row | Per asset registry | 4th focus metric appended in focus mode | yes (computed) | no |
| `focusMetrics` | **computed** | Peek metrics + 4th asset-specific metric | Focus metrics row | Land: Value/Acre; MF 2–4: PPU; MF 5+: Avg Sqft/Unit; else Mortgage | yes (computed) | no |
| `intelligenceStrip` | **computed** | Condition, Effective Built, Construction, Priority | Peek / Focus intel section | All | Fixed 4-cell layout | yes (computed) | no |

---

## Detail Merge Order (`loadCommandMapSellerPinDetail`)

```
merged = sellerWorkItem (feed)
       ∪ identityFields (prospect/agent identity)
       ∪ threadState (inbox_thread_state mapped)
       ∪ sellerWorkItemContact (SWI phones)
       ∪ propertyEnrichment (properties + master_owners)
       ∪ overrides: property_id, thread_key, master_owner_id, prospect_id,
                     owner_priority_score, priority_score, next_action_at, automation_state
```

Pin snapshot is preserved for fields the detail query omits (e.g. `prospect_language_preference`, `seller_display_name`) via `{ ...pinSnapshot, ...detail }` in `InboxCommandMap.hydrateSellerMapCard`.

---

## Key Findings Summary

### Well hydrated (pin + detail)

- **Core identity & address** — `property_id`, `master_owner_id`, `owner_display_name`, full address, market, coordinates.
- **Physical & financial basics** — beds/baths/sqft/units/year/lot, `estimated_value`, equity, repairs, scores (from pin feed).
- **Property dossier enrichment** — images, condition, construction, tax/lien flags, assessed values, sale history, MO mailing/portfolio (detail query).
- **Prospect send identity** — `prospect_full_name`, `prospect_first_name`, `sms_eligible`, `agent_persona`, `agent_family` (isolated identity query).
- **Thread activity** — latest message timing/direction/body, inbound/outbound counts, suppression, delivery status (partial).
- **Tags** — `property_flags_*`, `podio_tags`, derived equity flags.
- **Pin rendering** — color, pulse, ring, `render_priority`.

### Partial hydration (gaps / fallbacks)

| Gap | Impact |
|-----|--------|
| `follow_up_at` not in `COMMAND_MAP_THREAD_STATE_SELECT` | Follow-up due date / eligibility may miss thread-scheduled follow-ups |
| `prospect_language_preference` not in detail identity SELECT | Language template selection relies on pin RPC snapshot or live MO/prospect fetch at send |
| Phone fields split across 3 queries | Works but degrades silently if migrations pending |
| `delivery_failed_at` / `delivery_error` never hydrated | Failed delivery activity shows generic message |
| `campaign_name` not sourced | Conversation & Automation section omits campaign row |
| `occupancy_code`, `road_access`, `vacant` not in enrichment | Asset-specific focus/context fields stay empty |
| `is_urgent`, contact scores not on record | Weighted tag strip incomplete |

### Needs additional hydration (recommended)

1. Add `follow_up_at` to `COMMAND_MAP_THREAD_STATE_SELECT` (mapper already expects it).
2. Add `prospect_language_preference` to `COMMAND_MAP_SELLER_PIN_IDENTITY_SELECT`.
3. Add `campaign_name` source (likely `send_queue` / campaign join) if ops section should be complete.
4. Add `vacant`, `occupancy_code`, `road_access` to `COMMAND_MAP_PROPERTY_ENRICHMENT_SELECT` if present on `properties`.
5. Add `is_urgent`, `delivery_failed_at`, `latest_failure_reason` (or equivalent) to thread SELECT for activity accuracy.
6. Optional: `prospect_contact_score` / `prospect_phone_score` for weighted tag confidence.

### Send-time vs card-time

Ownership-check and follow-up actions **re-fetch** `master_owners` (phone, agent, language) and may call `resolveCommandMapSellerPhone` / `resolveCommandMapSellerIdentity` even when the card record is thin — so composer/send can succeed while the **dossier display** still shows gaps above.

---

*Generated from repo state as of 2026-07-08. Sources: `commandMapData.ts`, migrations `20260705210000`, `20260705120000`, `20260704120000`, `20260518220500`, `seller-map-card-view-model.ts`, `seller-asset-presentation-registry.ts`.*