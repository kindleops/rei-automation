# Nexus Command Center — Master Project Context

## 0. Purpose of This File

This file is the source of truth for the Nexus Dashboard / REI Automation build.

Use this file to preserve project flow, reduce token usage, and keep Claude Code, Codex, and ChatGPT aligned across sessions.

When starting a new AI coding session, read this file first and follow it unless Ryan explicitly overrides it.

This file should be treated as project memory, product direction, UI design standard, architecture guardrail, and current-task alignment.

---

# 1. Project Identity

Project name: **Nexus Dashboard / Acquisition Command Center**

This is an AI-powered real estate acquisition operating system.

The product is evolving from a basic inbox/dashboard into a full **Acquisition Command Center** where seller conversations, properties, owners, SMS/email, maps, comps, buyer matching, underwriting, queue status, pipeline movement, timeline, and AI conversation memory all connect in one operational system.

The main operating shell is:

> **Inbox**

Do not create separate apps unless explicitly requested.

Inbox is the main command surface.

---

# 2. Core Product Vision

The system should help Ryan answer:

1. Who replied?
2. What property are they attached to?
3. What owner / seller / prospect / phone / email records are linked?
4. What stage is the conversation in?
5. What is the seller saying?
6. Is automation safe to continue?
7. What is the property worth?
8. What should we offer?
9. What comps support the offer?
10. Who would buy the deal?
11. What is the next operational move?
12. What is queued, blocked, sent, failed, or waiting?
13. What follow-up or calendar event needs action?

The long-term goal is a real estate acquisition engine that can automate outreach, classify seller replies, queue follow-ups, run comps, match buyers, generate offers, and push deals through contract/title/closing workflows.

This system should eventually operate like an acquisition cockpit, not a normal CRM.

---

# 3. Current Product Direction

Inbox is becoming the central operating application.

Do not create a separate Deal Command app right now.

Instead, evolve the existing Inbox into the central **Acquisition Command Center** where these pieces connect:

- seller threads
- property records
- master owners
- prospects
- phone numbers
- emails
- SMS thread
- email thread
- maps
- comps
- buyer matches
- underwriting
- offers
- contracts
- title / closing workflow
- queue status
- timeline/calendar
- AI conversation brain
- automation controls

Every seller conversation should be able to open a full-screen or partial-screen Command View / Deal Intelligence View.

---

# 4. Core App Shell

Inbox remains the main route/application shell.

Internal views include:

- Inbox Thread View
- List View
- Deal Intelligence
- Command Map
- Pipeline View
- Queue View
- Calendar View
- Metrics View
- Comp Intelligence
- Buyer Match

Important:

These are internal views inside the Inbox shell, not separate standalone apps unless explicitly requested later.

The view dropdown controls which internal workspace is active.

The view percentage dropdown controls how much of the screen/workspace that view occupies.

View percentages are layout modes, not just squeezed widths.

---

# 5. Current Active Frontend Focus

Current priority:

> Frontend UI/UX redesign section-by-section.

Do not redesign entire views in one uncontrolled pass.

Current working method:

1. Redesign one section only.
2. Run build.
3. Verify responsive behavior.
4. Screenshot / review.
5. Move to next section.

Current immediate focus:

> Fix 50% and 75% responsive layout behavior for Deal Intelligence and List View.

Known state:

- 25% works as compact preview.
- 100% mostly works.
- 50% and 75% are not correct.
- 50% and 75% currently behave like squeezed/overflowed layouts instead of intentionally designed modes.

---

# 6. Current Task

## Fix only the 50% and 75% responsive layout behavior for Deal Intelligence and List View.

Preserve:

- 25% compact mode
- 100% full mode

Do not break either.

Do not touch backend automation, SMS, TextGrid, queue, suppression, webhooks, or database mutation logic.

Treat:

- 25%
- 50%
- 75%
- 100%

as explicit layout modes, not simple CSS compression.

Desired behavior:

## 25% Mode — Compact Preview

25% currently works. Preserve it.

Should show:

- compact deal capsule
- address/seller
- score
- key chips
- small media preview
- open full deal action

Do not cram desktop UI into 25%.

## 50% Mode — Focused Work Panel

This should not show full Deal Intelligence squeezed into a narrow side panel.

For Deal Intelligence at 50%:

- use a focused vertical composition
- compact header
- address/seller/score/key chips
- primary action
- media section should be large enough to use
- street view on top
- aerial as small companion below or tabbed
- hide secondary modules or put them behind tabs
- bottom command dock must not overlap content

