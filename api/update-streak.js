import crypto from 'crypto';
import { formatInTimeZone } from 'date-fns-tz';

// Environment Variables
const SHOPIFY_SECRET = process.env.SHOPIFY_API_SECRET; // From Partner Dashboard (Client Secret)
const ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN; // From Store Admin (shpat_ token)
const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN; // e.g., digital-sanctuary.myshopify.com
const DEV_SECRET = process.env.DEV_MODE_KEY; // Your secret password for testing

// Settings
const CURRENCY_CODE = 'CAD'; 
const REWARD_AMOUNT = "0.90";
const STREAK_THRESHOLD = 30; // Days to get reward
const STORE_TZ = 'America/Edmonton'; // Your Store Timezone

// Helper for Admin API
async function shopifyGraphql(query, variables) {
  const response = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/2024-07/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': ADMIN_ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  return response.json();
}

export default async function handler(req, res) {
  const { signature, ...params } = req.query;

  // 1. SECURITY & DEV MODE CHECK
  let isDevMode = false;
  
  // If a Dev Key is provided and matches env var, skip signature check
  if (params.dev_key && params.dev_key === DEV_SECRET) {
    isDevMode = true;
  } else {
    // Normal Production Security: Validate App Proxy HMAC
    // We sort params alphabetically and hash them with your Partner Secret
    const sortedParams = Object.keys(params).sort().map(key => `${key}=${params[key]}`).join('');
    const calculatedSignature = crypto.createHmac('sha256', SHOPIFY_SECRET).update(sortedParams).digest('hex');
    
    if (signature !== calculatedSignature) {
      return res.status(403).json({ error: 'Unauthorized Request' });
    }
  }

  // Get Customer ID (From Proxy or Dev Param)
  const customerId = params.logged_in_customer_id || params.dev_customer_id;
  
  if (!customerId) {
    return res.status(200).json({ status: 'guest', message: 'User not logged in' });
  }

  try {
    const customerGid = `gid://shopify/Customer/${customerId}`;

    // 2. FETCH CURRENT DATA
    const query = `
      query($id: ID!) {
        customer(id: $id) {
          tags
          streak: metafield(namespace: "custom", key: "devotional_current_streak") { value }
          total: metafield(namespace: "custom", key: "devotional_total_days") { value }
          lastVisit: metafield(namespace: "custom", key: "devotional_last_visit") { value }
          storeCreditAccounts(first: 5) {
            edges { node { id currency } }
          }
        }
      }
    `;
    const result = await shopifyGraphql(query, { id: customerGid });
    const customerData = result.data.customer;

    // 3. DETERMINE "TODAY"
    // If Dev Mode and dev_date is passed, use that. Otherwise use real time.
    let today = formatInTimeZone(new Date(), STORE_TZ, 'yyyy-MM-dd');
    if (isDevMode && params.dev_date) {
        today = params.dev_date; // Format: YYYY-MM-DD
    }

    let currentStreak = parseInt(customerData.streak?.value || 0);
    let totalDays = parseInt(customerData.total?.value || 0);
    const lastVisitDate = customerData.lastVisit?.value || null;

    let updated = false;
    let rewardTriggered = false;
    let newTags = [];

    // 4. CALCULATE LOGIC
    if (lastVisitDate !== today) {
        updated = true;
        const todayDateObj = new Date(today);
        const lastVisitObj = lastVisitDate ? new Date(lastVisitDate) : null;
        
        let isConsecutive = false;
        if (lastVisitObj) {
            const diffTime = Math.abs(todayDateObj - lastVisitObj);
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
            if (diffDays === 1) isConsecutive = true;
        }

        if (isConsecutive) {
            currentStreak += 1;
        } else {
            currentStreak = 1; // Reset
        }
        
        totalDays += 1;

        // --- TAGGING LOGIC ---
        // Add tags at milestones (e.g. 7 days, 30 days)
        const milestones = [7, 30, 60, 100, 365];
        if (milestones.includes(currentStreak)) {
             const tagToAdd = `Streak: ${currentStreak} Days`;
             const currentTags = customerData.tags || [];
             if (!currentTags.includes(tagToAdd)) {
                 newTags.push(tagToAdd);
             }
        }

        // --- REWARD LOGIC ---
        if (currentStreak === STREAK_THRESHOLD) {
            currentStreak = 0; // Reset streak to 0 after reward
            rewardTriggered = true;
        }
    }

    // 5. SAVE METAFIELDS & TAGS
    if (updated || newTags.length > 0) {
        const input = {
            id: customerGid,
            metafields: [
                { namespace: "custom", key: "devotional_current_streak", value: String(currentStreak), type: "number_integer" },
                { namespace: "custom", key: "devotional_total_days", value: String(totalDays), type: "number_integer" },
                { namespace: "custom", key: "devotional_last_visit", value: today, type: "date" }
            ]
        };

        // Merge tags if we have new ones
        if (newTags.length > 0) {
            const existingTags = customerData.tags || [];
            input.tags = [...existingTags, ...newTags];
        }

        const mutation = `
            mutation customerUpdate($input: CustomerInput!) {
                customerUpdate(input: $input) { userErrors { field message } }
            }
        `;
        await shopifyGraphql(mutation, { input });
    }

    // 6. ISSUE STORE CREDIT (If Reward Earned)
    if (rewardTriggered) {
        const accounts = customerData.storeCreditAccounts?.edges || [];
        // Find CAD account
        let accountId = accounts.find(edge => edge.node.currency === CURRENCY_CODE)?.node.id;

        // Create account if missing
        if (!accountId) {
             const createMutation = `
                mutation storeCreditAccountCreate($customerId: ID!, $currency: CurrencyCode!) {
                    storeCreditAccountCreate(customerId: $customerId, currency: $currency) {
                        storeCreditAccount { id }
                    }
                }
             `;
             const createRes = await shopifyGraphql(createMutation, { customerId: customerGid, currency: CURRENCY_CODE });
             accountId = createRes.data?.storeCreditAccountCreate?.storeCreditAccount?.id;
        }

        // Issue Credit
        if (accountId) {
            const creditMutation = `
                mutation storeCreditAccountCredit($id: ID!, $creditInput: StoreCreditAccountCreditInput!) {
                    storeCreditAccountCredit(id: $id, creditInput: $creditInput) { userErrors { message } }
                }
            `;
            await shopifyGraphql(creditMutation, {
                id: accountId,
                creditInput: {
                    amount: { amount: REWARD_AMOUNT, currencyCode: CURRENCY_CODE },
                    origin: "Devotional Streak Reward" // Visible to customer
                }
            });
        }
    }

    // 7. RETURN JSON TO FRONTEND
    return res.status(200).json({
        currentStreak,
        totalDays,
        rewardJustEarned: rewardTriggered,
        isDevMode,
        dateRecorded: today
    });

  } catch (error) {
    console.error(error);
    return res.status(500).json({ error: 'Server Error' });
  }
}