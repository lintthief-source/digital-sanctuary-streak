import crypto from 'crypto';
import { formatInTimeZone } from 'date-fns-tz';

const SHOPIFY_SECRET = process.env.SHOPIFY_API_SECRET;
const ADMIN_ACCESS_TOKEN = process.env.SHOPIFY_ADMIN_API_TOKEN;
const SHOPIFY_DOMAIN = process.env.SHOPIFY_STORE_DOMAIN;
const DEV_SECRET = process.env.DEV_MODE_KEY; 

const CURRENCY_CODE = 'CAD'; 
const STREAK_REWARD = "0.90";
const COMMENT_REWARD = "0.05";
const STREAK_THRESHOLD = 30; 
const STORE_TZ = 'America/Edmonton'; 

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
  // 1. CAPTURE IDENTITY (Check both Header and Query Params for redundancy)
  const customerIdFromHeader = req.headers['x-shopify-customer-id'];
  const { signature, ...params } = req.query;
  
  // Use the header first, fallback to the query param provided by Shopify Proxy
  const effectiveCustomerId = customerIdFromHeader || params.logged_in_customer_id;

 // --- THE TRAFFIC CONTROLLER ---
  if (params.mode === 'get-profile-status') {
    if (!effectiveCustomerId) {
      return res.status(401).json({ error: "Unauthorized: No Customer Identity Found" });
    }

    const statusQuery = `
      query($id: ID!) {
        customer(id: $id) {
          emailMarketingConsent { marketingState }
          smsMarketingConsent { marketingState }
          storeCreditAccounts(first: 1) {
            edges {
              node {
                balance { amount }
              }
            }
          }
          streak: metafield(namespace: "custom", key: "devotional_current_streak") { value }
        }
      }
    `;

    try {
      const statusResult = await shopifyGraphql(statusQuery, { 
        id: `gid://shopify/Customer/${effectiveCustomerId}` 
      });

      const customer = statusResult.data?.customer;
      if (!customer) return res.status(404).json({ error: "Customer not found" });

      const creditNode = customer.storeCreditAccounts?.edges[0]?.node;

      return res.status(200).json({
        emailSubscribed: customer.emailMarketingConsent?.marketingState === "SUBSCRIBED",
        smsSubscribed: customer.smsMarketingConsent?.marketingState === "SUBSCRIBED",
        creditBalance: creditNode ? creditNode.balance.amount : "0.00",
        currentStreak: customer.streak?.value || "0"
      });
    } catch (e) {
      return res.status(500).json({ error: "Bridge Failed", details: e.message });
    }
  }
  // --- END TRAFFIC CONTROLLER ---

  // 2. EXISTING SECURITY GATE (Only runs for Streaks/Rewards)
  // This gate is why you were getting the 401 earlier.
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

  // --- 3. PROCEED WITH STREAK LOGIC ---
  const customerId = customerIdFromHeader || params.logged_in_customer_id || params.dev_customer_id;
  const currentArticleId = params.article_id; 
  const eventType = params.event_type; 

  if (!customerId) return res.status(200).json({ status: 'guest' });

  try {
    const customerGid = `gid://shopify/Customer/${customerId}`;

    const query = `
      query($id: ID!) {
        customer(id: $id) {
          id
          email
          firstName 
          tags
          storeCreditAccounts(first: 1) {
            edges {
              node {
                balance {
                  amount
                  currencyCode
                }
              }
            }
          }
          streak: metafield(namespace: "custom", key: "devotional_current_streak") { value }
          total: metafield(namespace: "custom", key: "devotional_total_days") { value }
          lastVisit: metafield(namespace: "custom", key: "devotional_last_visit") { value }
          history: metafield(namespace: "custom", key: "devotional_history") { value }
          commentHistory: metafield(namespace: "custom", key: "devotional_comment_history") { value }
        }
      }
    `;
    
    const result = await shopifyGraphql(query, { id: customerGid });
    const customerData = result.data?.customer;

    if (!customerData) return res.status(500).json({ error: "Customer fetch failed" });

    // --- LOGIC A: COMMENTS CHECK ---
    let commentRewardEarned = false;
    let commentHistoryLog = [];
    try {
        if (customerData.commentHistory?.value) {
            commentHistoryLog = JSON.parse(customerData.commentHistory.value);
        }
    } catch (e) { commentHistoryLog = []; }

    if (eventType === 'comment' && currentArticleId && !commentHistoryLog.includes(String(currentArticleId))) {
        const commentsQuery = `query($query: String!) { comments(first: 1, query: $query) { nodes { id } } }`;
        const searchString = `article_id:${currentArticleId} AND author_email:${customerData.email}`;
        const commentsResult = await shopifyGraphql(commentsQuery, { query: searchString });
        
        if (commentsResult.data?.comments?.nodes?.length > 0) {
            commentRewardEarned = true;
            commentHistoryLog.push(String(currentArticleId));
        }
    }

    // --- LOGIC B: STREAK CHECK ---
    let today = formatInTimeZone(new Date(), STORE_TZ, 'yyyy-MM-dd');
    if (isDevMode && params.dev_date) today = params.dev_date;

    let currentStreak = parseInt(customerData.streak?.value || 0);
    let totalDays = parseInt(customerData.total?.value || 0);
    const lastVisitDate = customerData.lastVisit?.value || null;
    let historyLog = [];
    try { if (customerData.history?.value) historyLog = JSON.parse(customerData.history.value); } catch (e) {}

    let streakUpdated = false;
    let streakRewardEarned = false;
    let newTags = [];

    if (lastVisitDate !== today) {
        streakUpdated = true;
        if (!historyLog.includes(today)) {
            historyLog.unshift(today);
            historyLog = historyLog.slice(0, 60);
        }

        const todayDateObj = new Date(today);
        const lastVisitObj = lastVisitDate ? new Date(lastVisitDate) : null;
        let isConsecutive = false;
        if (lastVisitObj) {
            const diffTime = Math.abs(todayDateObj - lastVisitObj);
            const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 
            if (diffDays === 1) isConsecutive = true;
        }

        if (isConsecutive) currentStreak += 1;
        else currentStreak = 1; 
        totalDays += 1;

        if ([7, 15, 30, 60, 100, 365].includes(currentStreak)) {
             const tagToAdd = `Streak: ${currentStreak} Days`;
             if (!customerData.tags.includes(tagToAdd)) newTags.push(tagToAdd);
        }

        if (currentStreak === STREAK_THRESHOLD) {
            currentStreak = 0; 
            streakRewardEarned = true;
        }
    }

    // --- LOGIC C: SAVE & PAY ---
    if (streakRewardEarned || commentRewardEarned) {
        const totalCredit = (streakRewardEarned ? parseFloat(STREAK_REWARD) : 0) + (commentRewardEarned ? parseFloat(COMMENT_REWARD) : 0);
        const creditInput = { creditAmount: { amount: totalCredit.toFixed(2), currencyCode: CURRENCY_CODE } };
        const creditMutation = `mutation Credit($id: ID!, $creditInput: StoreCreditAccountCreditInput!) { storeCreditAccountCredit(id: $id, creditInput: $creditInput) { userErrors { message } } }`;
        await shopifyGraphql(creditMutation, { id: customerGid, creditInput });
    }

    if (streakUpdated || commentRewardEarned) {
        const input = {
            id: customerGid,
            metafields: [
                { namespace: "custom", key: "devotional_current_streak", value: String(currentStreak), type: "number_integer" },
                { namespace: "custom", key: "devotional_total_days", value: String(totalDays), type: "number_integer" },
                { namespace: "custom", key: "devotional_last_visit", value: today, type: "date" },
                { namespace: "custom", key: "devotional_history", value: JSON.stringify(historyLog), type: "json" },
                { namespace: "custom", key: "devotional_comment_history", value: JSON.stringify(commentHistoryLog), type: "json" }
            ]
        };
        if (newTags.length > 0) input.tags = [...customerData.tags, ...newTags];
        await shopifyGraphql(`mutation Update($input: CustomerInput!) { customerUpdate(input: $input) { userErrors { field message } } }`, { input });
    }

    let creditBalance = "0.00";
    if (customerData.storeCreditAccounts?.edges?.length > 0) {
        creditBalance = customerData.storeCreditAccounts.edges[0].node.balance.amount;
    }

    return res.status(200).json({ 
        firstName: customerData.firstName || "Friend", 
        creditBalance, 
        currentStreak, 
        totalDays, 
        rewardJustEarned: streakRewardEarned,
        commentRewardEarned, 
        isDevMode 
    });

  } catch (error) {
    return res.status(500).json({ error: 'Server Error', details: error.message });
  }
}