For List View at 50%:

- use card/feed layout, not full wide table
- each card should show:
  - seller
  - property
  - status/stage
  - priority/intent
  - automation
  - last message
  - last activity
- do not render full 10-column table
- avoid tiny unreadable text

## 75% Mode — Split Command Workspace

For Deal Intelligence at 75%:

- use near-full composition but tighter
- header can remain command-style but compressed
- media can use split mode if width supports it
- Street View large left
- Aerial/Parcel right
- if not enough width, stack media cleanly
- decision/score rail should remain readable
- no clipped controls
- no command dock overlap

For List View at 75%:

- use hybrid table/card layout
- show more columns than 50%, but not full ultra-wide table if cramped
- suggested columns:
  - seller
  - property
  - status
  - stage
  - priority
  - intent
  - automation
  - last
- message preview can be secondary/collapsed if needed
- right side should not have giant empty space

## 100% Mode — Full Desktop

Preserve current full behavior unless changes cause regressions.

---

# 7. Critical Layout Rule

View percentages are explicit layout modes.

Do not rely only on raw CSS container width.

Use the selected layout mode / view percent if available.

Preferred internal naming:

- isCompact25
- isPanel50
- isWorkspace75
- isFull100

Or class patterns:

- layout-mode-25
- layout-mode-50
- layout-mode-75
- layout-mode-100

Suggested Deal Intelligence mental model:

- 25 = DealCompactCard
- 50 = DealFocusedPanel
- 75 = DealWorkspace
- 100 = DealFullCockpit

Suggested List View mental model:

- 25 = ListPreview
- 50 = ConversationCards
- 75 = HybridOperationalTable
- 100 = FullOperationalTable

Do not squeeze the 100% desktop layout into 50%.

Do not let the left Deal Dossier panel and right List View fight for space.

---

# 8. Non-Negotiable Automation Safety Rules

Do not modify backend automation unless Ryan explicitly asks.

Never change these unless specifically requested:

- TextGrid routing
- SMS sending logic
- queue runner
- suppression logic
- opt-out / DNC behavior
- webhook logic
- database mutation behavior
- outbound compliance behavior
- delivery webhook handling
- inbound webhook handling
- automatic reply logic
- send queue mutation logic

Frontend/UI work should preserve automation behavior.

The system is live or near-live and handles real seller communications.

Do not break revenue-critical flows.

---

# 9. Data Field Rules

Use actual existing fields from `inbox_thread_state` where available:

- status
- stage
- priority
- automation_state
- automation_status
- is_hot_lead
- is_suppressed
- last_intent
- next_action

Do not invent or use nonexistent fields:

- inbox_bucket
- current_status
- current_stage
- temperature

If the code already has legacy derived concepts, do not introduce new fake fields. Use existing derivations carefully and name them clearly.

---

# 10. Fallback Rules

Use safe fallbacks.

## Seller Name

Priority:

1. owner_display_name
2. owner_name
3. prospect_name
4. contact_name
5. seller_name
6. “Unknown Seller”

## Address

Priority:

1. property_address_full
2. property_address
3. address
4. situs_address
5. full_address
6. “Property Unknown”

## Market

Priority:

1. market
2. displayMarket
3. city/state
4. property_address_city/property_address_state
5. if ZIP or county exists, hide market instead of showing noisy fallback
6. “Market Pending” only if completely geo-blind

## ZIP

Priority:

1. property_address_zip
2. zip
3. postal_code
4. zip_code
5. “ZIP Pending”

## County

Priority:

1. property_address_county_name
2. county
3. county_name
4. “County Pending”

## Phone

Priority:

1. best_phone
2. seller_phone
3. phone
4. primary_phone
5. phone_e164

## Property Type

Format raw values into human labels.

Examples:

- sfh → Single Family
- single_family → Single Family
- multifamily → Multi-Family
- multi_family → Multi-Family
- duplex → Duplex
- triplex → Triplex
- quadplex → Quadplex
- apartment → Apartments
- apartments → Apartments
- land → Land
- commercial → Commercial
- storage → Self Storage
- other → hide or use clean fallback

Do not leak raw category codes into the UI.

Missing data should be hidden gracefully.

Do not render ugly null/undefined.

Do not spam “Not enriched” everywhere.

---

# 11. Current Data / Architecture Context

