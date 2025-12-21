import crypto from 'crypto';
import { Buffer } from 'buffer';

const SHOPIFY_SECRET = process.env.SHOPIFY_API_SECRET;
const ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const REWARD_PERCENT = 0.05; 

// THIS IS THE FIX: Tells Vercel to give us the raw body
export const config = {
  api: {
    bodyParser: false,
  },
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
    const hmac = req.headers['x-shopify-hmac-sha256'];
    const rawBody = await getRawBody(req); // Capture the exact raw text
    
    // Verify HMAC
    const hash = crypto.createHmac('sha256', SHOPIFY_SECRET).update(rawBody).digest('base64');

    if (hash !== hmac) {
      console.error("HMAC verification failed. Check SHOPIFY_API_SECRET.");
      return res.status(401).send('Unauthorized');
    }

    // Now we parse it manually since we disabled the auto-parser
    const order = JSON.parse(rawBody.toString());
    const customerId = order.customer?.admin_graphql_api_id;

    if (!customerId) return res.status(200).send('Guest checkout');

    const subtotal = parseFloat(order.subtotal_price || 0);
    const rewardAmount = (subtotal * REWARD_PERCENT).toFixed(2);

    if (parseFloat(rewardAmount) <= 0) return res.status(200).send('No reward');

    const mutation = `
      mutation CreditAndNote($id: ID!, $creditInput: StoreCreditAccountCreditInput!, $customerInput: CustomerInput!) {
        storeCreditAccountCredit(id: $id, creditInput: $creditInput) { 
          userErrors { message } 
        }
        customerUpdate(input: $customerInput) {
          customer { id note }
          userErrors { field message }
        }
      }
    `;

    const variables = {
      id: customerId,
      creditInput: {
        creditAmount: { amount: rewardAmount, currencyCode: order.currency }
      },
      customerInput: {
        id: customerId,
        note: `${order.customer?.note || ''}\nIssued $${rewardAmount} credit for Order ${order.name}`.trim()
      }
    };

    await shopifyGraphql(mutation, variables);
    return res.status(200).send(`Issued $${rewardAmount}`);

  } catch (error) {
    console.error("WEBHOOK ERROR:", error);
    return res.status(500).json({ error: error.message });
  }
}
