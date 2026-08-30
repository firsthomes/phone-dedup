# HubSpot Phone Deduplication App

An automated system for identifying, scoring, comparing, and merging duplicate HubSpot contacts based on phone number. Built for First Home Specialists (FHS) RevOps.

The system combines **HubSpot Custom Code workflow actions** with an **external Express.js app** (deployed on Railway) to handle logic that requires API calls beyond what's available synchronously inside a HubSpot workflow.

## How It Works

The pipeline runs across four functions, triggered by HubSpot workflows in sequence:

1. **Webhook Receiver + Duplicate Tagging** — Receives normalized phone numbers from a HubSpot workflow (triggered *after* normalization completes, not on raw CRM webhooks) and tags contacts as potential duplicates. Authenticated via a shared-secret header (`X-Webhook-Secret`).

2. **Primary Contact Score** — A fully synchronous HubSpot Custom Code action that scores each contact using a power-of-2 weighting system, reading only from `event.inputFields` (no API calls required). Max score: 63.

   | Priority | Criteria | Points | Source |
   |---|---|---|---|
   | 1 | Deal stage not excluded | 32 | Function 2 |
   | 2 | Highest deal stage number in group | 16 | Function 3 |
   | 3 | Owner matched (`owner_match`) | 8 | Function 2 |
   | 4 | Most recent Aircall timestamp (`aircall_last_call_at`) | 4 | Function 3 |
   | 5 | Email known | 2 | Function 2 |
   | 6 | Earliest `createdate` | 1 | Function 3 |

   The power-of-2 structure guarantees no combination of lower-ranked criteria can outrank a single higher-ranked one.

   Excluded deal stage IDs: `closedlost`, `3409668570`, `1803137522`

3. **Duplicate Comparison / Primary Determination** — Custom Code + webhook to external app. Performs a single batch API read across the full duplicate group (3 API calls total per event) and writes `duplicate_status`: `Primary Duplicate` for the winner, `Duplicate` for all others.

4. **Merge Duplicates** — Enrolled on duplicate contact records. Uses HubSpot's native Merge API with dry-run/audit logging, sequential handling for groups of 3+, and retry logic. Outputs `merge_status`, `merge_error`, and `merged_primary_id`.

## Architecture

```
HubSpot Workflow (normalization)
        │
        ▼
Function 1: Webhook Receiver ──► tags duplicates
        │
        ▼
Function 2: Primary Contact Score (Custom Code, synchronous)
        │
        ▼
Function 3: Duplicate Comparison (Custom Code → external Express app)
        │
        ▼
Function 4: Merge Duplicates (HubSpot Merge API)
```

## Tech Stack

- **Runtime:** Node.js / Express.js
- **Platform:** HubSpot (Custom Code workflow actions, Private App, Merge API, batch contact API)
- **Deployment:** Railway
- **Local development:** ngrok (tunneling for webhook testing)
- **Integrations:** Aircall (via HubSpot contact properties)

## Project Structure

```
hubspot-dedup-app/
├── index.js                          # Main Express app entry point
├── merge-duplicates.js               # Function 4: merge logic
├── test-compare-primary-server.js    # Local test harness for Function 3 (port 3001)
├── .env                               # Secrets (not committed)
└── .gitignore
```

## Environment Variables

Set these in your `.env` file locally, and in Railway's Variables tab for production:

| Variable | Description |
|---|---|
| `HUBSPOT_ACCESS_TOKEN` | Private App access token for HubSpot API calls |
| `WEBHOOK_SECRET` | Shared secret for validating incoming webhook requests (`X-Webhook-Secret` header) |
| `DEBUG_WEBHOOK` | Set to `true` for verbose local logging (disable in production) |
| `PORT` | Local dev port (Railway assigns this automatically in production) |

## Important Property Notes

- `deal_and_contact_owner_matched`, `associated_deal_stage`, and `createdate` are calculated/synced HubSpot properties — **read-only**, used for audit snapshots only.
- Aircall property is `aircall_last_call_at` (not `aircall_last_call_timestamp`).

## Local Development

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env` and fill in credentials
3. Start the app: `npm start`
4. Tunnel locally with ngrok to get a public URL for HubSpot webhook testing
5. Point the HubSpot workflow's webhook action at your ngrok URL

## Deployment (Railway)

1. Push this repo to GitHub
2. Connect the repo in Railway
3. Set environment variables in Railway's dashboard (Variables tab)
4. Ensure `package.json` has a `start` script: `"start": "node index.js"`
5. Generate a public domain under Settings → Networking
6. Update the HubSpot workflow's webhook action to point at the new Railway URL

## Status

- [x] Function 1 — Webhook receiver + tagging
- [x] Function 2 — Primary contact score
- [x] Function 3 — Duplicate comparison (built, pending migration into `index.js`)
- [x] Function 4 — Merge duplicates
- [ ] Migrate Function 3 route out of test harness into `index.js`
- [ ] Remove debug logging before deployment
- [ ] Deploy to Railway
- [ ] End-to-end live testing of full pipeline