Core data tables/entities:

- inbox_thread_state
- message_events
- send_queue
- properties
- master_owners
- prospects
- phone_numbers
- emails
- markets
- zip_codes
- textgrid_numbers
- templates
- buyer_match
- offers
- contracts
- contract_templates
- title_companies
- closings
- ai_conversation_brain
- buyer tables / recently sold property buyer comps
- title / closing-related tables later

The system has a historical thread-state rebuild system that can classify / repair inbox state from message history.

The inbox state rebuild should be run safely in batches, not huge single blocking runs.

---

# 12. Current Backend Status Context

Recent thread-state rebuild status:

- API route for inbox thread-state rebuild exists.
- Script supports dry-run/apply.
- Large all-at-once runs can timeout.
- Iterative batch mode works better.
- Dirty/inconsistent rows were found and updated in batches.
- Batch rebuild successfully inspected 1123 and updated 544 rows in a recent run.
- 25/50/75/100 UI layout fixes are separate from backend thread-state repair.

Important:

Frontend design tonight should not get lost in backend rebuild work.

---

# 13. Design System Direction

The UI should feel like:

- premium acquisition cockpit
- cinematic
- dark glass
- dense but clean
- operational
- animated but not cheesy
- high-readability
- optimized for 49-inch ultrawide
- responsive for laptop
- not generic SaaS dashboard slop

Default system theme for now:

## Nexus Dark / Command Dark

- dark navy / graphite base
- cyan-blue operational accents
- green for automation/safe
- amber for priority/warning
- red only for destructive/risk/suppressed/DNC
- minimal glow
- high contrast
- expensive feel

Do not assume Red Ops is system-wide.

Red Ops currently only exists for map or future theme direction.

Do not make red/orange the dominant default visual language unless the specific state is risk/destructive/suppressed/hot.

Avoid:

- generic dashboard cards
- random filler charts
- huge empty dark spaces
- repeated AI copy
- repeated “Next Best Action” sections
- walls of buttons
- static lifeless panels
- tiny unreadable labels
- overuse of pills/badges
- sliver-sized media
- duplicated address/title blocks
- raw fallback values
- “AI slop” sections that do not add operational value

Every section needs clear hierarchy and purpose.

---

# 14. Animation / Motion Direction

The system should feel alive, but not cheesy.

Use subtle motion:

- soft fade/slide entry
- hover lift
- ring progress animation
- score count-up if already supported
- subtle pulse for live/active states
- animated accent line
- map marker pulse
- smooth tab transitions
- gentle dock hover/press states

Avoid:

- heavy constant animations
- particles everywhere
- over-glow
- performance-heavy animation
- motion that distracts from operations
- fake futuristic junk

Motion should communicate operational state, not just decoration.

---

# 15. Deal Intelligence Vision

Deal Intelligence should become the main property-level command screen.

It should include:

- Deal Command Header
- large Street View
- large Aerial / Parcel Context
- property facts
- offer engine
- comp intelligence
- buyer matching
- market / zip intelligence
- seller conversation brain
- contact / ownership / property / prospect / phone / email intelligence
- timeline / calendar
- slim action dock

The page should answer:

1. What is this property?
2. Who owns it / who are we talking to?
3. Is this a deal?
4. What should we offer?
5. What comps support it?
6. Who can buy it?
7. What should we do next?
8. Is automation safe?

---

# 16. Deal Intelligence Header Status

Header has already been rebuilt into a better architecture.

Current header direction:

- Zone A: Deal identity
- Zone B: Workflow chips
- Zone C: Decision rail
- Minimal primary actions

Header is now mostly locked.

Do not keep rebuilding the header unless specifically asked.

Known header improvements already applied:

- new `DealCommandHeader`
- removed old `CommandHeaderStrip`
- better large address hierarchy
- compact metadata row
- property type formatting map
- one deal score ring
- compact confidence/data rail
- removed `...` ghost button
- toned down red glow
- tightened header height
- market fallback logic improved

Do not regress these.

---

# 17. Deal Intelligence Header Requirements

If header is touched later, it must preserve this structure:

## Zone A — Deal Identity

- eyebrow: DEAL COMMAND DOSSIER
- large property address
- seller / owner name
- metadata row:
  - market
  - ZIP
  - county
  - phone
  - asset class if available

## Zone B — Workflow State

Compact chips:

- status
- stage
- priority
- automation status
- last contact
- hot lead if true
- unread if present
- suppressed if true

