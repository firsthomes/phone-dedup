/**
 * Function 2 — Primary Contact Score
 * HubSpot Workflow Custom Code Action (Node.js 16+)
 *
 * ENROLLMENT TRIGGER (set in the Workflow, not here):
 *   duplicate_status is known  (i.e. "Duplicate" OR "Primary Duplicate")
 *   -> both sides of a match get scored so Function 3 has something to compare.
 *
 * INPUT FIELDS REQUIRED (add these as Contact properties on this action):
 *   - email
 *   - owner_match                (confirm actual internal name)
 *   - associated_deal_stage      (confirm actual internal name — the
 *                                 "Associated Deal Stage" rollup property)
 *
 * No API calls needed — everything comes in via inputFields, so no
 * PRIVATE_APP_TOKEN secret or @hubspot/api-client dependency required.
 *
 * AFTER THIS ACTION: add a "Set property value" action that maps the
 * `primary_contact_score` output field onto the contact's custom property
 * of the same name.
 */

// --- CONFIG -----------------------------------------------------------
// Weights use powers of 2 so the score encodes a strict 6-level priority
// hierarchy shared with Function 3 (which owns the interleaved criteria
// 2, 4, 6). Each weight strictly outweighs the sum of every weight below
// it, guaranteeing a higher-priority criterion always wins regardless of
// how many lower-priority criteria are also true.
//
// Combined hierarchy (see Function 3 for criteria 2, 4, 6):
//   1. Deal stage NOT excluded              -> 32   (this function)
//   2. Highest deal stage number in group   -> 16   (Function 3)
//   3. Owner matched                        -> 8    (this function)
//   4. Most recent Aircall timestamp        -> 4    (Function 3)
//   5. Email known                          -> 2    (this function)
//   6. Earliest createdate in group         -> 1    (Function 3)
const WEIGHTS = {
  dealStageActive: 32,
  ownerMatch: 8,
  emailKnown: 2,
};

const EXCLUDED_DEAL_STAGES = [
  'closedlost',      // closed lost internal ID
  '3409668570',      // re-engage internal ID
  '1803137522',      // run re-engage internal ID
];

const OWNER_MATCH_PROPERTY = 'owner_match'; // confirm actual internal name
const ASSOCIATED_DEAL_STAGE_PROPERTY = 'associated_deal_stage'; // confirm actual internal name

exports.main = async (event, callback) => {
  const email = event.inputFields['email'];
  const ownerMatchValue = event.inputFields[OWNER_MATCH_PROPERTY];
  const dealStageValue = event.inputFields[ASSOCIATED_DEAL_STAGE_PROPERTY];

  const breakdown = {
    dealStageActive: false,
    ownerMatch: false,
    emailKnown: false,
  };

  let score = 0;

  // Criterion 1: associated deal stage is NOT one of the excluded stages
  if (dealStageValue && !EXCLUDED_DEAL_STAGES.includes(dealStageValue)) {
    score += WEIGHTS.dealStageActive;
    breakdown.dealStageActive = true;
  }

  // Criterion 2: deal & contact owner matched
  if (ownerMatchValue === 'true' || ownerMatchValue === true) {
    score += WEIGHTS.ownerMatch;
    breakdown.ownerMatch = true;
  }

  // Criterion 3: email is known (non-empty)
  if (email && String(email).trim() !== '') {
    score += WEIGHTS.emailKnown;
    breakdown.emailKnown = true;
  }

  callback({
    outputFields: {
      primary_contact_score: score,
      score_breakdown: JSON.stringify(breakdown),
    },
  });
};
