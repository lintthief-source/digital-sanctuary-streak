export default async function handler(req, res) {
  // 1. CORS Headers (Infrastructure Level)
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*'); 
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Content-Type, Authorization');

  // 2. Handle the "Pre-flight" OPTIONS request
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { customerId, firstName, lastName, nickname, dob, address, shop } = req.body;
  const adminApiToken = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
  const shopDomain = shop || "ebenandink.myshopify.com";

  try {
    // 3. The Shopify Data Payload
    const payload = {
      customer: {
        id: customerId,
        first_name: firstName,
        last_name: lastName,
        metafields: [
          { namespace: "custom", key: "nickname", value: nickname, type: "single_line_text_field" },
          { namespace: "facts", key: "birth_date", value: dob, type: "date" }
        ]
      }
    };

    // Include Address if provided
    if (address && address.address1) {
      payload.customer.addresses = [{
        ...address,
        first_name: firstName,
        last_name: lastName,
        default: true
      }];
    }

    // 4. The Handshake (Using Native Fetch)
    const response = await fetch(
      `https://${shopDomain}/admin/api/2024-10/customers/${customerId}.json`,
      {
        method: 'PUT',
        headers: {
          'X-Shopify-Access-Token': adminApiToken,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      }
    );

    const result = await response.json();

    if (!response.ok) {
      console.error("Shopify API Error Details:", result);
      return res.status(response.status).json({ success: false, error: result.errors });
    }

    return res.status(200).json({ success: true, message: "Sanctuary Records Updated" });

  } catch (error) {
    console.error("System Error:", error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
}