## Zone C — Decision Rail

- one main deal score ring only
- compact confidence metric
- compact data confidence metric
- one short acquisition state line

Do not include:

- giant Next Best Action card
- repeated AI recommendation block
- multiple oversized score cards
- filler text

## Header Actions

Only show five primary actions:

- Draft Reply
- Run Underwriting
- Open Comps
- Show Buyers
- Pause Auto

Suppress / DNC should be de-emphasized or moved into safety menu if needed.

Header height target:

- 100% / 75%: about 190–240px
- 50%: can wrap cleanly
- 25%: compact capsule only

Header must remain structurally different from the original bad version.

---

# 18. Street / Aerial Hero Vision

Street / Aerial is the next major visual leverage area after header.

The media section should feel like the visual command center of the deal.

Requirements:

- Street View should be dominant in Split mode.
- Aerial should be a useful companion, not a tiny afterthought.
- Keep modes:
  - Split
  - Street
  - Aerial
  - Parcel Context
- In 100% and 75%, Split mode should show large Street View left and Aerial/Parcel context right if space supports.
- In 50%, stack cleanly.
- In 25%, show compact media preview only.
- Move property facts into a clean integrated overlay or side rail.
- Avoid scattered floating badges.
- Add premium controls for:
  - Zillow
  - Maps
  - Realtor
  - County Records if available
- Keep text readable over media.
- Avoid badge clutter.
- Avoid huge empty black areas.
- Street and Aerial should never become useless slivers.

---

# 19. Offer / Decision Engine Vision

Offer engine should feel like underwriting command logic, not random charts.

It should show:

- AI recommended offer
- offer range
- walkaway
- ARV
- investor exit
- repair estimate
- target spread
- MAO
- confidence
- reason codes
- pursue / review / pass signal

Avoid:

- generic filler charts
- repeated “AI recommended” copy
- giant empty cards
- action button walls

The offer engine should clearly answer:

> What can we pay and why?

---

# 20. Comp Intelligence Vision

Comp Intelligence should include:

- actual comp map
- subject property marker
- recently sold comp markers
- retail MLS comp layer
- investor/off-market buyer comp layer
- sold price labels directly on map when useful
- heat signals
- filter dropdown
- comp table/cards
- include/exclude controls
- similarity score
- ARV calculation
- offer range

Retail MLS comps:

- blue/white sold-price chips
- used for ARV / retail valuation

Investor buyer comps:

- green/gold sold-price chips
- used for buyer demand / exit range

Include MLS and off-market for investor comps when available.

Retail comps should generally prioritize MLS/retail-clean data, with off-market retail as secondary if clearly useful.

Do not dump 23,000 markers at once without clustering/tiling/filtering.

For large comp datasets:

- cluster markers
- load by viewport
- filter by radius/type/date
- use heat maps
- use price labels only at useful zoom levels
- avoid DOM/map performance issues

---

# 21. Buyer Matching Vision

Buyer Matching should become a dispo intelligence module.

It should include:

- buyer demand score
- top buyer matches
- recent purchases
- avg buy
- max buy
- market/zip focus
- asset class fit
- price fit
- velocity fit
- buyer behavior signals
- match score
- reason why buyer fits
- actions:
  - generate dispo packet
  - highlight purchases
  - add to buyer blast
  - view buyer card

Buyer cards should look different from seller cards.

Seller card visual language:

- communication / acquisition / motivation

Buyer card visual language:

- demand / purchase history / liquidity / dispo fit

Buyer map markers should not look the same as seller pins.

Consider:

- sold price labels
- buyer acquisition chips
- green/gold demand markers
- clustered purchase zones
- heat layers

---

# 22. Seller Conversation Brain Vision

Seller / AI Conversation Brain should not feel like a huge AI slop panel.

It should answer:

- what the seller said
- what stage they are in
- what intent was detected
- what emotion/sentiment exists if available
- what the next reply should accomplish
- whether automation is safe
- what context matters from prior conversation

Avoid:

- long generic AI paragraphs
- repeated next-best-action sections everywhere
- giant urgency bars with no meaning
- huge badge bubbles
- filler buttons

Good structure:

- latest inbound
- latest outbound
- detected intent
- stage path
- automation recommendation
- suggested reply strategy
- concise conversation summary
- reply draft access

---

# 23. Contact / Ownership Intelligence Vision

This section should include all linked data:

