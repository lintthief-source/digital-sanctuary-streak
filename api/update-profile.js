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

// Helper to parse User Agent for the Ledger
function parseUA(ua) {
  let os = "Unknown OS";
  if (ua.includes("Windows")) os = "Windows";
  else if (ua.includes("Macintosh")) os = "macOS";
  else if (ua.includes("iPhone")) os = "iOS (iPhone)";
  else if (ua.includes("Android")) os = "Android";

  let browser = "Unknown Browser";
  if (ua.includes("Chrome")) browser = "Chrome";
  else if (ua.includes("Safari")) browser = "Safari";
  else if (ua.includes("Firefox")) browser = "Firefox";
  else if (ua.includes("Edg")) browser = "Edge";

  return { os, browser };
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
    const uaInfo = parseUA(req.headers['user-agent'] || "");
    const location = `${req.headers['x-vercel-ip-city'] || 'Unknown City'}, ${req.headers['x-vercel-ip-country'] || 'CA'}`;

    // 1. FETCH EXISTING HISTORY
    const historyQuery = `query($id: ID!) { customer(id: $id) { audit: metafield(namespace: "custom", key: "profile_update_history") { value } } }`;
    const historyRes = await shopifyGraphql(historyQuery, { id: customerGid });
    
    let currentHistory = [];
    try {
      if (historyRes.data?.customer?.audit?.value) currentHistory = JSON.parse(historyRes.data.customer.audit.value);
    } catch (e) { currentHistory = []; }

    // 2. CREATE FINGERPRINTED ENTRY
    const newEntry = {
      date: new Date().toISOString(),
      location: location,
      ip: ip,
      device: `${uaInfo.os} | ${uaInfo.browser}`,
      details: changeSummary,
      accepted: true
    };
    currentHistory.unshift(newEntry);
    const updatedHistoryJson = JSON.stringify(currentHistory.slice(0, 10));

    // 3. THE TRIPLE HANDSHAKE
    // Profile, Nickname, DOB, and THE NEW HISTORY
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
    await shopifyGraphql(`mutation cu($i: CustomerInput!) { customerUpdate(input: $i) { userErrors { message } } }`, { i: profileInput });

    // Email Consent
    await shopifyGraphql(`mutation e($i: CustomerEmailMarketingConsentUpdateInput!) { customerEmailMarketingConsentUpdate(input: $i) { userErrors { message } } }`, {
      i: { customerId: customerGid, emailMarketingConsent: { marketingState: consents.email ? "SUBSCRIBED" : "UNSUBSCRIBED", marketingOptInLevel: "SINGLE_OPT_IN" } }
    });

    // SMS Consent
    await shopifyGraphql(`mutation s($i: CustomerSmsMarketingConsentUpdateInput!) { customerSmsMarketingConsentUpdate(input: $i) { userErrors { message } } }`, {
      i: { customerId: customerGid, smsMarketingConsent: { marketingState: consents.sms ? "SUBSCRIBED" : "UNSUBSCRIBED", marketingOptInLevel: "SINGLE_OPT_IN" } }
    });

    return res.status(200).json({ success: true });

  } catch (error) {
    return res.status(500).json({ success: false, error: error.message });
  }
}
