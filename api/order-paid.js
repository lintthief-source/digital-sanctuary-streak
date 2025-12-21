import crypto from 'crypto';
import { Buffer } from 'buffer';

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

async function shopifyGraphql(query, variables) {
  const response = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/2025-10/graphql.json`, {
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

    if (generatedHash !== hmacHeader) return res.status(401).send('Unauthorized');

    const order = JSON.parse(rawBody.toString());
    const customerId = order.customer?.admin_graphql_api_id;

    if (!customerId) return res.status(200).send('Guest checkout');

    const subtotal = parseFloat(order.subtotal_price || 0);
    const rewardAmount = (subtotal * REWARD_PERCENT).toFixed(2);

    if (parseFloat(rewardAmount) <= 0) return res.status(200).send('No reward');

    // FIXED MUTATION: notify is now a top-level argument, not inside creditInput
    const mutation = `
      mutation CreditWithNotify($id: ID!, $creditInput: StoreCreditAccountCreditInput!, $notify: Boolean!) {
        storeCreditAccountCredit(id: $id, creditInput: $creditInput, notify: $notify) { 
          userErrors { message } 
        }
        customerUpdate(input: { id: $id, note: "${order.customer?.note || ''}\nIssued $${rewardAmount} credit for Order ${order.name}".trim() }) {
          customer { id }
          userErrors { message }
        }
      }
    `;

    const variables = {
      id: customerId,
      creditInput: {
        creditAmount: { amount: rewardAmount, currencyCode: order.currency }
      },
      notify: true // Correctly placed as a separate variable
    };

    const result = await shopifyGraphql(mutation, variables);

    if (result.errors || result.data?.storeCreditAccountCredit?.userErrors?.length > 0) {
      console.error("Shopify Error:", JSON.stringify(result));
      return res.status(500).json({ error: "Mutation Failed", details: result });
    }

    return res.status(200).send(`Success: Issued $${rewardAmount}`);

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
