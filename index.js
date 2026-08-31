require('dotenv').config();
const express = require('express');
const { handleComparePrimary } = require('./compare-primary-duplicate');
const crypto = require('crypto');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const app = express();
app.set('trust proxy', true); // Required behind ngrok/Railway so req.protocol reports https correctly
const ACCESS_TOKEN = process.env.HUBSPOT_ACCESS_TOKEN;

const hubspot = axios.create({
  baseURL: 'https://api.hubapi.com',
  headers: { Authorization: `Bearer ${ACCESS_TOKEN}` },
});

const AUDIT_LOG_PATH = path.join(__dirname, 'audit-snapshots.log');

async function fetchContact(contactId) {
  const res = await hubspot.get(`/crm/v3/objects/contacts/${contactId}`, {
    params: { properties: 'phone,duplicate_status' },
  });
  return res.data;
}

async function findMatches(phone, excludeContactId) {
  const res = await hubspot.post('/crm/v3/objects/contacts/search', {
    filterGroups: [
      {
        filters: [{ propertyName: 'phone', operator: 'EQ', value: phone }],
      },
    ],
    properties: ['phone', 'duplicate_status'],
    limit: 10,
  });
  return res.data.results.filter((r) => r.id !== excludeContactId);
}

async function updateContactProperties(contactId, properties) {
  await hubspot.patch(`/crm/v3/objects/contacts/${contactId}`, { properties });
}

async function associateContacts(contactIdA, contactIdB) {
  // Default (unlabeled) contact-to-contact association.
  // Must send an explicit empty JSON body + Content-Type header — HubSpot's
  // API gateway returns 415 if a PUT arrives with no body/content-type at all.
  await hubspot.put(
    `/crm/v4/objects/contact/${contactIdA}/associations/default/contact/${contactIdB}`,
    {},
    { headers: { 'Content-Type': 'application/json' } }
  );
}

async function processContactForDuplicates(contactId) {
  const contact = await fetchContact(contactId);
  const phone = contact.properties.phone;

  if (!phone) {
    console.log(`Contact ${contactId} has no phone number yet — skipping`);
    return;
  }

  const matches = await findMatches(phone, contactId);

  if (matches.length === 0) {
    console.log(`Contact ${contactId}: no duplicates found for ${phone}`);
    return;
  }

  console.log(`Contact ${contactId}: found ${matches.length} potential duplicate(s):`, matches.map((m) => m.id));

  // Tag this contact as a duplicate (unless it's already the Primary — don't downgrade it)
  if (contact.properties.duplicate_status !== 'Primary Duplicate') {
    await updateContactProperties(contactId, { duplicate_status: 'Duplicate' });
  }

  for (const match of matches) {
    await associateContacts(contactId, match.id);

    if (match.properties.duplicate_status !== 'Primary Duplicate') {
      await updateContactProperties(match.id, { duplicate_status: 'Duplicate' });
    }
  }
}

// No raw-body capture needed anymore — we're not hashing the request body,
// just comparing a shared-secret header.
app.use(express.json());

const WEBHOOK_SECRET = process.env.WORKFLOW_WEBHOOK_SECRET;

function isValidWebhookSecret(req) {
  const provided = req.headers['x-webhook-secret'];
  const debug = process.env.DEBUG_WEBHOOK === 'true';

  if (debug) {
    console.log('--- Webhook secret debug ---');
    console.log('WEBHOOK_SECRET loaded:', WEBHOOK_SECRET ? `yes (${WEBHOOK_SECRET.length} chars)` : 'NO — undefined/empty');
    console.log('x-webhook-secret header received:', provided ? `yes (${provided.length} chars)` : 'MISSING');
    console.log('all headers:', req.headers);
    console.log('body:', req.body);
  }

  if (!WEBHOOK_SECRET) {
    console.warn('Rejecting: WORKFLOW_WEBHOOK_SECRET is not set — check .env and restart the server');
    return false;
  }
  if (!provided) {
    console.warn('Rejecting: no x-webhook-secret header on the request');
    return false;
  }

  const providedBuffer = Buffer.from(provided);
  const expectedBuffer = Buffer.from(WEBHOOK_SECRET);

  // Lengths must match before timingSafeEqual, or it throws instead of returning false
  if (providedBuffer.length !== expectedBuffer.length) {
    if (debug) console.log(`Length mismatch: received ${providedBuffer.length} chars, expected ${expectedBuffer.length} chars`);
    return false;
  }
  return crypto.timingSafeEqual(providedBuffer, expectedBuffer);
}

app.post('/webhooks/contact-normalized', (req, res) => {
  // Respond immediately — same reasoning as before, ack fast and process after
  res.status(200).send('OK');

  if (!isValidWebhookSecret(req)) return;

  const contactId = req.body?.contactID;

  if (!contactId) {
    console.warn('Rejected: payload had no contactID', req.body);
    return;
  }

  console.log('Workflow webhook received for contact:', contactId);

  processContactForDuplicates(String(contactId)).catch((err) => {
    console.error(`Failed to process contact ${contactId}:`, {
      status: err.response?.status,
      url: err.config?.url,
      data: err.response?.data,
      message: err.message,
    });
  });
});

app.post('/webhooks/compare-primary', handleComparePrimary);

app.post('/internal/audit-snapshot', (req, res) => {
  if (!isValidWebhookSecret(req)) {
    return res.status(401).json({ error: 'Invalid signature' });
  }

  const entry = JSON.stringify(req.body) + '\n';
  fs.appendFile(AUDIT_LOG_PATH, entry, (err) => {
    if (err) {
      console.error('Failed to write audit snapshot:', err.message);
      return res.status(500).json({ error: 'Failed to persist snapshot' });
    }
    return res.status(200).json({ status: 'ok' });
  });
});

app.get('/health', (req, res) => res.status(200).send('OK'));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on port ${PORT}`));
