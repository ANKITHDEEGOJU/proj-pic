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
async function resolveSubscriptionPrice(user) {
  const query = `
    SELECT * FROM pricing_rules
    WHERE applicable_product IN ('SUBSCRIPTION_ONLY', 'ALL')
      AND application_mode IN ('AUTOMATIC_IDENTITY', 'GLOBAL_DEFAULT')
      AND is_disabled = false
      AND start_at <= now()
      AND (expires_at IS NULL OR expires_at >= now())
    ORDER BY
      CASE
        WHEN application_mode = 'AUTOMATIC_IDENTITY' THEN 1
        WHEN application_mode = 'GLOBAL_DEFAULT' THEN 2
        ELSE 3
      END;
  `;

  const { rows } = await pool.query(query);
  const userEmail = user ? user.email : '';

  // 1. Specific Email Match
  const emailRule = rows.find(
    r => r.application_mode === 'AUTOMATIC_IDENTITY' &&
         r.eligibility_targets.some(t => !t.startsWith('@') && t.toLowerCase() === userEmail.toLowerCase())
  );
  if (emailRule) {
    return { priceCents: emailRule.value, durationDays: emailRule.duration_days, rule: emailRule };
  }

  // 2. Domain Match
  const userDomain = userEmail.includes('@') ? '@' + userEmail.split('@')[1].toLowerCase() : '';
  const domainRule = rows.find(
    r => r.application_mode === 'AUTOMATIC_IDENTITY' &&
         r.eligibility_targets.some(t => t.startsWith('@') && t.toLowerCase() === userDomain)
  );
  if (domainRule) {
    return { priceCents: domainRule.value, durationDays: domainRule.duration_days, rule: domainRule };
  }

  // 3. Global Default Fallback
  const globalRule = rows.find(r => r.application_mode === 'GLOBAL_DEFAULT');
  if (globalRule) {
    return { priceCents: globalRule.value, durationDays: globalRule.duration_days, rule: globalRule };
  }

  return { priceCents: 2999, durationDays: 30, rule: null };
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
    subtotalCents = cartItems.reduce((sum, item) => sum + Math.round(item.price * 100), 0);
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
validateCoupon
};