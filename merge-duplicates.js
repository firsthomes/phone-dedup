/**
 * FUNCTION 4 — Merge Duplicates into Primary
 * HubSpot Workflow Custom Code Action
 * Runtime: Node.js 16+
 * Dependency: @hubspot/api-client
 *
 * ENROLLMENT: Enroll on the PRIMARY contact
 * (workflow trigger: duplicate_status = "Primary Duplicate").
 *
 * The primary's duplicate(s) are NOT passed in as input fields — they're
 * discovered by looking up the association Function 1 created between
 * the primary and every contact sharing its phone number, then filtering
 * to whichever of those are actually tagged duplicate_status = "Duplicate".
 * This lets one enrollment handle groups of any size (2, 3, 10+ duplicates)
 * in a single run, rather than firing once per duplicate.
 *
 * REQUIRED WORKFLOW INPUT FIELDS (map these in the workflow UI):
 *   primaryContactId -> contact.hs_object_id
 *   dryRun           -> contact.merge_dry_run  (string "true"/"false", optional)
 *
 * REQUIRED SECRET (set in Custom Code action > Secrets):
 *   HUBSPOT_ACCESS_TOKEN
 *
 * OUTPUT FIELDS (available to later workflow steps):
 *   merge_status      -> "merged" | "partial_error" | "no_duplicates_found" | "skipped_dry_run" | "error"
 *   merge_error       -> string, empty if none
 *   merged_count      -> number of duplicates successfully merged
 *   merged_primary_id -> string
 */

const hubspot = require('@hubspot/api-client');

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

exports.main = async (event, callback) => {
  const { primaryContactId, dryRun } = event.inputFields;
  const isDryRun = String(dryRun).toLowerCase() === 'true';

  const hubspotClient = new hubspot.Client({
    accessToken: process.env.HUBSPOT_ACCESS_TOKEN
  });

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
    // Same association Function 1 created and Function 3 read from.
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
      return callback({ outputFields: result });
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

    if (duplicates.length === 0) {
      result.merge_status = 'no_duplicates_found';
      return callback({ outputFields: result });
    }

    // --- 3. Snapshot everything before touching anything ---
    // Replace this console.log with a write to your logging store
    // (Express app endpoint, a HubSpot custom object, or external DB).
    console.log(JSON.stringify({
      event: 'pre_merge_snapshot',
      timestamp: new Date().toISOString(),
      primary: primaryRecord.properties,
      duplicates: duplicates.map((d) => d.properties)
    }));

    if (isDryRun) {
      result.merge_status = 'skipped_dry_run';
      result.merged_count = duplicates.length;
      return callback({ outputFields: result });
    }

    // --- 4. Re-assert the primary's own writable values before merging ---
    // Only re-write properties actually populated on the primary, so we
    // never overwrite a good value with a blank.
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

    // --- 5. Merge sequentially — the Merge API only accepts 2 IDs at a time ---
    // Each merge is independent; one failing shouldn't stop the rest of the group.
    let mergedCount = 0;
    const errors = [];

    for (const duplicate of duplicates) {
      try {
        await mergeWithRetry(hubspotClient, primaryContactId, duplicate.id);
        mergedCount += 1;
      } catch (err) {
        errors.push(`${duplicate.id}: ${err.message || String(err)}`);
        console.error(JSON.stringify({
          event: 'merge_failed',
          primaryContactId,
          duplicateContactId: duplicate.id,
          error: err.message || String(err)
        }));
      }
    }

    result.merged_count = mergedCount;

    if (errors.length === 0) {
      result.merge_status = 'merged';
    } else {
      result.merge_status = mergedCount > 0 ? 'partial_error' : 'error';
      result.merge_error = errors.join(' | ');
    }

    return callback({ outputFields: result });

  } catch (err) {
    result.merge_error = err.message || String(err);
    console.error(JSON.stringify({
      event: 'merge_group_failed',
      primaryContactId,
      error: result.merge_error
    }));
    return callback({ outputFields: result });
  }
};

async function mergeWithRetry(client, primaryId, duplicateId, attempt = 1) {
  try {
    await client.crm.contacts.publicObjectApi.merge({
      primaryObjectId: primaryId,
      objectIdToMerge: duplicateId
    });
  } catch (err) {
    if (err.code === 429 && attempt <= 3) {
      const backoffMs = attempt * 1000;
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      return mergeWithRetry(client, primaryId, duplicateId, attempt + 1);
    }
    throw err;
  }
}