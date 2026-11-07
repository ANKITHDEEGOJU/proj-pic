const router = require('express').Router();
const pool = require('../db');
const { layout, esc } = require('../views');
const { getRuleStatus } = require('../services/pricingEngine');

/**
 * Gatekeeper Middleware: Restricts access to admin users matching ADMIN_EMAIL
 */
function requireAdmin(req, res, next) {
  const adminEmail = process.env.ADMIN_EMAIL || 'admin@learnx.com';

  if (!req.user || req.user.email !== adminEmail) {
    const referer = req.get('Referer');

    if (referer && !referer.includes('/admin')) {
      return res.redirect(referer);
    }
    return res.redirect('/courses');
  }
  next();
}

// GET /admin - Admin Overview Dashboard
router.get('/admin', requireAdmin, (req, res) => {
  const body = `
    <h2>Admin Panel</h2>
    <div class="card" style="margin-bottom: 1.5rem;">
      <h3>Welcome, ${esc(req.user.email)}!</h3>
      <p style="color: #5B5F6E; margin-top: 0.5rem;">System status: <strong>Active</strong></p>
    </div>

    <div class="card">
      <h3>Management Modules</h3>
      <p style="color: #5B5F6E; margin-bottom: 1rem;">Configure pricing rules, discounts, domain overrides, and coupons.</p>
      <a href="/admin/pricing-rules"><button>Manage Pricing & Coupons →</button></a>
    </div>
  `;

  res.send(layout('Admin Panel', body, req.user));
});

// GET /admin/pricing-rules - Full Pricing Rules & Coupons Dashboard
router.get('/admin/pricing-rules', requireAdmin, async (req, res) => {
  const { catalog } = req.app.locals.engine;

  try {
    const { rows: rules } = await pool.query(
      'SELECT * FROM pricing_rules ORDER BY created_at DESC'
    );

    const courses = catalog.list();
    const courseOptions = courses.map(c => `
      <label style="display: inline-block; margin-right: 1rem; margin-top: 0.25rem;">
        <input type="checkbox" name="applicable_courses" value="${esc(c.slug || c.id)}"> ${esc(c.name || c.title)}
      </label>
    `).join('');

    const rulesTableRows = rules.map(r => {
      const status = getRuleStatus(r);
      const statusBadge =
        status === 'ACTIVE' ? '<span class="ok">Active</span>' :
        status === 'SCHEDULED' ? '<span style="color:#d29922">Scheduled</span>' :
        status === 'EXPIRED' ? '<span class="err">Expired</span>' :
        '<span style="color:#888">Disabled</span>';

      const formattedValue = r.discount_type === 'PERCENTAGE'
        ? `${r.value}%`
        : `$${(r.value / 100).toFixed(2)}`;

      const targets = r.eligibility_targets ? r.eligibility_targets.join(', ') : '*';
      const courseTargets = r.applicable_course_ids ? r.applicable_course_ids.join(', ') : '*';
      const startDateStr = new Date(r.start_at).toLocaleString();
      const expiryStr = r.expires_at ? new Date(r.expires_at).toLocaleString() : 'Never';
      return `
        <tr>
          <td><strong>${esc(r.rule_name)}</strong><br><small style="color:#666">${esc(r.code || 'Auto Identity Rule')}</small></td>
          <td><code>${esc(r.application_mode)}</code></td>
          <td>${esc(r.discount_type)} (${formattedValue})</td>
          <td>${esc(r.applicable_product)}</td>
          <td><code>${esc(courseTargets)}</code></td>
          <td><code>${esc(targets)}</code></td>
          <td><small>Starts: ${startDateStr}<br>Expires: ${expiryStr}</small></td>
          <td>${statusBadge}</td>
          <td>
            <form hx-post="/admin/pricing-rules/${r.id}/toggle" hx-swap="none" hx-on::after-request="location.reload()">
              <button class="alt" type="submit" style="padding: 0.3rem 0.6rem; font-size: 0.8rem;">
                ${r.is_disabled ? 'Enable' : 'Disable'}
              </button>
            </form>
          </td>
        </tr>
      `;
    }).join('');

    const body = `
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
        <h2>Pricing & Coupon Rules</h2>
        <a href="/admin"><button class="alt">← Back to Admin Overview</button></a>
      </div>

      <div class="card" style="margin-bottom: 2rem;">
        <h3>Create New Pricing Rule / Coupon</h3>
        <form action="/admin/pricing-rules" method="POST" style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-top: 1rem;">
          <div>
            <label><strong>Rule Name / Description:</strong></label><br>
            <input type="text" name="rule_name" placeholder="e.g. Summer Sale 20%" required style="width: 100%; padding: 0.5rem; margin-top: 0.25rem;">
          </div>

          <div>
            <label><strong>Promo Code (Optional):</strong></label><br>
            <input type="text" name="code" placeholder="e.g. SUMMER20 (Leave blank for Auto Rules)" style="width: 100%; padding: 0.5rem; text-transform: uppercase; margin-top: 0.25rem;">
          </div>

          <div>
            <label><strong>Application Mode:</strong></label><br>
            <select name="application_mode" style="width: 100%; padding: 0.5rem; margin-top: 0.25rem;" required>
              <option value="CODE_REQUIRED">CODE_REQUIRED (Cart Coupon Entry)</option>
              <option value="AUTOMATIC_IDENTITY">AUTOMATIC_IDENTITY (Email/Domain Override)</option>
              <option value="GLOBAL_DEFAULT">GLOBAL_DEFAULT (Baseline Subscription)</option>
            </select>
          </div>

          <div>
            <label><strong>Discount Type:</strong></label><br>
            <select name="discount_type" style="width: 100%; padding: 0.5rem; margin-top: 0.25rem;" required>
              <option value="PERCENTAGE">PERCENTAGE</option>
              <option value="FIXED_DISCOUNT">FIXED_DISCOUNT (in Cents)</option>
              <option value="OVERRIDE_PRICE">OVERRIDE_PRICE (in Cents)</option>
            </select>
          </div>

          <div>
            <label><strong>Value (Percentage 1-100 OR Cents):</strong></label><br>
            <input type="number" name="value" placeholder="e.g. 20 for 20% or 1500 for $15.00" required style="width: 100%; padding: 0.5rem; margin-top: 0.25rem;">
          </div>

          <div>
            <label><strong>Applicable Product:</strong></label><br>
            <select name="applicable_product" style="width: 100%; padding: 0.5rem; margin-top: 0.25rem;" required>
              <option value="ALL">ALL Products</option>
              <option value="COURSES_ONLY">COURSES_ONLY</option>
              <option value="SUBSCRIPTION_ONLY">SUBSCRIPTION_ONLY</option>
            </select>
          </div>

          <div>
            <label><strong>Start Time (Default: Immediate):</strong></label><br>
            <input type="datetime-local" name="start_at" style="width: 100%; padding: 0.5rem; margin-top: 0.25rem;">
          </div>

          <div>
            <label><strong>Expiration Time (Optional):</strong></label><br>
            <input type="datetime-local" name="expires_at" style="width: 100%; padding: 0.5rem; margin-top: 0.25rem;">
          </div> 

          <div>
            <label><strong>Eligibility Targets (Comma-Separated):</strong></label><br>
            <input type="text" name="eligibility_targets" placeholder="* or @acme.com, user@domain.com" value="*" style="width: 100%; padding: 0.5rem; margin-top: 0.25rem;">
          </div>

          <div>
            <label><strong>Subscription Duration (Days):</strong></label><br>
            <input type="number" name="duration_days" value="30" style="width: 100%; padding: 0.5rem; margin-top: 0.25rem;">
          </div>

          <div style="grid-column: span 2;">
            <label><strong>Applicable Courses:</strong></label><br>
            <label style="display: inline-block; margin-right: 1rem; margin-top: 0.25rem;">
              <input type="checkbox" name="all_courses" value="*" checked> <strong>All Courses</strong>
            </label>
            <div style="margin-top: 0.5rem;">${courseOptions}</div>
          </div>

          <div style="grid-column: span 2; margin-top: 0.5rem;">
            <button type="submit" style="padding: 0.75rem 2rem;">Save Pricing Rule</button>
          </div>
        </form>
      </div>

      <h3>Existing Pricing Rules</h3>
      <table>
        <thead>
          <tr>
            <th>Name / Code</th>
            <th>Mode</th>
            <th>Discount</th>
            <th>Product</th>
            <th>Courses</th>
            <th>Targets</th>
            <th>Schedule</th>
            <th>Status</th>
            <th>Action</th>
          </tr>
        </thead>
        <tbody>
          ${rulesTableRows.length > 0 ? rulesTableRows : '<tr><td colspan="8" style="text-align:center; color:#666;">No pricing rules configured yet.</td></tr>'}
        </tbody>
      </table>
    `;

    res.send(layout('Admin - Pricing Rules', body, req.user));
  } catch (err) {
    console.error('Error rendering admin pricing rules page:', err);
    res.status(500).send('Internal Server Error');
  }
});

