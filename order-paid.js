import crypto from 'crypto';

const SHOPIFY_SECRET = process.env.SHOPIFY_API_SECRET;
const ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const REWARD_PERCENT = 0.05; // 5% back ($0.05 per $1.00)

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
  // Webhooks from Shopify are always POST requests
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  try {
    // 1. VERIFY WEBHOOK SIGNATURE
    const hmac = req.headers['x-shopify-hmac-sha256'];
    const body = await req.text(); // Need raw body for HMAC verification
    const hash = crypto.createHmac('sha256', SHOPIFY_SECRET).update(body, 'utf8').digest('base64');

    if (hash !== hmac) {
      console.error("Invalid Webhook Signature");
      return res.status(401).send('Unauthorized');
    }

    const order = JSON.parse(body);
    const customerId = order.customer?.admin_graphql_api_id;

    if (!customerId) return res.status(200).send('Guest checkout - no credit issued');

    // 2. CALCULATE REWARD
    // Using subtotal_price to exclude shipping and taxes
    const subtotal = parseFloat(order.subtotal_price || 0);
    const rewardAmount = (subtotal * REWARD_PERCENT).toFixed(2);

    if (parseFloat(rewardAmount) <= 0) return res.status(200).send('Amount too low for reward');

    // 3. ISSUE STORE CREDIT
    const creditMutation = `
      mutation Credit($id: ID!, $creditInput: StoreCreditAccountCreditInput!) {
        storeCreditAccountCredit(id: $id, creditInput: $creditInput) { 
          userErrors { message } 
        }
      }
    `;

    const variables = {
      id: customerId,
      creditInput: {
        creditAmount: { amount: rewardAmount, currencyCode: order.currency }
      }
    };

    const result = await shopifyGraphql(creditMutation, variables);
    
    if (result.errors || result.data?.storeCreditAccountCredit?.userErrors?.length > 0) {
      console.error("Credit Mutation Error:", JSON.stringify(result));
      return res.status(500).send('Mutation failed');
    }

    return res.status(200).send(`Success: Issued $${rewardAmount} credit`);

  } catch (error) {
    console.error("WEBHOOK CRITICAL ERROR:", error);
    return res.status(500).send('Internal Server Error');
  }
}