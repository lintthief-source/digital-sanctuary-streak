import crypto from 'crypto';
import { formatInTimeZone } from 'date-fns-tz';

const SHOPIFY_SECRET = process.env.SHOPIFY_API_SECRET;
const ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const DEV_SECRET = process.env.DEV_MODE_KEY; 

const CURRENCY_CODE = 'CAD'; 
const REWARD_AMOUNT = "0.90";
const STREAK_THRESHOLD = 30; 
const STORE_TZ = 'America/Edmonton'; 

async function shopifyGraphql(query, variables) {
  // DEBUG LOG: Verify we are using the right credentials
  console.log(`Connecting to: ${SHOPIFY_DOMAIN}`);
  
  const response = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/2024-07/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': ADMIN_ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  const result = await response.json();

  // *** CRITICAL DEBUGGING ***
  // If Shopify says "NO", log the reason!
  if (result.errors || !result.data) {
    console.error("❌ SHOPIFY API ERROR:", JSON.stringify(result, null, 2));
    if (!result.data) console.error("❌ DATA WAS MISSING entirely.");
  }

  return result;
}

export default async function handler(req, res) {
  const { signature, ...params } = req.query;

  let isDevMode = false;
  if (params.dev_key && params.dev_key === DEV_SECRET) {
    isDevMode = true;
  } else {
    const sortedParams = Object.keys(params).sort().map(key => `${key}=${params[key]}`).join('');
    const calculatedSignature = crypto.createHmac('sha256', SHOPIFY_SECRET).update(sortedParams).digest('hex');
    if (signature !== calculatedSignature) {
      return res.status(403).json({ error: 'Unauthorized Request' });
    }
  }

  const customerId = params.logged_in_customer_id || params.dev_customer_id;
  if (!customerId) return res.status(200).json({ status: 'guest' });

  try {
    const customerGid = `gid://shopify/Customer/${customerId}`;

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
    
    // FETCH DATA
    const result = await shopifyGraphql(query, { id: customerGid });
    
    // Safety Check: If data is missing, stop here instead of crashing
    if (!result.data || !result.data.customer) {
        return res.status(500).json({ error: "Shopify Data Fetch Failed", details: result.errors });
    }

    const customerData = result.data.customer;

    // --- LOGIC START ---
    let today = formatInTimeZone(new Date(), STORE_TZ, 'yyyy-MM-dd');
    if (isDevMode && params.dev_date) today = params.dev_date;

    let currentStreak = parseInt(customerData.streak?.value || 0);
    let totalDays = parseInt(customerData.total?.value || 0);
    const lastVisitDate = customerData.lastVisit?.value || null;

    let updated = false;
    let rewardTriggered = false;
    let newTags = [];

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
            currentStreak = 1; 
        }
        totalDays += 1;

        if ([7, 30, 60, 100, 365].includes(currentStreak)) {
             const tagToAdd = `Streak: ${currentStreak} Days`;
             const currentTags = customerData.tags || [];
             if (!currentTags.includes(tagToAdd)) newTags.push(tagToAdd);
        }

        if (currentStreak === STREAK_THRESHOLD) {
            currentStreak = 0; 
            rewardTriggered = true;
        }
    }

    if (updated || newTags.length > 0) {
        const input = {
            id: customerGid,
            metafields: [
                { namespace: "custom", key: "devotional_current_streak", value: String(currentStreak), type: "number_integer" },
                { namespace: "custom", key: "devotional_total_days", value: String(totalDays), type: "number_integer" },
                { namespace: "custom", key: "devotional_last_visit", value: today, type: "date" }
            ]
        };
        if (newTags.length > 0) input.tags = [...(customerData.tags || []), ...newTags];
        
        await shopifyGraphql(`mutation customerUpdate($input: CustomerInput!) { customerUpdate(input: $input) { userErrors { field message } } }`, { input });
    }

    if (rewardTriggered) {
        const accounts = customerData.storeCreditAccounts?.edges || [];
        let accountId = accounts.find(edge => edge.node.currency === CURRENCY_CODE)?.node.id;

        if (!accountId) {
             const createRes = await shopifyGraphql(`mutation storeCreditAccountCreate($customerId: ID!, $currency: CurrencyCode!) { storeCreditAccountCreate(customerId: $customerId, currency: $currency) { storeCreditAccount { id } } }`, { customerId: customerGid, currency: CURRENCY_CODE });
             accountId = createRes.data?.storeCreditAccountCreate?.storeCreditAccount?.id;
        }

        if (accountId) {
            await shopifyGraphql(`mutation storeCreditAccountCredit($id: ID!, $creditInput: StoreCreditAccountCreditInput!) { storeCreditAccountCredit(id: $id, creditInput: $creditInput) { userErrors { message } } }`, {
                id: accountId,
                creditInput: { amount: { amount: REWARD_AMOUNT, currencyCode: CURRENCY_CODE }, origin: "Devotional Streak Reward" }
            });
        }
    }

    return res.status(200).json({ currentStreak, totalDays, rewardJustEarned: rewardTriggered, isDevMode, dateRecorded: today });

  } catch (error) {
    console.error("CRITICAL SERVER ERROR:", error);
    return res.status(500).json({ error: 'Server Error', details: error.message });
  }
}