// POST /admin/pricing-rules - Create Pricing Rule or Coupon
router.post('/admin/pricing-rules', requireAdmin, async (req, res) => {
  const {
    rule_name,
    code,
    application_mode,
    discount_type,
    value,
    applicable_product,
    start_at,
    expires_at,
    eligibility_targets,
    duration_days,
    all_courses,
    applicable_courses
  } = req.body;

  try {
    const formattedCode = code && code.trim() ? code.trim().toUpperCase() : null;
    const startTimestamp = start_at && start_at.trim() ? new Date(start_at).toISOString() : new Date().toISOString();
    const expiryTimestamp = expires_at && expires_at.trim() ? new Date(expires_at).toISOString() : null;

    let targets = ['*'];
    if (eligibility_targets && eligibility_targets.trim() !== '*') {
      targets = eligibility_targets.split(',').map(t => t.trim()).filter(Boolean);
    }

    let courses = ['*'];
    if (!all_courses) {
      if (Array.isArray(applicable_courses)) {
        courses = applicable_courses;
      } else if (typeof applicable_courses === 'string') {
        courses = [applicable_courses];
      }
    }

    await pool.query(
      `INSERT INTO pricing_rules (
        rule_name,
        code,
        application_mode,
        discount_type,
        value,
        applicable_product,
        applicable_course_ids,
        eligibility_targets,
        start_at,
        expires_at,
        duration_days
      ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9,$10, $11)`,
      [
        rule_name.trim(),
        formattedCode,
        application_mode,
        discount_type,
        parseInt(value, 10),
        applicable_product,
        courses,
        targets,
        startTimestamp,
        expiryTimestamp,
        parseInt(duration_days || 30, 10)
      ]
    );

    res.redirect('/admin/pricing-rules');
  } catch (err) {
    console.error('Error creating pricing rule:', err);
    res.status(500).send('Failed to create pricing rule');
  }
});

// POST /admin/pricing-rules/:id/toggle - Enable or Disable Rule
router.post('/admin/pricing-rules/:id/toggle', requireAdmin, async (req, res) => {
  try {
    await pool.query(
      'UPDATE pricing_rules SET is_disabled = NOT is_disabled WHERE id = $1',
      [req.params.id]
    );
    res.status(200).end();
  } catch (err) {
    console.error('Error toggling pricing rule:', err);
    res.status(500).end();
  }
});

module.exports = router;

module.exports = router;