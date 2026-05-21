# Current State - Nexus Dashboard

## System Status
- **Inbox Mode**: Live Supabase loading is **ENABLED** (`VITE_USE_SUPABASE_DATA=true`).
- **Underwriting**: Gemini Autonomous Underwriter is **LIVE** with deterministic profit protection.
- **Primary Data Source**: Supabase Project `lcppdrmrdfblstpcbgpf`.
- **Latest Migration**: `20260509020000_finalize_inbox_data_flow.sql`.

## Database Schema Status
- **Raw Tables**: `message_events` is the source of truth for all communications.
- **View Hierarchy**:
    1. `deduped_message_events`: Filters duplicate webhook deliveries.
    2. `nexus_inbox_threads_v`: Aggregates messages into threads and applies priority classification.
    3. `inbox_threads_hydrated`: Joins threads with `properties`, `master_owners`, and `prospects` for UI.
    4. `inbox_command_center_v`: Unified rollup for frontend consumption.
- **RLS**: Policies are active on `message_events`, `inbox_thread_state`, and `inbox_command_center_v`.

## Underwriter Configuration
- **Profit Floors**: $20k (SFR), $50k/5% (Multifamily).
- **Authentication**: `GEMINI_API_KEY` configured in `.env.local`.
- **Logic**: Research is AI-driven; calculations are deterministic (`src/lib/underwriting/`).

## Environment
- **Development**: Local Vite server with `.env.local` pointing to Supabase and Gemini.
- **Production**: Vercel Edge/Serverless functions.
