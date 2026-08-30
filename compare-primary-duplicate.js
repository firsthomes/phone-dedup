/**
 * Function 3 — Compare Duplicates & Determine Primary
 * Express route handler (separate file, same app as Function 1)
 *
 * TRIGGERED BY: HubSpot Workflow "Send a webhook" action, placed directly
 * after the "Set property value" action that writes primary_contact_score
 * (Function 2). No Custom Code action needed for the trigger itself — the
 * native "Send a webhook" action does a plain HTTP POST for free, same
 * pattern as Function 1's normalization-workflow webhook.
 *
 * WEBHOOK PAYLOAD EXPECTED (configure in the workflow's webhook body):
 *   { "contactId": "{{contact.hs_object_id}}" }
 *
 * ENV VARS REQUIRED (already set for Function 1):
 *   HUBSPOT_ACCESS_TOKEN
 *   WEBHOOK_SECRET
 */

const crypto = require('crypto');
const hubspot = require('@hubspot/api-client');

const hubspotClient = new hubspot.Client({
  accessToken: process.env.HUBSPOT_ACCESS_TOKEN,
});

// --- CONFIG -------------------------------------------------------------
// Weights use powers of 2 so the score encodes a strict 6-level priority
// hierarchy shared with Function 2 (which owns the interleaved criteria
// 1, 3, 5). Each weight strictly outweighs the sum of every weight below
// it, guaranteeing a higher-priority criterion always wins regardless of
// how many lower-priority criteria are also true.
//
// Combined hierarchy (see Function 2 for criteria 1, 3, 5):
//   1. Deal stage NOT excluded              -> 32   (Function 2)
//   2. Highest deal stage number in group   -> 16   (this function)
//   3. Owner matched                        -> 8    (Function 2)
//   4. Most recent Aircall timestamp        -> 4    (this function)
//   5. Email known                          -> 2    (Function 2)
//   6. Earliest createdate in group         -> 1    (this function)
const BONUS = {
  dealStageRank: 16,
  latestCall: 4,
  createdFirst: 1,
};

const DEAL_STAGE_RANK_PROPERTY = 'associated_deal_stage_number';
const AIRCALL_LAST_CALL_PROPERTY = 'aircall_last_call_at';

// Confirmed: a HIGHER number means a more advanced/better deal stage.
const HIGHER_RANK_IS_BETTER = true;

function isValidSignature(req) {
  const secret = process.env.WEBHOOK_SECRET;
  const provided = req.headers['x-webhook-secret'];

  if (process.env.DEBUG_WEBHOOK === 'true') {
    console.log('--- Webhook signature debug ---');
    console.log('WEBHOOK_SECRET loaded from .env:', secret ? `yes (length ${secret.length})` : 'NO — undefined');
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
        'primary_contact_score',
        DEAL_STAGE_RANK_PROPERTY,
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

    // 3. Running totals, seeded with each contact's Function 2 score
    const totals = {};
    group.forEach((c) => {
      totals[c.id] = Number(c.properties.primary_contact_score) || 0;
    });

    // Criterion A: highest deal stage rank (+50)
    const rankWinner = group.reduce((best, c) => {
      const val = Number(c.properties[DEAL_STAGE_RANK_PROPERTY]);
      if (Number.isNaN(val)) return best;
      if (!best) return c;
      const bestVal = Number(best.properties[DEAL_STAGE_RANK_PROPERTY]);
      const cIsBetter = HIGHER_RANK_IS_BETTER ? val > bestVal : val < bestVal;
      return cIsBetter ? c : best;
    }, null);
    if (rankWinner) totals[rankWinner.id] += BONUS.dealStageRank;

    // Criterion B: most recent Aircall call timestamp (+30)
    const callWinner = group.reduce((best, c) => {
      const val = new Date(c.properties[AIRCALL_LAST_CALL_PROPERTY] || 0).getTime();
      if (!val) return best;
      if (!best) return c;
      const bestVal = new Date(best.properties[AIRCALL_LAST_CALL_PROPERTY] || 0).getTime();
      return val > bestVal ? c : best;
    }, null);
    if (callWinner) totals[callWinner.id] += BONUS.latestCall;

    // Criterion C: created first / earliest createdate (+20)
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

    // 5. Update duplicate_status: winner -> "Primary Duplicate", rest -> "Duplicate"
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