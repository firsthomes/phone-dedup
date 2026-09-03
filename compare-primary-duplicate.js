/**
 * Function 3 — Score, Compare & Determine Primary Duplicate
 * Express route handler (same app as Function 1)
 *
 * TRIGGERED BY: HubSpot Workflow "Send a webhook" action, placed directly
 * after the "Retrieve IDs and Associate" webhook action (Function 1), in
 * the SAME workflow — not a separate one. This guarantees the comparison
 * only ever runs once per normalization event, after associations exist,
 * and computes every group member's full score in a single pass rather
 * than depending on each contact having been scored independently first.
 *
 * Once the winner is determined, every other group member is directly
 * associated to the winner (not just to the originally-enrolled contact
 * that triggered Function 1). Function 1 only builds a hub-and-spoke
 * structure centered on whichever contact happened to be normalized
 * first — which may or may not be the winner this function picks. Without
 * this step, Function 4's association lookup (querying from the winner's
 * perspective) could miss group members if the winner turned out to be a
 * spoke rather than the hub.
 *
 * WEBHOOK PAYLOAD EXPECTED (configure in the workflow's webhook body):
 *   { "contactId": "{{contact.hs_object_id}}" }
 *
 * ENV VARS REQUIRED:
 *   HUBSPOT_ACCESS_TOKEN
 *   WORKFLOW_WEBHOOK_SECRET
 */

const crypto = require('crypto');
const hubspot = require('@hubspot/api-client');
const axios = require('axios');

const hubspotClient = new hubspot.Client({
  accessToken: process.env.HUBSPOT_ACCESS_TOKEN,
});

const ACCESS_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;

// --- CONFIG -------------------------------------------------------------
// Weights use powers of 2 so the score encodes a strict 6-level priority
// hierarchy. Each weight strictly outweighs the sum of every weight below
// it, guaranteeing a higher-priority criterion always wins regardless of
// how many lower-priority criteria are also true. Max possible score: 63.
//
//   1. Deal stage NOT excluded              -> 32
//   2. Highest deal stage number in group   -> 16
//   3. Owner matched                        -> 8
//   4. Most recent Aircall timestamp        -> 4
//   5. Email known                          -> 2
//   6. Earliest createdate in group         -> 1
const BONUS = {
  dealStageNotExcluded: 32,
  dealStageRank: 16,
  ownerMatched: 8,
  latestCall: 4,
  emailKnown: 2,
  createdFirst: 1,
};

const DEAL_STAGE_PROPERTY = 'associated_deal_stage';
const DEAL_STAGE_RANK_PROPERTY = 'associated_deal_stage_number';
const OWNER_MATCH_PROPERTY = 'deal_and_contact_owner_matched';
const AIRCALL_LAST_CALL_PROPERTY = 'aircall_last_call_at';

// Deal stages that disqualify a contact from the "deal stage not excluded" bonus.
const EXCLUDED_DEAL_STAGES = ['closedlost', '3409668570', '1803137522'];

// Confirmed: a HIGHER number means a more advanced/better deal stage.
const HIGHER_RANK_IS_BETTER = true;

function isValidSignature(req) {
  const secret = process.env.WORKFLOW_WEBHOOK_SECRET;
  const provided = req.headers['x-webhook-secret'];

  if (process.env.DEBUG_WEBHOOK === 'true') {
    console.log('--- Webhook signature debug ---');
    console.log('WORKFLOW_WEBHOOK_SECRET loaded:', secret ? `yes (length ${secret.length})` : 'NO — undefined');
    console.log('x-webhook-secret header received:', provided ? `yes (length ${provided.length})` : 'NO — missing');
    if (secret && provided) {
      console.log('Lengths match:', secret.length === provided.length);
      console.log('Values match:', secret === provided);
    }
    console.log('All received headers:', JSON.stringify(req.headers, null, 2));
    console.log('--------------------------------');
  }

  if (!secret || !provided) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(secret), Buffer.from(provided));
  } catch {
    return false; // lengths differ -> timingSafeEqual throws instead of returning false
  }
}

