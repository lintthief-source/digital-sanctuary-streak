// /api/update-profile.js
import axios from 'axios';

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  const { customerId, firstName, lastName, nickname, dob, address, shop } = req.body;

  // Use your existing environment variable for the Admin API
  const adminApiToken = process.env.SHOPIFY_ADMIN_API_ACCESS_TOKEN;
  const shopDomain = shop || "ebenandink.myshopify.com"; 

  try {
    const payload = {
      customer: {
        id: customerId,
        first_name: firstName,
        last_name: lastName,
        metafields: [
          { namespace: "custom", key: "nickname", value: nickname, type: "single_line_text_field" },
          { namespace: "custom", key: "birthday", value: dob, type: "date" }
        ]
      }
    };

    // Only add address if the user filled it out
    if (address && address.address1) {
      payload.customer.addresses = [{
        ...address,
        first_name: firstName,
        last_name: lastName,
        default: true
      }];
    }

    await axios.put(
      `https://${shopDomain}/admin/api/2024-10/customers/${customerId}.json`,
      payload,
      { headers: { 'X-Shopify-Access-Token': adminApiToken } }
    );

    res.status(200).json({ success: true, message: "Sanctuary Identity Updated" });
  } catch (error) {
    console.error("Profile Update Error:", error.response?.data || error.message);
    res.status(500).json({ success: false, error: "Identity Sync Failed" });
  }
}
