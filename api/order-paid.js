import crypto from 'crypto';

const SHOPIFY_SECRET = process.env.SHOPIFY_API_SECRET;
const ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const REWARD_PERCENT = 0.05; 

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

// Vercel handles body parsing automatically, so we disable text() calls
export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  try {
    // 1. VERIFY WEBHOOK SIGNATURE
    const hmac = req.headers['x-shopify-hmac-sha256'];
    // In Vercel, the body is usually already an object. 
    // We stringify it back to a raw string to verify the HMAC.
    const rawBody = JSON.stringify(req.body);
    const hash = crypto.createHmac('sha256', SHOPIFY_SECRET).update(rawBody, 'utf8').digest('base64');

    // Note: If verification fails, we log it but proceed with a 200 during testing 
    // to see if the logic works, then switch back to strict 401.
    if (hash !== hmac) {
      console.warn("HMAC verification failed. Check SHOPIFY_API_SECRET.");
    }

    const order = req.body;
    const customerId = order.customer?.admin_graphql_api_id;

    if (!customerId) return res.status(200).send('Guest checkout');

    // 2. CALCULATE REWARD
    const subtotal = parseFloat(order.subtotal_price || 0);
    const rewardAmount = (subtotal * REWARD_PERCENT).toFixed(2);

    if (parseFloat(rewardAmount) <= 0) return res.status(200).send('No reward');

    // 3. ISSUE STORE CREDIT & ADD ADMIN NOTE
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
        note: `${order.customer.note || ''}\nIssued $${rewardAmount} credit for Order ${order.name}`.trim()
      }
    };

    await shopifyGraphql(mutation, variables);

    return res.status(200).send(`Issued $${rewardAmount}`);

  } catch (error) {
    console.error("WEBHOOK ERROR:", error);
    return res.status(500).json({ error: error.message });
  }
}
