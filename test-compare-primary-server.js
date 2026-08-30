/**
 * TEMPORARY test harness for Function 3 (compare-primary-duplicate.js)
 *
 * This is NOT part of the production app — it's just a standalone Express
 * server so you can run this one route locally and tunnel it with ngrok,
 * the same way you tested Function 1. Once it works, wire the route into
 * your main index.js and delete this file.
 *
 * SETUP:
 *   1. Make sure your .env has HUBSPOT_ACCESS_TOKEN and WEBHOOK_SECRET set
 *      (same values you're already using for Function 1)
 *   2. npm install express dotenv @hubspot/api-client   (if not already installed)
 *   3. node test-compare-primary-server.js
 *   4. In another terminal: ngrok http 3001
 *   5. Point a HubSpot "Send a webhook" test, or a curl/Postman request,
 *      at the ngrok HTTPS URL + /webhooks/compare-primary
 *
 * TEST PAYLOAD (body):
 *   { "contactId": "12345" }
 *
 * TEST HEADERS:
 *   X-Webhook-Secret: <same value as WEBHOOK_SECRET in .env>
 *   Content-Type: application/json
 */

require('dotenv').config();
const express = require('express');
const { handleComparePrimary } = require('./compare-primary-duplicate');

const app = express();
app.use(express.json());

app.post('/webhooks/compare-primary', handleComparePrimary);

const PORT = process.env.TEST_PORT || 3001;
app.listen(PORT, () => {
  console.log(`Function 3 test server running locally on http://localhost:${PORT}`);
  console.log(`Run "ngrok http ${PORT}" in another terminal, then POST to:`);
  console.log(`  https://paycheck-cyclist-conjure.ngrok-free.dev/webhooks/compare-primary`);
});
