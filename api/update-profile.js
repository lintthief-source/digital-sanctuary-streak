// /api/update-profile.js
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
  // 1. CORS Headers (Infrastructure Level)
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*'); 
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { customerId, firstName, lastName, nickname, dob, address } = req.body;

  try {
    const customerGid = `gid://shopify/Customer/${customerId}`;

    // 2. CONSTRUCT THE GRAPHQL MUTATION
    const mutation = `
      mutation customerUpdate($input: CustomerInput!) {
        customerUpdate(input: $input) {
          customer {
            id
            firstName
            lastName
          }
          userErrors {
            field
            message
          }
        }
      }
    `;

    // 3. BUILD THE INPUT OBJECT
    const input = {
      id: customerGid,
      firstName: firstName,
      lastName: lastName,
      metafields: [
        { namespace: "custom", key: "nickname", value: nickname, type: "single_line_text_field" },
        { namespace: "facts", key: "birth_date", value: dob, type: "date" }
      ]
    };

    // Add address if provided
    if (address && address.address1) {
      input.addresses = [{
        address1: address.address1,
        city: address.city,
        province: address.province,
        zip: address.zip,
        country: "CA", // Shopify GraphQL expects ISO codes
        firstName: firstName,
        lastName: lastName
      }];
    }

    // 4. THE HANDSHAKE
    const result = await shopifyGraphql(mutation, { input });

    if (result.errors || result.data?.customerUpdate?.userErrors?.length > 0) {
      console.error("Shopify GraphQL Error:", result.errors || result.data.customerUpdate.userErrors);
      return res.status(400).json({ 
        success: false, 
        error: "Update rejected by Shopify", 
        details: result.errors || result.data.customerUpdate.userErrors 
      });
    }

    return res.status(200).json({ success: true, message: "Sanctuary Records Updated" });

  } catch (error) {
    console.error("CRITICAL SYSTEM ERROR:", error);
    return res.status(500).json({ success: false, error: error.message });
  }
}
