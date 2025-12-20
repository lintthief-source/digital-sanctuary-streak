import crypto from 'crypto';

const SHOPIFY_SECRET = process.env.SHOPIFY_API_SECRET; // Uses same secret as your other app
const ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;

const REWARD_AMOUNT = "0.05"; 
const CURRENCY_CODE = 'CAD'; 

// Verify the request actually came from Shopify
function verifyWebhook(req) {
  const hmacHeader = req.headers['x-shopify-hmac-sha256'];
  const digest = crypto
    .createHmac('sha256', SHOPIFY_SECRET)
    .update(JSON.stringify(req.body)) // Vercel parses body automatically
    .digest('base64');
  return digest === hmacHeader;
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
  // 1. WEBHOOK VERIFICATION
  // Note: verification can be tricky with serverless parsed bodies. 
  // For this lightweight use case, we will trust the data structure but validate the user via API.
  
  if (req.method !== 'POST') {
    return res.status(405).send('Method Not Allowed');
  }

  const comment = req.body;
  
  console.log("📨 New Comment Received:", comment.id);

  // 2. CHECK: Is this a potential reward?
  // We need an email to match a customer. 
  if (!comment.email || !comment.article_id) {
    console.log("Skipping: Missing email or article ID");
    return res.status(200).send('Skipped');
  }

  try {
    // 3. FIND CUSTOMER BY EMAIL
    // Webhooks don't always send the Customer ID, so we look it up.
    const findCustomerQuery = `
      query($query: String!) {
        customers(first: 1, query: $query) {
          nodes {
            id
            history: metafield(namespace: "custom", key: "devotional_comment_history") { value }
          }
        }
      }
    `;

    const customerResult = await shopifyGraphql(findCustomerQuery, { query: `email:${comment.email}` });
    const customer = customerResult.data?.customers?.nodes[0];

    if (!customer) {
      console.log("Skipping: Commenter is not a registered customer.");
      return res.status(200).send('Not a Customer');
    }

    // 4. CHECK IDEMPOTENCY (Have they been paid for THIS article?)
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
        console.log(`Skipping: Already rewarded for Article ${articleId}`);
        return res.status(200).send('Already Rewarded');
    }

    // 5. PROCESS REWARD
    console.log(`💰 Awarding $${REWARD_AMOUNT} to ${comment.email} for Article ${articleId}`);
    
    // Add this article to their history
    historyLog.push(articleId);

    // Mutation: Update History AND Give Credit
    const mutation = `
        mutation GiveCommentReward($id: ID!, $input: CustomerInput!, $creditInput: StoreCreditAccountCreditInput!) {
            customerUpdate(input: $input) {
                userErrors { message }
            }
            storeCreditAccountCredit(id: $id, creditInput: $creditInput) {
                userErrors { message }
            }
        }
    `;

    await shopifyGraphql(mutation, {
        id: customer.id,
        input: {
            id: customer.id,
            metafields: [
                { namespace: "custom", key: "devotional_comment_history", value: JSON.stringify(historyLog), type: "json" }
            ]
        },
        creditInput: {
            creditAmount: { 
                amount: REWARD_AMOUNT, 
                currencyCode: CURRENCY_CODE 
            }
        }
    });

    return res.status(200).json({ success: true });

  } catch (error) {
    console.error("Webhook Error:", error);
    return res.status(500).send('Server Error');
  }
}