/**
 * Function 4 — Merge Duplicates into Primary
 * Express route handler (same app as Functions 1 and 3)
 *
 * TRIGGERED BY: HubSpot Workflow "Send a webhook" action, enrolled on the
 * PRIMARY contact (workflow trigger: duplicate_status = "Primary Duplicate").
 * Moved out of Custom Code because HubSpot automatically unenrolls any
 * record involved in a merge — even the surviving primary — which killed
 * a Custom Code execution mid-loop after the first merge. Running this as
 * a plain Express handler means the merge loop is no longer tied to the
 * workflow's enrollment lifecycle at all.
 *
 * Since the workflow only sends the webhook and doesn't wait for a
 * response, this acks immediately and processes the merge async — same
 * pattern as Function 1. Results are written back to HubSpot as contact
 * properties (merge_status, merge_error, merged_count) rather than
 * returned as Custom Code output fields, so a separate workflow branch
 * (triggered on merge_status changing) can pick them up for the error
 * email notification.
 *
 * Merge itself is called directly via axios against HubSpot's REST API
 * (rather than the @hubspot/api-client SDK's publicObjectApi.merge),
 * since that SDK path was undefined in the installed version.
 *
 * CANONICAL ID TRACKING: HubSpot generates a new canonical record ID on
 * merge rather than always preserving the original primaryObjectId
 * literally. After every successful merge, the ID returned in the API
 * response is captured and used as the primary for all subsequent
 * merges in the same group — otherwise, merging a group of 3+ duplicates
 * would fail on the second merge, since the ID used for the first merge
 * may no longer be the live canonical one.
 *
 * ASSOCIATION DISCOVERY: this function reads the primary's direct
 * associations via a single lookup, rather than traversing the group.
 * This is safe because Function 3 associates every duplicate directly
 * to the winner (not just to whichever contact happened to trigger
 * Function 1) before writing duplicate_status = "Primary Duplicate" —
 * so by the time this function runs, the primary is always directly
 * linked to every other group member, regardless of the original
 * hub-and-spoke shape Function 1 created.
 *
 * WEBHOOK PAYLOAD EXPECTED:
 *   { "primaryContactId": "{{contact.hs_object_id}}", "dryRun": "false" }
 *
 * ENV VARS REQUIRED:
 *   HUBSPOT_ACCESS_TOKEN
 *   WORKFLOW_WEBHOOK_SECRET
 *   AUDIT_ENDPOINT_URL
 *
 * CONTACT PROPERTIES WRITTEN BACK TO PRIMARY:
 *   merge_status  -> Dropdown select: merged | partial_error | no_duplicates_found | skipped_dry_run | error
 *   merge_error   -> Single-line text
 *   merged_count  -> Number
 */

const crypto = require('crypto');
const hubspot = require('@hubspot/api-client');
const axios = require('axios');

const hubspotClient = new hubspot.Client({
  accessToken: process.env.HUBSPOT_ACCESS_TOKEN
});

const AUDIT_ENDPOINT = process.env.AUDIT_ENDPOINT_URL;
const WEBHOOK_SECRET = process.env.WORKFLOW_WEBHOOK_SECRET;
const ACCESS_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;

// Matches the constant name used in compare-primary-duplicate.js (Function 3).
const AIRCALL_LAST_CALL_PROPERTY = 'aircall_last_call_at';

const PROPERTIES_TO_PRESERVE_ON_PRIMARY = [
  'email',
  'phone',
  'firstname',
  'lastname',
  AIRCALL_LAST_CALL_PROPERTY
];

// Read-only additions for the audit snapshot only — not written back.
const PROPERTIES_TO_SNAPSHOT = [
  ...PROPERTIES_TO_PRESERVE_ON_PRIMARY,
  'deal_and_contact_owner_matched',
  'associated_deal_stage',
  'createdate',
  'duplicate_status'
];

function isValidSignature(req) {
  const provided = req.headers['x-webhook-secret'];

  if (process.env.DEBUG_WEBHOOK === 'true') {
    console.log('--- Merge webhook signature debug ---');
    console.log('WORKFLOW_WEBHOOK_SECRET loaded:', WEBHOOK_SECRET ? `yes (length ${WEBHOOK_SECRET.length})` : 'NO — undefined');
    console.log('x-webhook-secret header received:', provided ? `yes (length ${provided.length})` : 'NO — missing');
    console.log('--------------------------------------');
  }

  if (!WEBHOOK_SECRET || !provided) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(WEBHOOK_SECRET), Buffer.from(provided));
  } catch {
    return false; // lengths differ -> timingSafeEqual throws instead of returning false
  }
}

