# HubSpot Phone Deduplication App

An automated system for identifying, scoring, comparing, and merging duplicate HubSpot contacts based on phone number. Built for First Home Specialists (FHS) RevOps.

The system combines **HubSpot native workflow actions** ("Send a webhook") with an **external Express.js app** (deployed on Railway) that handles all scoring, comparison, and merge logic. All four functions run as plain Express route handlers — none of the duplicate-detection logic lives in HubSpot Custom Code anymore.

## How It Works

The pipeline runs across four functions, triggered sequentially by a single HubSpot workflow:

### Function 1 — Webhook Receiver + Duplicate Tagging
Receives a webhook from HubSpot's phone-normalization workflow (fired *after* normalization completes, not on raw CRM webhooks, to guarantee clean phone data). Searches for other contacts sharing the same phone number, associates them, and tags them `duplicate_status = "Duplicate"`.

- Route: `POST /webhooks/contact-normalized`
- Payload: `{ "contactId": "{{contact.hs_object_id}}" }`
- Runs **synchronously** (awaits full completion before responding) so the next workflow step can rely on associations already existing.

### Function 2 — Merged into Function 3
Originally a standalone HubSpot Custom Code scoring step. Retired: its scoring logic now runs as part of Function 3's single pass, since triggering it independently caused race conditions where Function 3 could run multiple times against partial duplicate groups (see Architecture Notes below).

### Function 3 — Score, Compare & Determine Primary
Computes every group member's score in one pass, using a power-of-2 weighted hierarchy, and determines the winner ("Primary Duplicate").

- Route: `POST /webhooks/compare-primary`
- Payload: `{ "contactId": "{{contact.hs_object_id}}" }`
- Placed directly after Function 1 in the **same workflow**, not a separate one — guarantees the comparison runs exactly once per normalization event, after associations already exist.

| Priority | Criteria | Points |
|---|---|---|
| 1 | Deal stage not excluded | 32 |
| 2 | Highest deal stage number in group | 16 |
| 3 | Owner matched | 8 |
| 4 | Most recent Aircall timestamp | 4 |
| 5 | Email known | 2 |
| 6 | Earliest `createdate` in group | 1 |

Max possible score: 63. The power-of-2 structure guarantees no combination of lower-ranked criteria can outrank a single higher-ranked one.

Excluded deal stage IDs: `closedlost`, `3409668570`, `1803137522`

**Critical step after scoring:** every other group member is directly associated to the winner (not just to whichever contact happened to trigger Function 1). This closes a gap where Function 1 only builds a hub-and-spoke association structure — without this step, Function 4 could miss group members if the winner turned out to be a "spoke" rather than the original "hub" contact.

### Function 4 — Merge Duplicates
Discovers the duplicate group via the winner's associations, snapshots everything for audit purposes, then merges each duplicate into the primary sequentially.

- Route: `POST /webhooks/merge-duplicates`
- Payload: `{ "primaryContactId": "{{contact.hs_object_id}}", "dryRun": "false" }`
- Enrolled on the primary contact (workflow trigger: `duplicate_status = "Primary Duplicate"`)

## Architecture

```
HubSpot Workflow (normalization)
        │
        ▼
Function 1: Webhook Receiver ──► tags duplicates, associates hub-and-spoke
        │
        ▼  (same workflow, next action)
Function 3: Score + Compare ──► determines winner, meshes all associations
        │                       to winner, sets duplicate_status
        ▼  (separate workflow, triggered on duplicate_status change)
Function 4: Merge Duplicates ──► merges group into winner, resets status
```

## Key Architecture Decisions

- **Function 2's scoring logic was merged into Function 3** to eliminate a race condition: HubSpot's workflow-enrollment triggers (`duplicate_status updated to Duplicate`, `scoring criteria changed`) could independently re-enroll different contacts in the same duplicate group, causing Function 3 to run multiple times against different partial slices of the group instead of once against the whole thing. Merging the scoring into a single webhook call, triggered once per normalization event, eliminates the possibility of a partial-group comparison entirely.

- **Function 4 runs as a plain Express handler, not HubSpot Custom Code.** HubSpot automatically unenrolls any record involved in a merge from all active workflows — even the surviving primary — which killed a Custom Code execution mid-loop after the first merge in a group of 3+. Since Function 4's merge loop now runs as ordinary async JavaScript in Express, it's no longer tied to a workflow enrollment lifecycle and can't be interrupted mid-loop.

- **Function 3 associates every duplicate directly to the winner** after scoring, rather than relying solely on Function 1's associations. Function 1 only guarantees each duplicate is linked to whichever contact was originally normalized (the "hub") — not to every other duplicate. If the winner turns out to be a "spoke" rather than the hub, Function 4's single-level association lookup would otherwise only see one group member.