- property
- owner
- prospect
- phone
- email
- master owner
- portfolio
- financial
- ownership
- contactability

It should look visually different from other sections.

Do not make it another generic grid of flat cards.

It should feel like an intelligence dossier.

Possible tabs:

- Prospect
- Owner
- Portfolio
- Financial
- Property
- Phones
- Emails

Should show:

- name
- age if available
- language
- gender if available
- marital status
- education
- occupation
- household income
- net asset value
- buying power/risk
- phone number
- carrier
- phone tags
- email data
- linked properties
- ownership years
- absentee/corporate flags
- motivation tags

Missing fields should not spam “Not enriched.”

---

# 24. Timeline / Calendar Vision

Automation Timeline should look better and possibly include a calendar.

Timeline should include:

- first touch
- seller replied
- intent classified
- stage changed
- AI underwriting complete
- offer drafted
- SMS sent
- follow-up scheduled
- follow-up due
- contract sent
- title events later

Calendar should show:

- follow-ups
- scheduled replies
- offer deadlines
- contract/title events
- seller appointments if added

Timeline should feel operational and alive, not a boring list.

---

# 25. Bottom Command Dock Vision

The command dock should be slim and useful.

It should not overlap content.

At 50%:

- dock should be compact
- can wrap into two rows only if needed
- should be positioned after content or sticky within the panel without covering media
- no absolute overlay on top of Street/Aerial

At 75% and 100%:

- slim dock can be sticky if it does not cover content
- add bottom padding to scroll container equal to dock height if sticky

Core command groups:

## Communication

- Draft Reply
- Send SMS
- Send Email

## Analysis

- Run Underwriting
- Open Comp Workspace
- Show Buyer Matches

## Navigation

- Open Map
- Open Dossier
- AI Assist

## Safety

- Pause Automation
- Suppress
- DNC

But do not show giant button walls in every section.

The system is automated. The dock is for intervention and command control.

---

# 26. Pipeline View Vision

Pipeline should be rebuilt from scratch later.

It should not look like generic Trello.

Stages:

- Ownership Check
- Interest Probe
- Active Communication
- Price Discovery
- Condition Details
- Offer Stage
- Negotiation
- Contract Sent
- Title / Closing
- Dead / Suppressed

Cards should include:

- seller/owner
- property address
- market
- status
- stage
- priority
- last_intent
- next_action
- last message time
- hot/suppressed/unread/automation badges
- value/equity/repairs when available

Responsive behavior:

## 25%

Compact vertical stage preview.

## 50%

Focused kanban/feed with fewer columns.

## 75%

Multi-column pipeline with scroll.

## 100%

Full command pipeline with stage metrics and rich cards.

Pipeline should feel like deal flow, not a basic board.

---

# 27. Queue View Vision

Queue should become the SMS automation launch/control tower.

Groups:

- Ready To Send
- Scheduled
- Sending Now
- Sent
- Delivered
- Failed
- Blocked
- Review Required
- Auto-Blocked
- Replied Before Send
- Suppressed
- Paused

Should show:

- seller
- property
- market
- queue status
- automation status
- scheduled time
- routing number
- template
- agent
- message preview
- blocked/failed reason
- next action

Responsive behavior:

## 25%

Queue summary / mini status.

## 50%

Queue cards/feed.

## 75%

Hybrid queue table.

## 100%

Full queue control table with metrics.

Queue should not look like basic rows with four fields.

It should feel like an automation control tower.

---

# 28. Command Map Vision

Command Map should include seller threads, buyer data, and comp layers.

Layers may include:

- seller reply pins
- hot lead pins
- waiting pins
- suppressed pins
- recently sold retail comps
- investor buyer comps
- buyer activity heat
- ZIP/market boundaries
- property clusters
- route/local number coverage later

Map modes:

- Dark
- Satellite
- Red Ops for map only
- 2D
- 3D later

Map controls must be scrollable/clickable and never hidden behind the live ticker/action strip.

The bottom live activity ticker should not cover map controls.

Selecting a pin should update the selected inbox thread/property and allow opening Command View / Deal Intelligence.

---

# 29. List View Vision

List View should become an operational conversations view.

It should support multiple density modes:

- Comfortable
- Compact
- Ultra Compact

It should respond to view percentage:

## 25%

Compact preview / mini list.

## 50%

Card/feed layout.

Each card should show:

- seller
- phone if useful
- property
- status/stage
- priority
- intent
- automation
- next action
- last message
- last activity
- hot/unread/suppressed flags

