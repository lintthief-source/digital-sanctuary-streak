import crypto from 'crypto';

const SHOPIFY_SECRET = process.env.SHOPIFY_API_SECRET; 
const ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;

const REWARD_AMOUNT = "0.05"; 
const CURRENCY_CODE = 'CAD'; 

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
  // 1. LOG EVERYTHING (The Snitch)
  console.log("---------------------------------");
  console.log("📨 WEBHOOK RECEIVED");
  console.log("Headers:", JSON.stringify(req.headers, null, 2));
  console.log("Body Payload:", JSON.stringify(req.body, null, 2)); // <--- THIS IS KEY
  console.log("---------------------------------");

  if (req.method !== 'POST') {
    console.log("❌ Error: Method not allowed");
    return res.status(405).send('Method Not Allowed');
  }

  const comment = req.body;

  // 2. CHECK DATA
  if (!comment.email || !comment.article_id) {
    console.log("⚠️ SKIPPING: Missing critical data.");
    console.log(`Email found: ${comment.email}`);
    console.log(`Article ID found: ${comment.article_id}`);
    return res.status(200).send('Skipped - Missing Data');
  }

  try {
    // 3. FIND CUSTOMER
    console.log(`🔍 Looking up customer: ${comment.email}`);
    const findCustomerQuery = `
      query($query: String!) {
        customers(first: 1, query: $query) {
          nodes {
            id
            email
            history: metafield(namespace: "custom", key: "devotional_comment_history") { value }
          }
        }
      }
    `;

    const customerResult = await shopifyGraphql(findCustomerQuery, { query: `email:${comment.email}` });
    
    // Log the search result to see if we found them
    console.log("🔍 Customer Lookup Result:", JSON.stringify(customerResult, null, 2));

    const customer = customerResult.data?.customers?.nodes[0];

    if (!customer) {
      console.log("❌ SKIPPING: No matching customer found in Shopify.");
      return res.status(200).send('Not a Customer');
    }

    // 4. CHECK HISTORY
    const articleId = String(comment.article_id);
    let historyLog = [];
    try {
        if (customer.history?.value) {
            historyLog = JSON.parse(customer.history.value);
        }
    } catch (e) {
        historyLog = [];
    }

    if (historyLog.includes(articleId)) {
        console.log(`⚠️ SKIPPING: Already rewarded for Article ${articleId}`);
        return res.status(200).send('Already Rewarded');
    }

    // 5. PAY REWARD
    console.log(`💰 PAYING: Awarding $${REWARD_AMOUNT} to ${customer.id}`);
    historyLog.push(articleId);

    const mutation = `
        mutation GiveCommentReward($id: ID!, $input: CustomerInput!, $creditInput: StoreCreditAccountCreditInput!) {
            customerUpdate(input: $input) { userErrors { message field } }
            storeCreditAccountCredit(id: $id, creditInput: $creditInput) { userErrors { message field } }
        }
    `;

    const payResult = await shopifyGraphql(mutation, {
        id: customer.id,
        input: {
            id: customer.id,
            metafields: [
                { namespace: "custom", key: "devotional_comment_history", value: JSON.stringify(historyLog), type: "json" }
            ]
        },
        creditInput: {
            creditAmount: { amount: REWARD_AMOUNT, currencyCode: CURRENCY_CODE }
        }
    });

    console.log("✅ PAYMENT RESULT:", JSON.stringify(payResult, null, 2));

    return res.status(200).json({ success: true, details: payResult });

  } catch (error) {
    console.error("❌ CRITICAL ERROR:", error);
    return res.status(500).send('Server Error');
  }
}
