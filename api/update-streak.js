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
  // Console log removed for cleaner production logs, feel free to add back if debugging
  const response = await fetch(`https://${SHOPIFY_DOMAIN}/admin/api/2024-07/graphql.json`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Access-Token': ADMIN_ACCESS_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });

  const result = await response.json();

  if (result.errors || !result.data) {
    console.error("❌ SHOPIFY API ERROR:", JSON.stringify(result, null, 2));
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

    // 1. FETCH STREAK DATA + HISTORY LOG
    const query = `
      query($id: ID!) {
        customer(id: $id) {
          tags
          streak: metafield(namespace: "custom", key: "devotional_current_streak") { value }
          total: metafield(namespace: "custom", key: "devotional_total_days") { value }
          lastVisit: metafield(namespace: "custom", key: "devotional_last_visit") { value }
          history: metafield(namespace: "custom", key: "devotional_history") { value }
        }
      }
    `;
    
    const result = await shopifyGraphql(query, { id: customerGid });
    
    if (!result.data || !result.data.customer) {
        return res.status(500).json({ error: "Shopify Data Fetch Failed", details: result.errors });
    }

    const customerData = result.data.customer;

    // 2. CALCULATE STREAK
    let today = formatInTimeZone(new Date(), STORE_TZ, 'yyyy-MM-dd');
    if (isDevMode && params.dev_date) today = params.dev_date;

    let currentStreak = parseInt(customerData.streak?.value || 0);
    let totalDays = parseInt(customerData.total?.value || 0);
    const lastVisitDate = customerData.lastVisit?.value || null;

    // --- NEW: AUDIT LOG LOGIC ---
    let historyLog = [];
    try {
        if (customerData.history?.value) {
            historyLog = JSON.parse(customerData.history.value);
        }
    } catch (e) {
        console.error("Error parsing history log", e);
        historyLog = [];
    }

    let updated = false;
    let rewardTriggered = false;
    let newTags = [];

    // Only run updates if they haven't visited today yet
    if (lastVisitDate !== today) {
        updated = true;
        
        // Add today to the history log (Audit Trail)
        // We only keep the last 60 days to save space
        if (!historyLog.includes(today)) {
            historyLog.unshift(today); // Add to the front
            historyLog = historyLog.slice(0, 60); // Keep max 60 entries
        }

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

    // 3. SAVE UPDATES
    if (updated || newTags.length > 0) {
        const input = {
            id: customerGid,
            metafields: [
                { namespace: "custom", key: "devotional_current_streak", value: String(currentStreak), type: "number_integer" },
                { namespace: "custom", key: "devotional_total_days", value: String(totalDays), type: "number_integer" },
                { namespace: "custom", key: "devotional_last_visit", value: today, type: "date" },
                { namespace: "custom", key: "devotional_history", value: JSON.stringify(historyLog), type: "json" }
            ]
        };
        if (newTags.length > 0) input.tags = [...(customerData.tags || []), ...newTags];
        
        await shopifyGraphql(`mutation customerUpdate($input: CustomerInput!) { customerUpdate(input: $input) { userErrors { field message } } }`, { input });
    }

    // 4. ISSUE STORE CREDIT
    if (rewardTriggered) {
        const creditMutation = `
            mutation storeCreditAccountCredit($id: ID!, $creditInput: StoreCreditAccountCreditInput!) {
                storeCreditAccountCredit(id: $id, creditInput: $creditInput) { 
                    userErrors { message } 
                }
            }
        `;
        
        await shopifyGraphql(creditMutation, {
            id: customerGid,
            creditInput: {
                creditAmount: { 
                    amount: REWARD_AMOUNT, 
                    currencyCode: CURRENCY_CODE 
                }
            }
        });
    }

    return res.status(200).json({ currentStreak, totalDays, rewardJustEarned: rewardTriggered, isDevMode, dateRecorded: today });

  } catch (error) {
    console.error("CRITICAL SERVER ERROR:", error);
    return res.status(500).json({ error: 'Server Error', details: error.message });
  }
}