## 75%

Hybrid table/card.

Suggested columns:

- seller
- property
- status
- stage
- priority
- intent
- automation
- last

Message preview can be secondary/collapsed.

## 100%

Full operational table.

Can include:

- seller
- property
- market
- status
- stage
- priority
- intent
- next action
- automation
- message
- last
- flags

Do not render full ultra-wide table in 50%.

Do not make text unreadable.

---

# 30. Inbox Thread View Vision

Inbox Thread View should focus on conversation execution.

It should include:

- selected thread list
- SMS conversation
- owner/property summary
- stage/status
- next action
- quick actions
- offer snapshot
- buyer match snapshot
- AI conversation brain snapshot

Responsive behavior should be intentional by mode.

At 50%, conversation should not become tiny.

At 75%, conversation and side intelligence can split.

At 100%, full operational view can show more panels.

---

# 31. Metrics View Vision

Metrics mode should show inbox KPIs:

- new replies
- hot leads
- waiting on seller
- suppressed
- follow-ups due
- reply rate
- positive intent rate
- stop rate
- delivery rate
- failed sends
- template performance snapshot
- queue throughput
- automation blocks
- review required

Metrics should be operational and actionable, not generic dashboard filler.

---

# 32. Calendar View Vision

Calendar mode should show:

- follow-ups
- seller events
- scheduled replies
- offer deadlines
- contract/title events
- manual reminders
- queue windows

It should connect to seller threads and selected properties.

Clicking an event should open the relevant thread/deal.

---

# 33. Theme Direction

Do not build full system-wide themes yet.

Right now, use one premium default:

## Nexus Dark / Command Dark

Later possible themes:

1. Nexus Dark
2. Red Ops
3. Satellite
4. Executive

Important:

If adding theme tokens later, themes should modify accents and surfaces, not completely change layout.

Do not create four versions of bad UI.

First build elite default UI.

Then theme it.

---

# 34. Claude Code Workflow

For Claude Code:

- Use terminal Claude Code when possible.
- Use `frontend-design` skill if available.
- Use `webapp-testing` skill if available.
- Work section-by-section.
- Do not redesign unrelated sections.
- Before coding, inspect files and state planned edits.
- Run `npm run build`.
- If possible, verify 25/50/75/100 views with browser screenshots.

Preferred Claude workflow:

1. Read this file and AGENTS.md.
2. Confirm current task.
3. Inspect relevant files.
4. Report file plan.
5. Wait if asked.
6. Implement only scoped change.
7. Run build.
8. Summarize changed files and structural changes.

---

# 35. Codex Workflow

For Codex:

- Read and follow `AGENTS.md`.
- Use Playwright proof scripts when available.
- Run `npm run build`.
- Do not touch backend automation unless requested.
- Codex is useful for:
  - browser verification
  - Playwright test setup
  - mechanical fixes
  - endpoint/debug work
  - repeatable audits
  - build/test loops

Claude Code appears better for taste-heavy frontend refactors.

Use:

- Claude Code = product designer / frontend architect
- Codex = QA engineer / verifier / backend bug fixer
- ChatGPT = strategy director / prompt architect

---

# 36. Browser Verification Direction

Browser verification should eventually use Playwright.

Desired proof scripts:

- proof:ui
- proof:deal
- proof:headed
- proof:screens

Playwright tests should check:

- 25/50/75/100 layouts
- no horizontal overflow
- no clipped controls
- no command dock overlap
- media not slivers
- dropdowns clickable
- visible core labels
- console errors
- screenshot captures

For UI tasks, verification should include screenshots when possible.

---

# 37. Repo-Level Instruction Files

The repo should include:

- `AGENTS.md`
- `00_Nexus_Command_Center_Master_Context.md`
- optionally `CLAUDE.md`
- eventually `.claude/skills/` files if useful

Recommended custom Claude/project skill files:

- `.claude/skills/design-system.md`
- `.claude/skills/rei-command-center.md`
- `.claude/skills/no-slop-ui.md`
- `.claude/skills/frontend-safety.md`

These are optional but helpful.

---

# 38. Current Known Issues

## Deal Intelligence / List View responsive issues

25%:

- works as compact preview

50%:

- Deal Intelligence appears as narrow left panel while List View consumes the right
- header becomes cramped
- media hero becomes tiny
- command dock overlaps media/content
- buttons stack awkwardly
- looks like broken sidebar instead of designed mode
- List View should be card/feed, not full table