- **Canonical ID tracking in Function 4.** HubSpot generates a new canonical record ID after each merge rather than always preserving the original `primaryObjectId` literally. Function 4 captures the ID returned in each merge response and uses it for all subsequent merges in the same group — without this, merging a group of 3+ duplicates fails on the second merge attempt.

- **Merge calls use a direct `axios` REST call**, not the `@hubspot/api-client` SDK — the SDK's `publicObjectApi.merge` method was `undefined` in the installed package version.

- **Merge results are written back as contact properties** (`merge_status`, `merge_error`, `merged_count`) rather than returned as Custom Code output fields, since Function 4 is a webhook action now (HubSpot doesn't expose webhook response bodies back to the workflow). A separate workflow branch, triggered on `merge_status` changing, checks these properties and sends an internal HubSpot email notification to `jerome@firsthome.com.au` on `error` or `partial_error`.

- **`duplicate_status` resets to `"Non-duplicate"`** on the primary once every duplicate in the group has merged successfully. Left as `"Primary Duplicate"` on partial/full failure, so the group stays visible for investigation.

## Tech Stack

- **Runtime:** Node.js / Express.js
- **Platform:** HubSpot (native "Send a webhook" workflow actions, Private App for API access, native workflow branching for error notification)
- **Deployment:** Railway
- **HTTP:** `axios` for all HubSpot REST API calls
- **Local development:** ngrok (tunneling for webhook testing)
- **Integrations:** Aircall (via HubSpot contact properties)

## Project Structure

```
hubspot-dedup-app/
├── index.js                        # Express entry point — routes for Functions 1, 3, 4, and the audit endpoint
├── compare-primary-duplicate.js    # Function 3: scoring, comparison, association meshing
├── merge-duplicates.js             # Function 4: merge logic, canonical ID tracking
├── .env                             # Secrets (not committed)
├── .gitignore
├── package.json
└── package-lock.json
```

## Environment Variables

Set in `.env` locally, and in Railway's Variables tab for production:

| Variable | Description |
|---|---|
| `HUBSPOT_ACCESS_TOKEN` | Private App access token for all HubSpot API calls |
| `WORKFLOW_WEBHOOK_SECRET` | Shared secret validating incoming webhook requests (`x-webhook-secret` header) — used consistently across all functions and the audit endpoint |
| `AUDIT_ENDPOINT_URL` | Full URL (including path) of this app's own `/internal/audit-snapshot` endpoint — used by Function 4 to log a pre-merge snapshot |
| `DEBUG_WEBHOOK` | Set to `true` for verbose local logging (must be `false`/unset in Railway) |
| `PORT` | Local dev port; Railway assigns this automatically in production |

## HubSpot Contact Properties

| Property | Type | Written by |
|---|---|---|
| `duplicate_status` | Dropdown (`Duplicate`, `Primary Duplicate`, `Non-duplicate`) | Functions 1, 3, 4 |
| `merge_status` | Dropdown (`merged`, `partial_error`, `no_duplicates_found`, `skipped_dry_run`, `error`) | Function 4 |
| `merge_error` | Single-line text | Function 4 |
| `merged_count` | Number | Function 4 |
| `associated_deal_stage` | Read-only (synced) | — |
| `associated_deal_stage_number` | Read-only (synced) | — |
| `deal_and_contact_owner_matched` | Read-only (synced) | — |
| `aircall_last_call_at` | Synced from Aircall | — |

## Local Development

1. Install dependencies: `npm install`
2. Copy `.env.example` to `.env` and fill in credentials
3. Start the app: `npm start`
4. Tunnel locally with ngrok to get a public URL for HubSpot webhook testing
5. Point each HubSpot "Send a webhook" action at your ngrok URL + the relevant path

## Deployment (Railway)

1. Ensure GitHub has the latest version of `index.js`, `compare-primary-duplicate.js`, and `merge-duplicates.js`
2. Connect the repo in Railway (or deploy directly via Railway CLI)
3. Set all four environment variables in Railway's Variables tab
4. Confirm `package.json` has a `start` script: `"start": "node index.js"`
5. Generate a public domain under Settings → Networking
6. Update each HubSpot "Send a webhook" action to point at the new Railway URL instead of ngrok
7. Update `AUDIT_ENDPOINT_URL` in Railway's Variables to point at the Railway domain (not ngrok)
8. Run one full live test end-to-end before considering the migration complete

## Status

- [x] Function 1 — Webhook receiver + tagging
- [x] Function 3 — Score, compare, associate to winner (Function 2's logic merged in)
- [x] Function 4 — Merge duplicates, canonical ID tracking, audit snapshot, error notification
- [x] Full local end-to-end testing via ngrok, including multi-duplicate groups (3+)
- [ ] Deploy to Railway
- [ ] Live end-to-end test against Railway domain
