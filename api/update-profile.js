import axios from 'axios';

export default async function handler(req, res) {
  // 1. SET CORS HEADERS (The Security Pass)
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', 'https://ebenandink.com'); 
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  // 2. HANDLE PRE-FLIGHT (Fixes the CORS 'Failed to Fetch' error)
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return;
  }

  // 3. ONLY ALLOW POST REQUESTS
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method not allowed' });
  }

  // 4. EXTRACT DATA FROM THE BUCKET BRIGADE
  const { customerId, firstName, lastName, nickname, dob, address, shop } = req.body;

  // Environment Variables from your Vercel Project
  const adminApiToken = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
  const shopDomain = shop || "ebenandink.myshopify.com";

  try {
    // 5. BUILD THE SHOPIFY PAYLOAD
    const payload = {
      customer: {
        id: customerId,
        first_name: firstName,
        last_name: lastName,
        metafields: [
          {
            namespace: "custom",
            key: "nickname",
            value: nickname,
            type: "single_line_text_field"
          },
          {
            namespace: "facts", // Matches your facts namespace
            key: "birth_date",  // Matches your birth_date key
            value: dob,         // The transient variable carrying the date
            type: "date"
          }
        ]
      }
    };

    // 6. ADD ADDRESS IF PROVIDED
    if (address && address.address1) {
      payload.customer.addresses = [{
        address1: address.address1,
        city: address.city,
        province: address.province, // Expects State/Province code (e.g. 'AB' or 'ON')
        zip: address.zip,
        country: "Canada", 
        first_name: firstName,
        last_name: lastName,
        default: true
      }];
    }

    // 7. PERFORM THE HANDSHAKE WITH SHOPIFY
    const shopifyResponse = await axios.put(
      `https://${shopDomain}/admin/api/2024-10/customers/${customerId}.json`,
      payload,
      {
        headers: {
          'X-Shopify-Access-Token': adminApiToken,
          'Content-Type': 'application/json'
        }
      }
    );

    // 8. RETURN SUCCESS
    return res.status(200).json({ 
      success: true, 
      message: "Sanctuary Identity Synced Successfully",
      customer: shopifyResponse.data.customer 
    });

  } catch (error) {
    // 9. ERROR LOGGING
    console.error("Shopify Sync Error:", error.response?.data || error.message);
    
    return res.status(500).json({ 
      success: false, 
      error: "Sanctuary Sync Failed", 
      details: error.response?.data || error.message 
    });
  }
}
