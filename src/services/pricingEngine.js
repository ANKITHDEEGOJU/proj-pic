const pool = require('../db');

/**
 * Computes lifecycle status of a rule using current system time
 */
function getRuleStatus(rule, now = new Date()) {
  if (rule.is_disabled) return 'DISABLED';
  const currentTime = now.getTime();
  const startTime = new Date(rule.start_at).getTime();

  if (currentTime < startTime) return 'SCHEDULED';
  if (rule.expires_at && currentTime > new Date(rule.expires_at).getTime()) {
    return 'EXPIRED';
  }
  return 'ACTIVE';
}

/**
 * Checks if a user's email matches the eligibility targets array
 */
function checkUserEligibility(userEmail, targets) {
  if (!targets || targets.includes('*') || targets.length === 0) return true;
  if (!userEmail) return false;

  const normalizedEmail = userEmail.toLowerCase().trim();
  const domain = '@' + normalizedEmail.split('@')[1];

  return targets.some(target => {
    const t = target.toLowerCase().trim();
    if (t.startsWith('@')) {
      return domain === t;
    }
    return normalizedEmail === t;
  });
}

/**
 * Resolves active subscription price for a user using precedence hierarchy:
 * Tier 1: Specific Email Override
 * Tier 2: Specific Email Domain Override
 * Tier 3: Global Baseline Default
 */
/**
 * Splits an order's final payable amount across its lines in proportion to each line's
 * price, so every line knows what was really paid for it (after coupons).
 * Uses largest-remainder rounding so the parts always add up to exactly `finalCents`.
 * @param {number[]} lineCents  undiscounted price of each line (unit price * quantity)
 * @param {number} finalCents   what the customer pays for the whole order
 * @returns {number[]} paid cents per line, same order as `lineCents`
 */
function allocatePaidCents(lineCents, finalCents) {
  const total = lineCents.reduce((a, b) => a + b, 0);
  if (lineCents.length === 0) return [];
  if (total <= 0) return lineCents.map((_, i) => (i === 0 ? finalCents : 0));
  const exact = lineCents.map((c) => (c * finalCents) / total);
  const parts = exact.map(Math.floor);
  let left = finalCents - parts.reduce((a, b) => a + b, 0);
  exact
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac)
    .forEach(({ i }) => { if (left > 0) { parts[i] += 1; left -= 1; } });
  return parts;
}

async function resolveSubscriptionPrice(user, productId = 'sub_monthly', catalog = null) {
  // 1. Get base product defaults from catalog (fallback if DB has no rules)
  const catalogItem = catalog ? catalog.get(productId) : null;
  const basePriceCents = catalogItem?.priceCents ?? (catalogItem?.price ? Math.round(catalogItem.price * 100) : 2999);
  const baseDurationDays = catalogItem?.durationDays ?? 30;
  const productName = catalogItem?.name ?? 'LearnX All-Access Pass';
  const currency = catalogItem?.currency ?? 'USD';

  const userEmail = (user?.email || '').trim().toLowerCase();

  try {
    const query = `
      SELECT * FROM pricing_rules
      WHERE applicable_product IN ($1, 'SUBSCRIPTION_ONLY', 'ALL')
        AND application_mode IN ('AUTOMATIC_IDENTITY', 'GLOBAL_DEFAULT')
        AND is_disabled = false
        AND start_at <= now()
        AND (expires_at IS NULL OR expires_at >= now())
      ORDER BY
        CASE
          WHEN application_mode = 'AUTOMATIC_IDENTITY' THEN 1
          WHEN application_mode = 'GLOBAL_DEFAULT' THEN 2
          ELSE 3
        END,
        created_at DESC;
    `;

    const { rows } = await pool.query(query, [productId]);

    const getTargets = (r) => Array.isArray(r.eligibility_targets) ? r.eligibility_targets : [];

    if (userEmail) {
      // Step A: Specific Email Match
      const emailRule = rows.find(r =>
        r.application_mode === 'AUTOMATIC_IDENTITY' &&
        getTargets(r).some(t => typeof t === 'string' && !t.startsWith('@') && t.toLowerCase() === userEmail)
      );
      if (emailRule) {
        return {
          productId: catalogItem?.id || productId,
          name: productName,
          currency,
          priceCents: emailRule.value ?? basePriceCents,
          durationDays: emailRule.duration_days ?? baseDurationDays,
          rule: emailRule
        };
      }

      // Step B: Domain Match (e.g., '@company.com')
      const userDomain = userEmail.includes('@') ? '@' + userEmail.split('@')[1] : '';
      if (userDomain) {
        const domainRule = rows.find(r =>
          r.application_mode === 'AUTOMATIC_IDENTITY' &&
          getTargets(r).some(t => typeof t === 'string' && t.startsWith('@') && t.toLowerCase() === userDomain)
        );
        if (domainRule) {
          return {
            productId: catalogItem?.id || productId,
            name: productName,
            currency,
            priceCents: domainRule.value ?? basePriceCents,
            durationDays: domainRule.duration_days ?? baseDurationDays,
            rule: domainRule
          };
        }
      }
    }

    // Step C: Global Default Fallback Rule
    const globalRule = rows.find(r => r.application_mode === 'GLOBAL_DEFAULT');
    if (globalRule) {
      return {
        productId: catalogItem?.id || productId,
        name: productName,
        currency,
        priceCents: globalRule.value ?? basePriceCents,
        durationDays: globalRule.duration_days ?? baseDurationDays,
        rule: globalRule
      };
    }
  } catch (err) {
    console.error('[resolveSubscriptionPrice] DB Query Error:', err.message);
  }

  // 2. Standard Catalog Fallback
  return {
    productId: catalogItem?.id || productId,
    name: productName,
    currency,
    priceCents: basePriceCents,
    durationDays: baseDurationDays,
    rule: null
  };
}

