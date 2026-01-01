const ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;

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
  // Shopify App Proxy sends the ID in this specific header
  const customerId = req.headers['x-shopify-customer-id'];

  if (!customerId) {
    // If this hits, the Proxy isn't sending the ID or you're calling Vercel directly
    return res.status(401).json({ error: "No Identity Header found." });
  }

  const query = `
    query($id: ID!) {
      customer(id: $id) {
        emailMarketingConsent { marketingState }
        smsMarketingConsent { marketingState }
      }
    }
  `;

  try {
    const result = await shopifyGraphql(query, { id: `gid://shopify/Customer/${customerId}` });
    const customer = result.data?.customer;

    if (!customer) throw new Error("Customer not found in Shopify records.");

    return res.status(200).json({
      emailSubscribed: customer.emailMarketingConsent?.marketingState === "SUBSCRIBED",
      smsSubscribed: customer.smsMarketingConsent?.marketingState === "SUBSCRIBED"
    });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
