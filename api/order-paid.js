import crypto from 'crypto';
import { Buffer } from 'buffer';

const WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET; 
const ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;

export const config = {
  api: { bodyParser: false },
};

async function getRawBody(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

async function shopifyGraphql(query, variables) {
  const response = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/2024-07/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': ADMIN_ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  return await response.json();
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  try {
    const hmacHeader = req.headers['x-shopify-hmac-sha256'];
    const rawBody = await getRawBody(req);
    
    const generatedHash = crypto
      .createHmac('sha256', WEBHOOK_SECRET)
      .update(rawBody)
      .digest('base64');

    if (generatedHash !== hmacHeader) {
      return res.status(401).send('Unauthorized');
    }

    const order = JSON.parse(rawBody.toString());
    const customerId = order.customer?.admin_graphql_api_id;
    const orderId = order.admin_graphql_api_id;

    if (!customerId) return res.status(200).send('Guest checkout');

    // --- 1. FETCH DATA & IDEMPOTENCY CHECK ---
    const initialData = await shopifyGraphql(`
      query getDetails($orderId: ID!, $customerId: ID!) {
        order(id: $orderId) { 
          locked: metafield(namespace: "custom", key: "rewardlevel") { value } 
        }
        customer(id: $customerId) { 
          rewardlevel: metafield(namespace: "custom", key: "rewardlevel") { value } 
        }
      }
    `, { orderId, customerId });

    // Stop if order already has a rewardlevel metafield
    if (initialData.data?.order?.locked?.value) {
      console.log(`Order ${order.name} already locked. Skipping.`);
      return res.status(200).send('Order already processed');
    }

    // Determine the percentage (Customer Metafield or Default 5)
    const rewardPercent = initialData.data?.customer?.rewardlevel?.value 
      ? parseInt(initialData.data.customer.rewardlevel.value) 
      : 5;

    // --- 2. CALCULATION ---
    const subtotal = parseFloat(order.subtotal_price || 0);
    const rewardAmount = (subtotal * (rewardPercent / 100)).toFixed(2);

    if (parseFloat(rewardAmount) <= 0) return res.status(200).send('Reward amount zero');

    // --- 3. STEP A: ISSUE STORE CREDIT ---
    const creditMutation = `
      mutation issueCredit($id: ID!, $amount: MoneyInput!) {
        storeCreditAccountCredit(id: $id, creditInput: { creditAmount: $amount }) {
          userErrors { message }
        }
      }
    `;
    const creditRes = await shopifyGraphql(creditMutation, { 
      id: customerId, 
      amount: { amount: rewardAmount, currencyCode: order.currency } 
    });

    if (creditRes.errors || creditRes.data?.storeCreditAccountCredit?.userErrors?.length > 0) {
      console.error('Credit Error:', creditRes.errors || creditRes.data.storeCreditAccountCredit.userErrors);
      return res.status(400).send('Failed to issue credit');
    }

    // --- 4. STEP B: LOCK THE ORDER & UPDATE NOTE ---
    const updateMutation = `
      mutation updateOrderAndCustomer($customerId: ID!, $note: String!, $metafields: [MetafieldsSetInput!]!) {
        customerUpdate(input: { id: $customerId, note: $note }) { userErrors { message } }
        metafieldsSet(metafields: $metafields) { userErrors { message } }
      }
    `;
    
    const updateRes = await shopifyGraphql(updateMutation, {
      customerId: customerId,
      note: `${order.customer?.note || ''}\n[SANCTUARY] Issued $${rewardAmount} credit (Rate: ${rewardPercent}%)`.trim(),
      metafields: [{
        ownerId: orderId,
        namespace: "custom",
        key: "rewardlevel",
        value: rewardPercent.toString(),
        type: "integer"
      }]
    });

    console.log(`Successfully processed Order ${order.name}: $${rewardAmount} at ${rewardPercent}%`);

    return res.status(200).json({ 
      success: true, 
      order: order.name, 
      reward: rewardAmount, 
      rate: rewardPercent 
    });

  } catch (error) {
    console.error('Sanctuary Worker Fatal Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