async function writeResultToPrimary(primaryContactId, result) {
  try {
    await hubspotClient.crm.contacts.basicApi.update(primaryContactId, {
      properties: {
        merge_status: result.merge_status,
        merge_error: result.merge_error,
        merged_count: result.merged_count
      }
    });
  } catch (err) {
    // Don't let a failed status write throw further up — just log it.
    console.error(JSON.stringify({
      event: 'merge_result_write_failed',
      primaryContactId,
      error: err.message || String(err)
    }));
  }
}

async function preservePropertiesOnPrimary(primaryContactId, primaryRecord) {
  const preserveUpdate = {};
  for (const prop of PROPERTIES_TO_PRESERVE_ON_PRIMARY) {
    const value = primaryRecord.properties[prop];
    if (value) preserveUpdate[prop] = value;
  }
  if (Object.keys(preserveUpdate).length > 0) {
    await hubspotClient.crm.contacts.basicApi.update(primaryContactId, {
      properties: preserveUpdate
    });
  }
}

async function performMerge(primaryContactId, isDryRun) {
  const result = {
    merge_status: 'error',
    merge_error: '',
    merged_count: 0,
    merged_primary_id: primaryContactId || ''
  };

  try {
    if (!primaryContactId) {
      throw new Error('Missing primaryContactId input.');
    }

    // --- 1. Discover the duplicate group via the existing association ---
    // Safe as a single-level lookup — see header comment on Association
    // Discovery for why the primary is guaranteed to be directly linked
    // to every other group member by this point.
    const assocResp = await hubspotClient.crm.associations.v4.basicApi.getPage(
      'contacts',
      primaryContactId,
      'contacts',
      undefined,
      100
    );
    const associatedIds = (assocResp.results || []).map((r) => String(r.toObjectId));

    if (associatedIds.length === 0) {
      result.merge_status = 'no_duplicates_found';
      await writeResultToPrimary(primaryContactId, result);
      return result;
    }

    // --- 2. Batch-fetch primary + all associated contacts in ONE call ---
    const batchResp = await hubspotClient.crm.contacts.batchApi.read({
      inputs: [{ id: primaryContactId }, ...associatedIds.map((id) => ({ id }))],
      properties: PROPERTIES_TO_SNAPSHOT
    });
    const records = batchResp.results || [];

    const primaryRecord = records.find((r) => r.id === String(primaryContactId));
    if (!primaryRecord) {
      throw new Error(`Primary contact ${primaryContactId} not found in batch read — it may have already been merged elsewhere.`);
    }

    // Only merge records explicitly tagged as duplicates of this primary —
    // guards against an association existing for some other reason.
    const duplicates = records.filter(
      (r) => r.id !== primaryRecord.id && r.properties.duplicate_status === 'Duplicate'
    );

    console.log('Duplicates captured:', duplicates.map((d) => d.id));

    if (duplicates.length === 0) {
      result.merge_status = 'no_duplicates_found';
      await writeResultToPrimary(primaryContactId, result);
      return result;
    }

    // --- 3. Snapshot everything before touching anything ---
    // POSTs to the Express app's own audit endpoint. Wrapped in its own
    // try/catch so a logging failure never blocks the actual merge.
    try {
      await axios.post(AUDIT_ENDPOINT, {
        event: 'pre_merge_snapshot',
        timestamp: new Date().toISOString(),
        primary: primaryRecord.properties,
        duplicates: duplicates.map((d) => d.properties)
      }, {
        headers: { 'x-webhook-secret': WEBHOOK_SECRET }
      });
    } catch (err) {
      console.error(JSON.stringify({
        event: 'audit_snapshot_failed',
        primaryContactId,
        error: err.message || String(err)
      }));
    }

    if (isDryRun) {
      result.merge_status = 'skipped_dry_run';
      result.merged_count = duplicates.length;
      await writeResultToPrimary(primaryContactId, result);
      return result;
    }

    // --- 4. Merge sequentially — the Merge API only accepts 2 IDs at a
    // time. Each merge is independent; one failing shouldn't stop the
    // rest of the group. After every successful merge, canonicalPrimaryId
    // is updated to whatever ID HubSpot's response actually returns,
    // since that may not be the same ID we started with (see header
    // comment).
    let canonicalPrimaryId = primaryContactId;
    let mergedCount = 0;
    const errors = [];

    for (const duplicate of duplicates) {
      const attemptedPrimaryId = canonicalPrimaryId;
      try {
        const returnedId = await mergeWithRetry(ACCESS_TOKEN, canonicalPrimaryId, duplicate.id);
        mergedCount += 1;

        const idChanged = returnedId && returnedId !== canonicalPrimaryId;
        if (idChanged) {
          canonicalPrimaryId = returnedId;
        }

        console.log(JSON.stringify({
          event: 'merge_result',
          status: 'success',
          primaryId: attemptedPrimaryId,
          duplicateMergedId: duplicate.id,
          newPrimaryId: canonicalPrimaryId
        }));
      } catch (err) {
        const errMsg = err.response?.data?.message || err.message || String(err);
        errors.push(`${duplicate.id}: ${errMsg}`);

        console.log(JSON.stringify({
          event: 'merge_result',
          status: 'fail',
          primaryId: attemptedPrimaryId,
          duplicateMergedId: duplicate.id,
          newPrimaryId: attemptedPrimaryId,
          error: errMsg
        }));
      }
    }

    result.merged_count = mergedCount;
    result.merged_primary_id = canonicalPrimaryId;

    // --- 5. Re-assert the primary's own writable values ---
    // Uses the values captured from the original batch read, written onto
    // whichever ID ended up being the actual canonical primary. Only
    // re-write properties actually populated, so we never overwrite a
    // good value with a blank.
    try {
      await preservePropertiesOnPrimary(canonicalPrimaryId, primaryRecord);
    } catch (err) {
      console.error(JSON.stringify({
        event: 'preserve_properties_failed',
        primaryContactId: canonicalPrimaryId,
        error: err.message || String(err)
      }));
    }

    if (errors.length === 0) {
      result.merge_status = 'merged';

      // All duplicates merged successfully — the primary is no longer
      // part of an active duplicate group, so clear its status.
      try {
        await hubspotClient.crm.contacts.basicApi.update(canonicalPrimaryId, {
          properties: { duplicate_status: 'Non-duplicate' }
        });
      } catch (err) {
        console.error(JSON.stringify({
          event: 'primary_status_reset_failed',
          primaryContactId: canonicalPrimaryId,
          error: err.message || String(err)
        }));
      }
    } else {
      result.merge_status = mergedCount > 0 ? 'partial_error' : 'error';
      result.merge_error = errors.join(' | ');
    }

    await writeResultToPrimary(canonicalPrimaryId, result);
    return result;

  } catch (err) {
    result.merge_error = err.message || String(err);
    console.error(JSON.stringify({
      event: 'merge_group_failed',
      primaryContactId,
      error: result.merge_error
    }));
    await writeResultToPrimary(primaryContactId, result);
    return result;
  }
}

