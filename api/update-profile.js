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
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*'); 
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { customerId, email, firstName, lastName, nickname, dob, phone, address, consents } = req.body;

  try {
    const customerGid = `gid://shopify/Customer/${customerId}`;

    const mutation = `
      mutation customerUpdate($input: CustomerInput!) {
        customerUpdate(input: $input) {
          customer { id email }
          userErrors { field message }
        }
      }
    `;

    const input = {
      id: customerGid,
      email: email, // Update email
      firstName: firstName,
      lastName: lastName,
      phone: phone, // Update main contact phone
      emailMarketingConsent: {
        marketingState: consents.email ? "SUBSCRIBED" : "UNSUBSCRIBED"
      },
      smsMarketingConsent: {
        marketingState: consents.sms ? "SUBSCRIBED" : "UNSUBSCRIBED"
      },
      metafields: [
        { namespace: "custom", key: "nickname", value: nickname, type: "single_line_text_field" },
        { namespace: "facts", key: "birth_date", value: dob, type: "date" }
      ]
    };

    if (address && address.address1) {
      input.addresses = [{
        address1: address.address1,
        city: address.city,
        province: address.province,
        zip: address.zip,
        country: "CA",
        firstName: firstName,
        lastName: lastName,
        phone: phone // Sync phone to shipping address
      }];
    }

    const result = await shopifyGraphql(mutation, { input });

    if (result.data?.customerUpdate?.userErrors?.length > 0) {
      const error = result.data.customerUpdate.userErrors[0];
      // Check if email error is "taken"
      if (error.message.toLowerCase().includes("taken") || error.message.toLowerCase().includes("exists")) {
         return res.status(400).json({ success: false, error: "EMAIL_EXISTS" });
      }
      return res.status(400).json({ success: false, error: error.message });
    }

    return res.status(200).json({ success: true });

  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}
