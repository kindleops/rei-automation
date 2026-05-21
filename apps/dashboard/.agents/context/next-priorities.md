# Next Priorities

## 1. Inbox Command Center
- **Goal**: Build `inbox_command_center_v` to provide a high-level summary of inbox health (unresponded threads, average response time).
- **Status**: Researching aggregation performance.

## 2. Advanced Real-time Subscriptions
- **Goal**: Replace the current polling/scaffold with production-grade Supabase Realtime for instant thread updates.
- **File**: `src/lib/data/realtime.ts`.

## 3. Classifier Precision
- **Goal**: Move regex patterns into a separate reference table (`marker_taxonomy`) to allow updates without full view rebuilds.
- **Status**: Taxonomy table created in migration `20260508020003`.

## 4. AI Underwriting Integration
- **Goal**: Hook the inbox into the AI underwriting agent to automatically draft responses for property inquiries.
