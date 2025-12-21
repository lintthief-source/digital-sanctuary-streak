import crypto from 'crypto';
import { Buffer } from 'buffer';

// Use the NEW variable here
const WEBHOOK_SECRET = process.env.SHOPIFY_WEBHOOK_SECRET; 
const ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const REWARD_PERCENT = 0.05; 

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

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  try {
    const hmacHeader = req.headers['x-shopify-hmac-sha256'];
    const rawBody = await getRawBody(req);
    
    // Verify using the WEBHOOK_SECRET
    const generatedHash = crypto
      .createHmac('sha256', WEBHOOK_SECRET)
      .update(rawBody)
      .digest('base64');

    if (generatedHash !== hmacHeader) {
      console.error("HMAC Mismatch - Check WEBHOOK_SECRET");
      return res.status(401).send('Unauthorized');
    }

    const order = JSON.parse(rawBody.toString());
    const customerId = order.customer?.admin_graphql_api_id;

    if (!customerId) return res.status(200).send('No customer');

    const subtotal = parseFloat(order.subtotal_price || 0);
    const rewardAmount = (subtotal * REWARD_PERCENT).toFixed(2);

    const mutation = `
      mutation Credit($id: ID!, $creditInput: StoreCreditAccountCreditInput!) {
        storeCreditAccountCredit(id: $id, creditInput: $creditInput) { userErrors { message } }
      }
    `;

    await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/2024-07/graphql.json`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': ADMIN_ACCESS_TOKEN,
      },
      body: JSON.stringify({ 
        query: mutation, 
        variables: {
          id: customerId,
          creditInput: {
            creditAmount: { amount: rewardAmount, currencyCode: order.currency }
          }
        } 
      }),
    });

    return res.status(200).send(`Success: Issued $${rewardAmount}`);

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