// Returns the surviving contact's ID as reported by HubSpot's merge
// response, so the caller can keep merging subsequent duplicates against
// the correct, current canonical record.
async function mergeWithRetry(accessToken, primaryId, duplicateId, attempt = 1) {
  try {
    const response = await axios.post(
      'https://api.hubapi.com/crm/v3/objects/contacts/merge',
      {
        primaryObjectId: primaryId,
        objectIdToMerge: duplicateId
      },
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/json'
        }
      }
    );
    return response.data?.id ? String(response.data.id) : primaryId;
  } catch (err) {
    if (err.response?.status === 429 && attempt <= 3) {
      const backoffMs = attempt * 1000;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      return mergeWithRetry(accessToken, primaryId, duplicateId, attempt + 1);
    }
    throw err;
  }
}

async function handleMergeDuplicates(req, res) {
  // Ack immediately — same reasoning as Function 1. HubSpot's webhook
  // action doesn't wait for or read the response body, and a sequential
  // merge loop with retries could exceed HubSpot's webhook timeout.
  res.status(200).send('OK');

  if (!isValidSignature(req)) {
    console.warn('Rejecting merge request: invalid signature');
    return;
  }

  const { primaryContactId, dryRun } = req.body || {};
  const isDryRun = String(dryRun).toLowerCase() === 'true';

  if (!primaryContactId) {
    console.warn('Rejected: payload had no primaryContactId', req.body);
    return;
  }

  performMerge(String(primaryContactId), isDryRun).catch((err) => {
    console.error(`Unhandled error merging primary ${primaryContactId}:`, err.message || String(err));
  });
}

module.exports = { handleMergeDuplicates };
