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

    // --- 1. DOUBLE-DIP CHECK & FETCH CUSTOMER LEVEL ---
    // We check the order for an existing rewardlevel to ensure we don't process twice
    const statusQuery = `
      query getOrderAndCustomer($orderId: ID!, $customerId: ID!) {
        order(id: $orderId) {
          locked: metafield(namespace: "custom", key: "rewardlevel") { value }
        }
        customer(id: $customerId) {
          rewardlevel: metafield(namespace: "custom", key: "rewardlevel") { value }
        }
      }
    `;
    
    const statusData = await shopifyGraphql(statusQuery, { orderId, customerId });
    
    // IF THE ORDER IS ALREADY LOCKED, EXIT
    if (statusData.data?.order?.locked?.value) {
      console.log(`Order ${order.name} already processed. Skipping.`);
      return res.status(200).send('Order already processed');
    }

    // Determine Reward Percent (Default to 5)
    const rewardPercentInt = statusData.data?.customer?.rewardlevel?.value 
      ? parseInt(statusData.data.customer.rewardlevel.value) 
      : 5;
    
    const rewardMultiplier = rewardPercentInt / 100;

    // --- 2. CALCULATE REWARD ---
    const subtotal = parseFloat(order.subtotal_price || 0);
    const rewardAmount = (subtotal * rewardMultiplier).toFixed(2);

    if (parseFloat(rewardAmount) <= 0) return res.status(200).send('No reward');

    // --- 3. ATOMIC UPDATE: CREDIT + NOTE + LOCK ---
    const mutation = `
      mutation SanctuaryComplete($id: ID!, $creditInput: StoreCreditAccountCreditInput!, $customerInput: CustomerInput!, $orderMetafields: [MetafieldsSetInput!]!) {
        storeCreditAccountCredit(id: $id, creditInput: $creditInput) { 
          userErrors { message } 
        }
        customerUpdate(input: $customerInput) {
          userErrors { message }
        }
        metafieldsSet(metafields: $orderMetafields) {
          userErrors { message }
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
        note: `${order.customer?.note || ''}\n[SANCTUARY] Issued $${rewardAmount} credit for Order ${order.name} at ${rewardPercentInt}%`.trim()
      },
      orderMetafields: [
        {
          ownerId: orderId,
          namespace: "custom",
          key: "rewardlevel",
          value: rewardPercentInt.toString(),
          type: "integer"
        }
      ]
    };

    const result = await shopifyGraphql(mutation, variables);
    
    // Check for GraphQL errors
    const errors = [
      ...(result.data?.storeCreditAccountCredit?.userErrors || []),
      ...(result.data?.customerUpdate?.userErrors || []),
      ...(result.data?.metafieldsSet?.userErrors || [])
    ];

    if (errors.length > 0) {
      console.error('GraphQL User Errors:', errors);
      return res.status(400).json({ errors });
    }

    return res.status(200).json({ 
      status: "Success",
      order: order.name,
      reward: `$${rewardAmount}`,
      rate: `${rewardPercentInt}%`
    });

  } catch (error) {
    console.error('Sanctuary Worker Error:', error);
    return res.status(500).json({ error: error.message });
  }
}
