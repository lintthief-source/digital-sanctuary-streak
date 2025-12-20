const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;

// UPDATE THIS to your actual Vercel URL
const MY_WEBHOOK_URL = "https://digital-sanctuary-streak.vercel.app/api/webhook-comment"; 

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
  try {
    const mutation = `
      mutation webhookSubscriptionCreate($topic: WebhookSubscriptionTopic!, $webhookSubscription: WebhookSubscriptionInput!) {
        webhookSubscriptionCreate(topic: $topic, webhookSubscription: $webhookSubscription) {
          userErrors {
            field
            message
          }
          webhookSubscription {
            id
          }
        }
      }
    `;

    const variables = {
      topic: "COMMENTS_CREATE",
      webhookSubscription: {
        callbackUrl: MY_WEBHOOK_URL,
        format: "JSON"
      }
    };

    const result = await shopifyGraphql(mutation, variables);

    if (result.data?.webhookSubscriptionCreate?.userErrors?.length > 0) {
        return res.status(400).json({ error: result.data.webhookSubscriptionCreate.userErrors });
    }

    return res.status(200).json({ 
        message: "SUCCESS! Webhook Registered.", 
        details: result.data 
    });

  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