// Default (unlabeled) contact-to-contact association. Idempotent — safe
// to call even if the pair is already associated (e.g. the winner and
// the original hub contact, associated back in Function 1).
async function associateContacts(contactIdA, contactIdB) {
  await axios.put(
    `https://api.hubapi.com/crm/v4/objects/contact/${contactIdA}/associations/default/contact/${contactIdB}`,
    {},
    {
      headers: {
        Authorization: `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
      },
    }
  );
}

async function handleComparePrimary(req, res) {
  if (!isValidSignature(req)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const { contactId } = req.body;
  if (!contactId) {
    return res.status(400).json({ error: 'Missing contactId' });
  }

  try {
    // 1. Find the duplicate group — contacts associated with this one
    //    (reuses the same association Function 1 created)
    const assocResp = await hubspotClient.crm.associations.v4.basicApi.getPage(
      'contacts',
      contactId,
      'contacts',
      undefined,
      100
    );
    const siblingIds = (assocResp.results || []).map((r) => String(r.toObjectId));
    const groupIds = Array.from(new Set([String(contactId), ...siblingIds]));

    if (groupIds.length < 2) {
      console.log(`Contact ${contactId} has no duplicate group members — skipping`);
      return res.status(200).json({ status: 'no_group' });
    }

    // 2. One batch call fetches every property needed for the whole group,
    //    regardless of group size (up to 100 records per call)
    const batchResp = await hubspotClient.crm.contacts.batchApi.read({
      inputs: groupIds.map((id) => ({ id })),
      properties: [
        'email',
        DEAL_STAGE_PROPERTY,
        DEAL_STAGE_RANK_PROPERTY,
        OWNER_MATCH_PROPERTY,
        AIRCALL_LAST_CALL_PROPERTY,
        'createdate',
        'duplicate_status',
      ],
    });

    const group = batchResp.results || [];
    if (group.length < 2) {
      console.log(`Batch fetch returned <2 records for group of ${contactId} — skipping`);
      return res.status(200).json({ status: 'incomplete_group' });
    }

    // 3. Running totals, starting from zero — every criterion is now
    //    computed here in one pass, rather than seeded from a separately
    //    calculated primary_contact_score.
    const totals = {};
    group.forEach((c) => { totals[c.id] = 0; });

    // Criterion 1: deal stage NOT excluded (+32) — per-contact, not a
    // group-winner bonus, since more than one contact can qualify.
    group.forEach((c) => {
      const stage = c.properties[DEAL_STAGE_PROPERTY];
      if (stage && !EXCLUDED_DEAL_STAGES.includes(stage)) {
        totals[c.id] += BONUS.dealStageNotExcluded;
      }
    });

    // Criterion 2: highest deal stage number in group (+16)
    const rankWinner = group.reduce((best, c) => {
      const val = Number(c.properties[DEAL_STAGE_RANK_PROPERTY]);
      if (Number.isNaN(val)) return best;
      if (!best) return c;
      const bestVal = Number(best.properties[DEAL_STAGE_RANK_PROPERTY]);
      const cIsBetter = HIGHER_RANK_IS_BETTER ? val > bestVal : val < bestVal;
      return cIsBetter ? c : best;
    }, null);
    if (rankWinner) totals[rankWinner.id] += BONUS.dealStageRank;

    // Criterion 3: owner matched (+8) — per-contact
    group.forEach((c) => {
      const matched = String(c.properties[OWNER_MATCH_PROPERTY]).toLowerCase() === 'true';
      if (matched) totals[c.id] += BONUS.ownerMatched;
    });

    // Criterion 4: most recent Aircall call timestamp (+4)
    const callWinner = group.reduce((best, c) => {
      const val = new Date(c.properties[AIRCALL_LAST_CALL_PROPERTY] || 0).getTime();
      if (!val) return best;
      if (!best) return c;
      const bestVal = new Date(best.properties[AIRCALL_LAST_CALL_PROPERTY] || 0).getTime();
      return val > bestVal ? c : best;
    }, null);
    if (callWinner) totals[callWinner.id] += BONUS.latestCall;

    // Criterion 5: email known (+2) — per-contact
    group.forEach((c) => {
      if (c.properties.email) totals[c.id] += BONUS.emailKnown;
    });

    // Criterion 6: created first / earliest createdate (+1)
    const createdWinner = group.reduce((best, c) => {
      const val = new Date(c.properties.createdate).getTime();
      if (!best) return c;
      const bestVal = new Date(best.properties.createdate).getTime();
      return val < bestVal ? c : best;
    }, null);
    if (createdWinner) totals[createdWinner.id] += BONUS.createdFirst;

    // 4. Determine overall winner (highest total). Tie-break: earliest createdate.
    let winner = null;
    group.forEach((c) => {
      if (!winner) {
        winner = c;
        return;
      }
      const cTotal = totals[c.id];
      const winnerTotal = totals[winner.id];
      if (
        cTotal > winnerTotal ||
        (cTotal === winnerTotal &&
          new Date(c.properties.createdate) < new Date(winner.properties.createdate))
      ) {
        winner = c;
      }
    });

    console.log(
      `Duplicate group [${groupIds.join(', ')}] — winner: ${winner.id} (score ${totals[winner.id]})`
    );

    // 5. Associate every other group member directly to the winner.
    // Function 1 only guarantees each duplicate is linked to whichever
    // contact was originally normalized (the "hub") — not to every other
    // member of the group. If the winner isn't the hub, Function 4 would
    // otherwise only see one duplicate when it looks up the winner's
    // associations. This call is idempotent, so re-associating a pair
    // that's already linked (e.g. winner <-> hub) is harmless.
    const others = group.filter((c) => c.id !== winner.id);
    for (const other of others) {
      try {
        await associateContacts(winner.id, other.id);
      } catch (err) {
        console.error(JSON.stringify({
          event: 'associate_to_winner_failed',
          winnerId: winner.id,
          otherId: other.id,
          error: err.response?.data?.message || err.message || String(err),
        }));
      }
    }

    // 6. Update duplicate_status: winner -> "Primary Duplicate", rest -> "Duplicate"
    const updates = group.map((c) => ({
      id: c.id,
      properties: {
        duplicate_status: c.id === winner.id ? 'Primary Duplicate' : 'Duplicate',
      },
    }));

    await hubspotClient.crm.contacts.batchApi.update({ inputs: updates });

    return res.status(200).json({ status: 'ok', winnerId: winner.id, totals });
  } catch (err) {
    console.error('Error comparing duplicate group:', err.message);
    return res.status(500).json({ error: 'Internal error' });
  }
}

module.exports = { handleComparePrimary };