75%:

- main content is visually imbalanced
- Deal Intelligence/list layout feels incorrectly split
- too much unused center space
- Operational Conversations/List area does not feel intentionally composed
- should be split workspace/hybrid table

100%:

- mostly works
- preserve for now

## Command Map issues

- map controls dropdown does not scroll
- menu gets cut off
- live action strip can sit over controls and make them unclickable
- fix later

## Deal Intelligence lower section issues

- Street/Aerial can become slivers
- top header was fixed enough, but lower modules still need work
- comp intelligence needs actual map and real comp data presentation
- buyer matching needs stronger visual system
- seller brain too long/static
- contact/ownership intelligence needs a full visual rethink
- automation timeline needs better visual system/calendar

## Pipeline issues

- looks basic
- needs full redesign for 25/50/75/100

## Queue issues

- looks basic
- needs full redesign for 25/50/75/100

---

# 39. Recent Completed Work Log

## Header rebuild

Completed:

- Replaced old `CommandHeaderStrip` with `DealCommandHeader`
- Added 3-zone header architecture
- Added deal identity area
- Added compact workflow chip strip
- Added one deal score ring
- Added confidence/data compact rail
- Removed bloated right-side cards
- Removed Next Best Action card
- Removed `...` ghost safety button
- Added property type formatting
- Improved market fallback
- Tightened CSS spacing
- Build passed

Current status:

- Header is good enough to move forward.
- Do not keep obsessing on header unless required by responsive mode fix.

---

# 40. Current Session Starter Prompt

Use this when starting a new Claude/Codex session:

```text
Read and follow 00_Nexus_Command_Center_Master_Context.md plus AGENTS.md / CLAUDE.md if they exist.

We are working section-by-section.

Current task:
Fix ONLY the 50% and 75% responsive layout behavior for Deal Intelligence and List View.

25% works. Preserve it.
100% mostly works. Preserve it.

Do not touch backend automation.
Do not change SMS/TextGrid/queue/suppression/webhooks/database mutation logic.

Treat 25%, 50%, 75%, and 100% as explicit layout modes, not simple squeezed widths.

Before coding, inspect the layout mode/view percent architecture and tell me:
1. Which files control the selected view percent.
2. Which files render Deal Intelligence at 25/50/75/100.
3. Which files render List View at 25/50/75/100.
4. Which files you plan to edit.

Do not code until the plan is clear.
42. Do Not Forget

The system is automated.

UI should support:

* monitoring
* exception handling
* underwriting
* buyer matching
* comp review
* reply drafting
* operational decisions
* safety intervention

It should not look like a manual CRM full of random buttons.

It should feel like an acquisition cockpit that can print deals.

⸻

43. Decision Log

Decision: Inbox is main shell

Do not create a separate Deal Command app right now.

Decision: Deal Intelligence lives inside Inbox

Deal Intelligence is an internal view, not a separate route/app.

Decision: 75% and 100% should share full command DNA

100% gets more breathing room.
75% stays premium and complete.

Decision: 50% is not a squeezed desktop view

50% needs its own focused panel/card mode.

Decision: 25% is compact preview

Do not cram full UI into 25%.

Decision: Work section-by-section

Whole-page prompts caused slop.
Use section-level implementation only.

Decision: Retail MLS comps and investor buyer comps are separate layers

Retail MLS = ARV ceiling.
Investor buyer comps = buyer demand / exit range.

Decision: Claude Code is primary for UI taste

Claude Code is currently better for frontend section-by-section redesign.
Codex can be used for QA/proof/debugging.

⸻

44. High-Level Launch Context

The system is moving toward real operations and money moves.

The frontend needs to become usable for live acquisition operations, not just look cool.

Priority is:

1. reliable automation logic
2. clear operational state
3. fast seller review
4. fast underwriting
5. buyer match intelligence
6. clean exception handling
7. premium UI/UX that supports speed and confidence

The design standard is high because the product is intended to become a real operating platform, not a throwaway dashboard.

⸻

45. Final Guardrail

If an AI coding agent makes the page look like generic dashboard slop, stop and narrow the scope.

If the result looks structurally similar to the old broken version, it failed.

Every section must be:

* structurally intentional
* operationally useful
* responsive by explicit mode
* visually premium
* not bloated
* not filled with fake AI filler

Build with discipline.