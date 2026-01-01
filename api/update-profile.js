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

  const { customerId, email, firstName, lastName, nickname, dob, phone, address, consents, changeSummary } = req.body;

  try {
    const customerGid = `gid://shopify/Customer/${customerId}`;
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    const location = `${req.headers['x-vercel-ip-city'] || 'Unknown City'}, ${req.headers['x-vercel-ip-country'] || 'CA'}`;

    // 1. FETCH EXISTING HISTORY FIRST
    const historyQuery = `query($id: ID!) { customer(id: $id) { audit: metafield(namespace: "custom", key: "profile_update_history") { value } } }`;
    const historyRes = await shopifyGraphql(historyQuery, { id: customerGid });
    
    let currentHistory = [];
    try {
      if (historyRes.data?.customer?.audit?.value) {
        currentHistory = JSON.parse(historyRes.data.customer.audit.value);
      }
    } catch (e) { currentHistory = []; }

    // 2. CREATE NEW ENTRY
    const newEntry = {
      date: new Date().toISOString(),
      location: location,
      ip: ip,
      details: changeSummary,
      accepted: true
    };
    currentHistory.unshift(newEntry); // Add to the top
    const updatedHistoryJson = JSON.stringify(currentHistory.slice(0, 10)); // Keep last 10 events

    // 3. EXECUTE TRIPLE HANDSHAKE (Profile, Email Consent, SMS Consent)
    // Profile & Metafields (Now includes the history update)
    const profileMutation = `mutation cu($i: CustomerInput!) { customerUpdate(input: $i) { customer { id } userErrors { field message } } }`;
    const profileInput = {
      id: customerGid, email, firstName, lastName, phone,
      metafields: [
        { namespace: "custom", key: "nickname", value: nickname, type: "single_line_text_field" },
        { namespace: "facts", key: "birth_date", value: dob, type: "date" },
        { namespace: "custom", key: "profile_update_history", value: updatedHistoryJson, type: "json" }
      ]
    };

    if (address && address.address1) {
      profileInput.addresses = [{ ...address, firstName, lastName, phone, country: "CA" }];
    }

    const pResult = await shopifyGraphql(profileMutation, { i: profileInput });
    if (pResult.data?.customerUpdate?.userErrors?.length > 0) {
      const err = pResult.data.customerUpdate.userErrors[0];
      if (err.message.toLowerCase().includes("taken")) return res.status(400).json({ success: false, error: "EMAIL_EXISTS" });
      return res.status(400).json({ success: false, error: err.message });
    }

    // Email & SMS Consents (Dedicated mutations)
    await shopifyGraphql(`mutation e($i: CustomerEmailMarketingConsentUpdateInput!) { customerEmailMarketingConsentUpdate(input: $i) { userErrors { message } } }`, {
      i: { customerId: customerGid, emailMarketingConsent: { marketingState: consents.email ? "SUBSCRIBED" : "UNSUBSCRIBED", marketingOptInLevel: "SINGLE_OPT_IN" } }
    });

    await shopifyGraphql(`mutation s($i: CustomerSmsMarketingConsentUpdateInput!) { customerSmsMarketingConsentUpdate(input: $i) { userErrors { message } } }`, {
      i: { customerId: customerGid, smsMarketingConsent: { marketingState: consents.sms ? "SUBSCRIBED" : "UNSUBSCRIBED", marketingOptInLevel: "SINGLE_OPT_IN" } }
    });

    return res.status(200).json({ success: true });

  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}
