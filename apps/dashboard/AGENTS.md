# Nexus Dashboard Agent Instructions

## Core Product Context

This project is an AI-powered real estate acquisition command center.

Inbox is the main operating shell. Do not create separate apps unless explicitly requested.

Core views:
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

## UI Design Standard

The UI should feel like a premium acquisition cockpit:
- cinematic
- dark glass
- dense but clean
- animated but not cheesy
- operational
- optimized for ultrawide displays
- responsive for laptop
- no generic SaaS dashboard slop

Work section-by-section. If asked to redesign one section, only touch that section.

## UI Verification Rules

For UI tasks:
- Run browser verification when Playwright/proof scripts are available.
- Test 25%, 50%, 75%, and 100% view states.
- Capture screenshots when possible.
- Fix overflow, overlap, tiny media, broken dropdowns, unreadable text, dead space, or weak responsive states before finishing.
- Run `npm run build` before completion.

## Do Not Modify Backend Automation Unless Explicitly Asked

Never modify these unless the user specifically requests it:
- TextGrid routing
- SMS sending
- queue runner
- suppression logic
- webhooks
- database mutation behavior
- opt-out / DNC safety logic

## Data Field Rules

Use actual fields from `inbox_thread_state`:
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

## Fallback Rules

Use safe fallbacks:
- seller name: owner_display_name, owner_name, prospect_name, contact_name, then “Unknown Seller”
- address: property_address_full, property_address, address, situs_address, then “Property Unknown”
- market: market, city/state, property_address_city/property_address_state, then “Market Unknown”

Hide missing fields gracefully. Do not spam “Not enriched” everywhere.

## Completion Requirements

Before finishing any implementation:
1. Run `npm run build`.
2. Summarize exact files changed.
3. Explain what changed structurally.
4. Explain what was intentionally not changed.