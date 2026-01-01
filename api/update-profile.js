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

    // 1. IDENTITY & ADDRESS (No Consent here)
    const profileMutation = `
      mutation customerUpdate($input: CustomerInput!) {
        customerUpdate(input: $input) {
          customer { id }
          userErrors { field message }
        }
      }
    `;

    const profileInput = {
      id: customerGid,
      email,
      firstName,
      lastName,
      phone,
      metafields: [
        { namespace: "custom", key: "nickname", value: nickname, type: "single_line_text_field" },
        { namespace: "facts", key: "birth_date", value: dob, type: "date" }
      ]
    };

    if (address && address.address1) {
      profileInput.addresses = [{
        ...address,
        firstName,
        lastName,
        phone,
        country: "CA"
      }];
    }

    const profileResult = await shopifyGraphql(profileMutation, { input: profileInput });

    if (profileResult.data?.customerUpdate?.userErrors?.length > 0) {
      const error = profileResult.data.customerUpdate.userErrors[0];
      if (error.message.toLowerCase().includes("taken")) return res.status(400).json({ success: false, error: "EMAIL_EXISTS" });
      return res.status(400).json({ success: false, error: error.message });
    }

    // 2. EMAIL CONSENT MUTATION
    const emailConsentMutation = `
      mutation customerEmailMarketingConsentUpdate($input: CustomerEmailMarketingConsentUpdateInput!) {
        customerEmailMarketingConsentUpdate(input: $input) {
          userErrors { field message }
        }
      }
    `;

    await shopifyGraphql(emailConsentMutation, {
      input: {
        customerId: customerGid,
        emailMarketingConsent: {
          marketingState: consents.email ? "SUBSCRIBED" : "UNSUBSCRIBED",
          marketingOptInLevel: "SINGLE_OPT_IN"
        }
      }
    });

    // 3. SMS CONSENT MUTATION
    const smsConsentMutation = `
      mutation customerSmsMarketingConsentUpdate($input: CustomerSmsMarketingConsentUpdateInput!) {
        customerSmsMarketingConsentUpdate(input: $input) {
          userErrors { field message }
        }
      }
    `;

    await shopifyGraphql(smsConsentMutation, {
      input: {
        customerId: customerGid,
        smsMarketingConsent: {
          marketingState: consents.sms ? "SUBSCRIBED" : "UNSUBSCRIBED",
          marketingOptInLevel: "SINGLE_OPT_IN"
        }
      }
    });

    return res.status(200).json({ success: true });

  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}