/**
 * Validates promo codes against user and current cart items (supporting course scoping)
 */
async function validateCoupon(code, user, isSubscriptionCart, cartItems = []) {
  if (!code || !code.trim()) {
    return { valid: false, error: 'Please enter a coupon code' };
  }

  const query = `
    SELECT * FROM pricing_rules
    WHERE UPPER(code) = UPPER($1) AND application_mode = 'CODE_REQUIRED'
  `;
  const { rows } = await pool.query(query, [code.trim()]);

  if (rows.length === 0) {
    return { valid: false, error: 'Invalid coupon code' };
  }

  const rule = rows[0];
  const status = getRuleStatus(rule);

  // Status Lifecycle Checks
  if (status === 'DISABLED') return { valid: false, error: 'This coupon has been disabled' };
  if (status === 'SCHEDULED') return { valid: false, error: 'This coupon is not active yet' };
  if (status === 'EXPIRED') return { valid: false, error: 'This coupon has expired' };

  // Product Type Applicability
  if (isSubscriptionCart && rule.applicable_product === 'COURSES_ONLY') {
    return { valid: false, error: 'This coupon is only valid for one-time course purchases' };
  }
  if (!isSubscriptionCart && rule.applicable_product === 'SUBSCRIPTION_ONLY') {
    return { valid: false, error: 'This coupon is only valid for subscription passes' };
  }

  // User Identity Eligibility Check
  const isEligible = checkUserEligibility(user ? user.email : '', rule.eligibility_targets);
  if (!isEligible) {
    return { valid: false, error: 'Your account is not eligible for this promo code' };
  }

  // Determine baseline subscription price via identity resolution or calculate courses subtotal
  let subtotalCents = 0;
  if (isSubscriptionCart) {
    const subPrice = await resolveSubscriptionPrice(user);
    subtotalCents = subPrice.priceCents;
  } else {
    console.log("Subtotal - ",subtotalCents );
    subtotalCents = cartItems.reduce((sum, item) => sum + item.unit_price_cents,0);
    console.log("Subtotal - ",subtotalCents );
  }
  
  // Course Scoping & Eligible Subtotal Filter
  let eligibleSubtotalCents = subtotalCents;

  if (!isSubscriptionCart) {
    const courseTargets = rule.applicable_course_ids || ['*'];
    const appliesToAllCourses = courseTargets.includes('*');

    if (!appliesToAllCourses) {
      const matchingItems = cartItems.filter(item => {
        const slug = item.slug || item.id;
        return courseTargets.includes(slug);
      });

      if (matchingItems.length === 0) {
        return { valid: false, error: 'This coupon is not applicable to any course in your cart' };
      }

      eligibleSubtotalCents = matchingItems.reduce(
        (sum, item) => sum + Math.round(item.price * 100),
        0
      );
    }
  }

  // Calculate Discount Amount
  let discountCents = 0;
  if (rule.discount_type === 'PERCENTAGE') {
    discountCents = Math.round((eligibleSubtotalCents * rule.value) / 100);
  } else if (rule.discount_type === 'FIXED_DISCOUNT') {
    discountCents = rule.value;
  } else if (rule.discount_type === 'OVERRIDE_PRICE') {
    discountCents = Math.max(0, eligibleSubtotalCents - rule.value);
  }

  // Floor constraint: Discount cannot exceed eligible subtotal
discountCents = Math.min(discountCents, eligibleSubtotalCents);
const finalPayableCents = subtotalCents - discountCents;
//console.log(finalPayableCents,subtotalCents,discountCents)
return {
    valid: true,
    rule,
    discountCents,
    finalPayableCents,
    subtotalCents,
    eligibleSubtotalCents,
    message: 'Coupon applied successfully!'
};
}

module.exports = {
getRuleStatus,
checkUserEligibility,
resolveSubscriptionPrice,
allocatePaidCents,
validateCoupon
};