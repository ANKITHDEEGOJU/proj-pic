'use strict';

const router = require('express').Router();
const { randomUUID } = require('node:crypto');
const pool = require('../db');
const { layout, esc, moreRow, searchBox, qs, PAGE_SIZE } = require('../views');
const { getRuleStatus } = require('../services/pricingEngine');

// Helper to look up catalog item by id or slug safely
function resolveCatalogProduct(catalog, key) {
  if (!catalog || !key) return null;
  if (typeof catalog.get === 'function') {
    const item = catalog.get(key);
    if (item) return item;
  }
  if (typeof catalog.list === 'function') {
    for (const item of catalog.list()) {
      if (item.id === key || item.slug === key) return item;
    }
  }
  return null;
}

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
router.get('/admin', requireAdmin, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT COUNT(*) FROM users');
    const userCount = rows[0].count;

    const body = `
      <h2>Admin Panel</h2>
      <div class="card" style="margin-bottom: 1.5rem;">
        <h3>Welcome, ${esc(req.user.email)}!</h3>
        <p style="color: #5B5F6E; margin-top: 0.5rem;">System status: <strong>Active</strong> | Registered Users: <strong>${userCount}</strong></p>
      </div>

      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 1.5rem;">
        <div class="card">
          <h3>User Entitlements & Access</h3>
          <p style="color: #5B5F6E; margin-bottom: 1rem;">View all registered users (${userCount}), inspect active access, grant new courses/subscriptions, or revoke entitlements.</p>
          <a href="/admin/users"><button>Manage Users & Access (${userCount}) →</button></a>
        </div>

        <div class="card">
          <h3>Organizations & Seats</h3>
          <p style="color: #5B5F6E; margin-bottom: 1rem;">Every organization, its seat packs and who holds each seat.</p>
          <a href="/admin/orgs"><button class="alt">View Organizations →</button></a>
        </div>

        <div class="card">
          <h3>Reconciliation & Webhooks</h3>
          <p style="color: #5B5F6E; margin-bottom: 1rem;">Provider vs ledger discrepancies, automatic repairs, and failed / dead webhook deliveries.</p>
          <a href="/admin/reconciliation"><button class="alt">Open Reconciliation →</button></a>
        </div>

        <div class="card">
          <h3>Assistant Log</h3>
          <p style="color: #5B5F6E; margin-bottom: 1rem;">Every LEARNX Assistant chat turn: messages, replies, tools used, errors, limits and token use.</p>
          <a href="/admin/assistant"><button class="alt">Open Assistant Log →</button></a>
        </div>

        <div class="card">
          <h3>Pricing Rules & Coupons</h3>
          <p style="color: #5B5F6E; margin-bottom: 1rem;">Configure pricing rules, discounts, domain overrides, and promo coupons.</p>
          <a href="/admin/pricing-rules"><button class="alt">Manage Pricing & Coupons →</button></a>
        </div>
      </div>
    `;

    res.send(layout('Admin Panel', body, req.user));
  } catch (err) {
    console.error('Error rendering admin panel:', err);
    res.status(500).send('Internal Server Error');
  }
});

// ---- admin user list (paged + searchable) ---------------------------------------------------

// One page of users matching q (email or id), newest first, as table rows + "Show more".
async function adminUserRows(engine, { q = '', offset = 0 } = {}) {
  const { catalog, projection } = engine;
  const needle = String(q).trim().slice(0, 100);
  const like = `%${needle.replace(/[\\%_]/g, '\\$&')}%`;
  const { rows: users } = await pool.query(
    `SELECT id, email, created_at, count(*) OVER () AS total FROM users
      WHERE $1 = '' OR email ILIKE $2 OR id::text ILIKE $2
      ORDER BY created_at DESC LIMIT $3 OFFSET $4`,
    [needle, like, PAGE_SIZE, offset]
  );
  const total = users.length ? Number(users[0].total)
    : Number((await pool.query(`SELECT count(*) FROM users WHERE $1 = '' OR email ILIKE $2 OR id::text ILIKE $2`, [needle, like])).rows[0].count);
  const projectionSnapshot = projection.snapshot();
  const allProducts = catalog.list ? catalog.list() : [];
  const productOptions = allProducts.map(p => `
      <option value="${esc(p.slug || p.id)}">${esc(p.name || p.title || p.id)} (${p.type || 'COURSE'})</option>
    `).join('');

  const html = users.map(u => {
      const userEntitlements = Object.values(projectionSnapshot).filter(
        ent => String(ent.userId) === String(u.id) && ent.status === 'ACTIVE'
      );

      const entitlementBadges = userEntitlements.length > 0
        ? userEntitlements.map(ent => {
            const p = resolveCatalogProduct(catalog, ent.productId);
            const title = p ? (p.name || p.title) : ent.productId;
            const isSub = ent.type === 'SUBSCRIPTION';

            return `
              <div style="display: inline-flex; align-items: center; gap: 0.5rem; background: #e8f5e9; border: 1px solid #a5d6a7; padding: 0.25rem 0.6rem; border-radius: 20px; font-size: 0.8rem; margin: 0.2rem 0.3rem 0.2rem 0;">
                <span style="color: #1b5e20; font-weight: 600;">✓ ${esc(title)} ${isSub ? '(Sub)' : ''}</span>
                <form action="/admin/users/revoke" method="POST" style="display: inline; margin: 0;">
                  <input type="hidden" name="userId" value="${esc(u.id)}">
                  <input type="hidden" name="productId" value="${esc(ent.productId)}">
                  <button type="submit" title="Revoke Access" style="background: #ffebee; color: #c62828; border: 1px solid #ef9a9a; padding: 0.15rem 0.5rem; border-radius: 12px; font-size: 0.75rem; font-weight: 600; cursor: pointer; transition: background 0.2s;">
                    Revoke
                  </button>
                </form>
              </div>
            `;
          }).join('')
        : '<span style="color: #888; font-size: 0.85rem; italic">No Active Access</span>';

      return `
        <tr>
          <td style="min-width: 11rem;"><strong>${esc(u.email)}</strong><br><small style="color:#666">ID: ${esc(u.id)}</small></td>
          <td><small>${new Date(u.created_at).toLocaleDateString()}</small></td>
          <td style="vertical-align: middle;">${entitlementBadges}</td>
          <td>
            <form action="/admin/users/grant" method="POST" onsubmit="this.querySelector('button[type=submit]').disabled = true" style="display: flex; flex-wrap: wrap; gap: 0.5rem; align-items: center;">
              <input type="hidden" name="userId" value="${esc(u.id)}">
              <input type="hidden" name="grantKey" value="${randomUUID()}">
              <select name="productId" style="padding: 0.38rem; border-radius: 4px; border: 1px solid #ccc; font-size: 0.85rem;" required>
                <option value="" disabled selected>Select course/sub...</option>
                ${productOptions}
              </select>
              <select name="source" style="padding: 0.38rem; border-radius: 4px; border: 1px solid #ccc; font-size: 0.85rem;">
                <option value="ADMIN">Admin</option>
                <option value="SCHOLARSHIP">Scholarship</option>
              </select>
              <input name="reason" placeholder="Reason (optional)" style="padding: 0.38rem; border-radius: 4px; border: 1px solid #ccc; font-size: 0.85rem; width: 9rem;">
              <button type="submit" style="padding: 0.38rem 0.8rem; font-size: 0.85rem;">Grant Access</button>
            </form>
          </td>
        </tr>
      `;
    }).join('');
  const shown = offset + users.length;
  return html + moreRow({ colspan: 4, nextUrl: `/admin/users/rows?${qs({ q: needle, offset: shown })}`, shown, total, q: needle });
}

// GET /admin/users - User Entitlements Management
router.get('/admin/users', requireAdmin, async (req, res) => {
  try {
    const userCount = Number((await pool.query('SELECT count(*) FROM users')).rows[0].count);
    const body = `
      <div style="display: flex; flex-wrap: wrap; gap: 0.5rem; justify-content: space-between; align-items: center; margin-bottom: 1rem;">
        <h2>User Management (${userCount} Users)</h2>
        <a href="/admin"><button class="alt">← Back to Admin Overview</button></a>
      </div>

      <div class="card" style="margin-bottom: 1.5rem;">
        <p style="color: #5B5F6E; margin: 0;">
          Granting or revoking access appends <code>MANUAL_GRANT</code> or <code>MANUAL_REVOKE</code> events to the <code>commerce_ledger</code>.
          The entitlement projection engine updates automatically in real-time.
        </p>
      </div>

      ${searchBox({ url: '/admin/users/rows', target: '#user-rows', placeholder: 'Search by email or user id…' })}
      <div class="table-wrap"><table>
        <thead>
          <tr>
            <th>User</th>
            <th>Registered</th>
            <th>Active Entitlements</th>
            <th>Grant Access</th>
          </tr>
        </thead>
        <tbody id="user-rows">
          ${await adminUserRows(req.app.locals.engine)}
        </tbody>
      </table></div>
    `;

    res.send(layout('Admin - User Management', body, req.user));
  } catch (err) {
    console.error('Error rendering admin users page:', err);
    res.status(500).send('Internal Server Error');
  }
});

// GET /admin/users/rows?q=&offset= - htmx: next page / search results of the user table
router.get('/admin/users/rows', requireAdmin, async (req, res) => {
  try {
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    res.send(await adminUserRows(req.app.locals.engine, { q: req.query.q || '', offset }));
  } catch (err) {
    console.error('Error loading admin user rows:', err);
    res.status(500).send('<tr><td colspan="4" class="err">Could not load users.</td></tr>');
  }
});

// POST /admin/users/grant - Manually Grant Course or Subscription Access
router.post('/admin/users/grant', requireAdmin, async (req, res) => {
  const { userId, productId } = req.body;
  const { catalog, ledger } = req.app.locals.engine;

  if (!userId || !productId) {
    return res.status(400).send('Missing userId or productId');
  }

  try {
    const product = resolveCatalogProduct(catalog, productId);
    if (!product) {
      return res.status(404).send('Product not found in catalog');
    }

    const targetProductId = product.slug || product.id;
    const itemType = product.type || 'COURSE';
    const durationDays = product.durationDays || (itemType === 'SUBSCRIPTION' ? 30 : null);
    const scope = product.scope || (itemType === 'SUBSCRIPTION' ? 'ALL_ACCESS' : null);

    // M1: a free grant is its own event type, not a $0 purchase.
    const source = req.body.source === 'SCHOLARSHIP' ? 'SCHOLARSHIP' : 'ADMIN';
    // Idempotent: the form's one-time grantKey is the event id, so the same form submitted twice
    // (double click, refresh, retry) records one grant; the ledger ignores the repeat
    // (DUPLICATE_EVENT / EVENT_ID_CONFLICT, nothing appended).
    const grantKey = /^[0-9a-f-]{36}$/i.test(String(req.body.grantKey || '')) ? String(req.body.grantKey) : randomUUID();
    const out = await ledger.appendEvent(
      {
        eventId: `admin_grant_${grantKey}`,
        eventType: 'MANUAL_GRANT',
        userId: String(userId),
        productId: targetProductId,
        quantity: 1,
        amount: 0,
        currency: product.currency || 'USD',
        occurredAt: new Date().toISOString(),
        source,
        actor: req.user.email,
        reason: (req.body.reason || '').trim() || null,
        entitlement: {
          kind: itemType === 'SUBSCRIPTION' ? 'SUBSCRIPTION' : 'COURSE',
          scope,
          durationDays,
          expiresAt: null,
        },
      },
      { method: 'ADMIN_MANUAL_GRANT', grantedBy: req.user.email }
    );
    if (out && out.appended === false) console.log(`[admin] grant ${grantKey} submitted again: ignored (${out.reason})`);

    res.redirect('/admin/users');
  } catch (err) {
    console.error('Error granting user access:', err);
    res.status(500).send(`Failed to grant access: ${err.message}`);
  }
});

// POST /admin/users/revoke - Manually Revoke Access
router.post('/admin/users/revoke', requireAdmin, async (req, res) => {
  const { userId, productId } = req.body;
  const { catalog, projection, ledger } = req.app.locals.engine;

  if (!userId || !productId) {
    return res.status(400).send('Missing userId or productId');
  }

  try {
    const product = resolveCatalogProduct(catalog, productId);
    const targetProductId = product ? (product.slug || product.id) : productId;

    // Retrieve active entitlement from projection engine
    let ent = projection.get(userId, targetProductId);
    if (!ent && (product?.type === 'SUBSCRIPTION' || targetProductId.includes('sub'))) {
      ent = projection.getSubscription(userId, product?.scope || 'ALL_ACCESS');
    }

    if (!ent || ent.status !== 'ACTIVE') {
      return res.redirect('/admin/users');
    }

    // M1: an admin taking access away is MANUAL_REVOKE (no money moves), not a refund.
    // A subscription is a list of periods; revoke every one so all access ends.
    const targets = ent.type === 'SUBSCRIPTION' && ent.periods?.length
      ? ent.periods.map((per) => ({ eventId: per.eventId, productId: per.productId }))
      : [{ eventId: ent.sourceEventId, productId: targetProductId }];
    for (const tgt of targets) {
      await ledger.appendEvent(
        {
          eventId: `admin_revoke_${randomUUID()}`,
          eventType: 'MANUAL_REVOKE',
          userId: String(userId),
          productId: tgt.productId,
          quantity: 1,
          amount: 0,
          currency: product?.currency || 'USD',
          occurredAt: new Date().toISOString(),
          referenceeventId: tgt.eventId,
          source: 'ADMIN',
          actor: req.user.email,
          reason: (req.body.reason || '').trim() || null,
        },
        { method: 'ADMIN_MANUAL_REVOKE', revokedBy: req.user.email }
      );
    }

    res.redirect('/admin/users');
  } catch (err) {
    console.error('Error revoking user access:', err);
    res.status(500).send(`Failed to revoke access: ${err.message}`);
  }
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
      <div class="table-wrap"><table>
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
      </table></div>
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

// ---------------------------------------------------------------------------
// M6 Reconciliation + M2 webhook inbox health
// ---------------------------------------------------------------------------
const fmtTime = (t) => (t ? new Date(t).toLocaleString() : '-');
const smallBtn = 'style="padding: 0.3rem 0.6rem; font-size: 0.8rem;"';

// Reconciliation page tables: PAGE_SIZE rows each, "Show more" fetches the next page.
const reconDetails = (d) => `<code style="font-size:0.75rem;white-space:pre-wrap">${esc(JSON.stringify(d))}</code>`;
const RECON_TABLES = {
  open: {
    cols: 5,
    where: "status='OPEN'", from: 'recon_issues', order: 'last_seen_at DESC, id DESC',
    row: (i) => `
      <tr><td><strong>${esc(i.kind)}</strong><br><small>${esc(i.provider || '')}</small></td>
        <td><code>${esc(i.ref)}</code>${i.order_id ? `<br><small>order ${esc(i.order_id)}</small>` : ''}</td>
        <td>${reconDetails(i.details)}</td>
        <td><small>first ${fmtTime(i.first_seen_at)}<br>last ${fmtTime(i.last_seen_at)}</small></td>
        <td><form hx-post="/admin/reconciliation/issues/${i.id}/resolve" hx-swap="none" hx-on::after-request="location.reload()">
          <button class="alt" type="submit" ${smallBtn}>Resolve</button></form></td></tr>`,
  },
  fixed: {
    cols: 4,
    where: "status='AUTO_FIXED'", from: 'recon_issues', order: 'id DESC',
    row: (i) => `
      <tr><td><strong>${esc(i.kind)}</strong></td><td><code>${esc(i.ref)}</code></td>
        <td>${reconDetails(i.details)}</td><td><small>${fmtTime(i.first_seen_at)} (run #${i.first_run_id})</small></td></tr>`,
  },
  inbox: {
    cols: 7,
    where: "status IN ('FAILED','DEAD','PROCESSING')", from: 'webhook_inbox', order: 'received_at DESC, id DESC',
    row: (w) => `
      <tr><td>#${w.id}</td><td>${esc(w.provider)}<br><code>${esc(w.provider_event_id)}</code></td>
        <td>${esc(w.status)}</td><td>${w.attempts}</td><td><small>${fmtTime(w.next_retry_at)}</small></td>
        <td><small>${esc(w.failure_reason || '')}</small></td>
        <td>${['DEAD', 'FAILED'].includes(w.status) ? `<form hx-post="/admin/webhooks/${w.id}/retry" hx-swap="none" hx-on::after-request="location.reload()">
          <button class="alt" type="submit" ${smallBtn}>Retry now</button></form>` : ''}</td></tr>`,
  },
  runs: {
    cols: 5,
    where: 'TRUE', from: 'recon_runs', order: 'id DESC',
    row: (r) => `
      <tr><td>#${r.id}</td><td>${esc(r.trigger)}</td><td>${fmtTime(r.started_at)}</td>
        <td>${r.finished_at ? fmtTime(r.finished_at) : '<span style="color:#d29922">running…</span>'}</td>
        <td>${r.error ? `<span class="err">${esc(r.error)}</span>` : reconDetails(r.summary)}</td></tr>`,
  },
};

// One page of a reconciliation table (rows + "Show more" row) and the table's total.
async function reconRows(name, offset = 0) {
  const t = RECON_TABLES[name];
  const [{ rows }, { rows: [{ n }] }] = await Promise.all([
    pool.query(`SELECT * FROM ${t.from} WHERE ${t.where} ORDER BY ${t.order} LIMIT $1 OFFSET $2`, [PAGE_SIZE, offset]),
    pool.query(`SELECT count(*)::int AS n FROM ${t.from} WHERE ${t.where}`),
  ]);
  const shown = offset + rows.length;
  const html = rows.map(t.row).join('') +
    moreRow({ colspan: t.cols, nextUrl: `/admin/reconciliation/rows/${name}?${qs({ offset: shown })}`, shown, total: n });
  return { html, total: n };
}

router.get('/admin/reconciliation', requireAdmin, async (req, res) => {
  try {
    const [open, fixed, inbox, runs, inboxCountsQ] = await Promise.all([
      reconRows('open'), reconRows('fixed'), reconRows('inbox'), reconRows('runs'),
      pool.query('SELECT status, COUNT(*)::int AS n FROM webhook_inbox GROUP BY status ORDER BY status'),
    ]);
    const inboxCounts = inboxCountsQ.rows.map((r) => `<span style="font-weight:600">${esc(r.status)}</span>: ${r.n}`).join(' &middot; ');

    const table = (head, { html, total }, empty) => total
      ? `<div class="table-wrap"><table style="width:100%;font-size:0.85rem"><thead><tr>${head.map((h) => `<th style="text-align:left">${h}</th>`).join('')}</tr></thead><tbody>${html}</tbody></table></div>`
      : `<p style="color:#5B5F6E">${empty}</p>`;

    const body = `
      <h2>Reconciliation</h2>
      <div class="card" style="margin-bottom:1.5rem">
        <p style="color:#5B5F6E;margin-bottom:0.75rem">Compares payment-provider records with the ledger and orders.
          Safe differences are repaired automatically by replaying the missing provider event; the rest are listed below.
          An issue you resolve stays resolved unless its details change.</p>
        <form hx-post="/admin/reconciliation/run" hx-swap="none" hx-on::after-request="location.reload()" hx-disabled-elt="find button">
          <button type="submit">Run reconciliation now</button>
        </form>
      </div>
      <div class="card" style="margin-bottom:1.5rem"><h3>Open issues (${open.total})</h3>
        ${table(['Kind', 'Reference', 'Details', 'Seen', ''], open, 'No open issues.')}</div>
      <div class="card" style="margin-bottom:1.5rem"><h3>Automatic fixes (${fixed.total})</h3>
        ${table(['Kind', 'Reference', 'Details', 'When'], fixed, 'Nothing has been repaired yet.')}</div>
      <div class="card" style="margin-bottom:1.5rem"><h3>Webhook inbox</h3>
        <p style="margin-bottom:0.75rem">${inboxCounts || 'empty'}</p>
        ${table(['Row', 'Event', 'Status', 'Attempts', 'Next retry', 'Last error', ''], inbox, 'No failed or in-flight webhooks.')}</div>
      <div class="card"><h3>Runs (${runs.total})</h3>
        ${table(['Run', 'Trigger', 'Started', 'Finished', 'Summary'], runs, 'No runs yet.')}</div>`;
    res.send(layout('Reconciliation', body, req.user));
  } catch (err) {
    console.error('Error rendering reconciliation page:', err);
    res.status(500).send('Internal Server Error');
  }
});

// GET /admin/reconciliation/rows/:table?offset= - htmx: next page of one reconciliation table
router.get('/admin/reconciliation/rows/:table', requireAdmin, async (req, res) => {
  if (!RECON_TABLES[req.params.table]) return res.status(404).end();
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
  res.send((await reconRows(req.params.table, offset)).html);
});

router.post('/admin/reconciliation/run', requireAdmin, async (req, res) => {
  try {
    const out = await req.app.locals.reconciler.run({ trigger: `manual:${req.user.email}` });
    res.status(out.error ? 500 : 200).json({ runId: out.runId, error: out.error, summary: out.summary });
  } catch (err) {
    console.error('Error running reconciliation:', err);
    res.status(500).json({ error: err.message });
  }
});

router.post('/admin/reconciliation/issues/:id/resolve', requireAdmin, async (req, res) => {
  await pool.query(
    `UPDATE recon_issues SET status='RESOLVED', resolved_at=now(), resolved_by=$2, note=$3
      WHERE id=$1 AND status='OPEN'`,
    [req.params.id, `admin:${req.user.email}`, (req.body && req.body.note) || null]
  );
  res.status(200).end();
});

router.post('/admin/webhooks/:id/retry', requireAdmin, async (req, res) => {
  const { requeueWebhook } = require('../payment/retryWorker');
  const ok = await requeueWebhook(req.params.id);
  res.status(ok ? 200 : 409).end();
});

// ---- assistant log (admin monitoring) -------------------------------------------------------
// Every assistant chat turn, answered or failed, from assistant_log (append-only; Clear chat
// does not remove it). Searchable by email, user id or text; filter by errors / flagged turns.
const LOG_FILTERS = { all: 'All turns', errors: 'Errors only', flagged: 'Flagged (cleaned, corrected, limits, fallbacks)' };
function logWhere({ q = '', status = 'all', user = '' }) {
  const params = [];
  const conds = [];
  const needle = String(q).trim().slice(0, 100);
  if (needle) {
    params.push(`%${needle.replace(/[\\%_]/g, '\\$&')}%`);
    conds.push(`(l.user_email ILIKE $${params.length} OR l.user_id::text ILIKE $${params.length} OR l.user_message ILIKE $${params.length} OR l.reply ILIKE $${params.length} OR l.error_code ILIKE $${params.length})`);
  }
  if (/^[0-9a-f-]{36}$/i.test(String(user))) { params.push(user); conds.push(`l.user_id = $${params.length}`); }
  if (status === 'errors') conds.push(`l.status = 'ERROR'`);
  if (status === 'flagged') conds.push(`(l.status = 'ERROR' OR cardinality(l.flags) > 0)`);
  return { where: conds.length ? `WHERE ${conds.join(' AND ')}` : '', params, needle };
}
const clip = (v, n) => { const t = String(v ?? ''); return t.length > n ? `${t.slice(0, n)}…` : t; };
const logTime = (d) => new Date(d).toISOString().replace('T', ' ').slice(0, 19) + ' UTC';

async function assistantLogRows({ q = '', status = 'all', user = '', offset = 0 } = {}) {
  const { where, params, needle } = logWhere({ q, status, user });
  const { rows } = await pool.query(
    `SELECT l.*, count(*) OVER () AS total FROM assistant_log l ${where}
      ORDER BY l.id DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, PAGE_SIZE, offset]
  );
  const total = rows.length ? Number(rows[0].total)
    : Number((await pool.query(`SELECT count(*) FROM assistant_log l ${where}`, params)).rows[0].count);
  const html = rows.map((r) => {
    const badge = r.status === 'OK'
      ? '<span style="color:#1b5e20;background:#e8f5e9;border:1px solid #a5d6a7;padding:0.1rem 0.45rem;border-radius:10px;font-size:0.75rem;font-weight:600">OK</span>'
      : `<span style="color:#b71c1c;background:#ffebee;border:1px solid #ef9a9a;padding:0.1rem 0.45rem;border-radius:10px;font-size:0.75rem;font-weight:600">${esc(r.error_code || 'ERROR')}</span>`;
    const flags = (r.flags || []).map((f) => `<span style="display:inline-block;background:#fff8e1;border:1px solid #ffe082;color:#795548;padding:0 0.4rem;border-radius:10px;font-size:0.7rem;margin:0.1rem 0.2rem 0 0">${esc(f)}</span>`).join('');
    const tools = (r.tools || []).map((t) => `${t.ok ? '✓' : '✗'} ${t.tool}${t.error ? ` → ${t.error}` : ''}${t.status ? ` (${t.status})` : ''}`).join(', ');
    const detail = [
      ['Full message', r.user_message],
      ['Full reply', r.reply ?? '—'],
      ...(r.raw_reply ? [['Model text (replaced)', r.raw_reply]] : []),
      ...(r.error_message ? [['Error', r.error_message]] : []),
      ['Tools', JSON.stringify(r.tools, null, 2)],
      ['Model', `${r.provider || '—'} · ${r.model_calls} call(s) · ${r.prompt_tokens} in / ${r.completion_tokens} out tokens · ${r.duration_ms} ms`],
      ['IP', r.ip || '—'],
    ].map(([k, v]) => `<div style="margin-top:0.4rem"><strong style="font-size:0.75rem;color:#5B5F6E">${esc(k)}</strong><pre style="white-space:pre-wrap;overflow-wrap:anywhere;margin:0.15rem 0 0;font-size:0.78rem;background:#f6f7f9;padding:0.4rem;border-radius:4px">${esc(v)}</pre></div>`).join('');
    return `<tr>
      <td style="width:11rem;min-width:9rem;overflow-wrap:anywhere;vertical-align:top">
        <small style="color:#5B5F6E">${esc(logTime(r.created_at))}</small><br>
        <a href="/admin/assistant?user=${esc(r.user_id)}" title="Only this user" style="font-size:0.85rem">${esc(r.user_email || r.user_id)}</a>
        <div style="margin-top:0.3rem">${badge}</div>${flags ? `<div>${flags}</div>` : ''}
        <small style="color:#5B5F6E">${r.duration_ms} ms · ${(r.prompt_tokens + r.completion_tokens).toLocaleString('en-US')} tokens</small></td>
      <td style="min-width:9rem;overflow-wrap:anywhere;vertical-align:top">${esc(clip(r.user_message, 160))}</td>
      <td style="min-width:12rem;overflow-wrap:anywhere;vertical-align:top">${esc(clip(r.reply ?? r.error_message ?? '', 200))}
        ${tools ? `<div><small style="color:#5B5F6E">${esc(tools)}</small></div>` : ''}
        <details style="margin-top:0.3rem"><summary style="cursor:pointer;font-size:0.8rem;color:#3949ab">Details</summary>${detail}</details></td>
    </tr>`;
  }).join('');
  const shown = offset + rows.length;
  return html + moreRow({ colspan: 3, nextUrl: `/admin/assistant/rows?${qs({ q: needle, status, user, offset: shown })}`, shown, total, q: needle || (status !== 'all' ? status : '') || user });
}

// GET /admin/assistant?q=&status=&user= - assistant chat log (admin only)
router.get('/admin/assistant', requireAdmin, async (req, res, next) => {
  try {
    const status = LOG_FILTERS[req.query.status] ? req.query.status : 'all';
    const q = String(req.query.q || '').slice(0, 100);
    const user = /^[0-9a-f-]{36}$/i.test(String(req.query.user || '')) ? String(req.query.user) : '';
    const s = (await pool.query(
      `SELECT count(*) AS turns, count(DISTINCT user_id) AS users,
              count(*) FILTER (WHERE status = 'ERROR') AS errors,
              count(*) FILTER (WHERE error_code = 'MODEL_BUSY') AS busy,
              count(*) FILTER (WHERE error_code = 'RATE_LIMITED') AS daily_limit,
              count(*) FILTER (WHERE 'CLEANED' = ANY(flags) OR 'CORRECTED' = ANY(flags) OR 'FALSE_CLAIM' = ANY(flags)) AS fixed,
              coalesce(sum(prompt_tokens + completion_tokens), 0) AS tokens,
              coalesce(round(avg(duration_ms) FILTER (WHERE status = 'OK')), 0) AS avg_ms
         FROM assistant_log WHERE created_at > now() - interval '24 hours'`)).rows[0];
    const who = user ? (await pool.query('SELECT email FROM users WHERE id = $1', [user])).rows[0] : null;
    const stat = (label, value, color = '#1A1D29') => `<div class="card" style="margin:0;padding:0.75rem 1rem"><small style="color:#5B5F6E">${esc(label)}</small><div style="font-size:1.35rem;font-weight:700;color:${color}">${esc(value)}</div></div>`;
    const body = `
      <div style="display:flex;flex-wrap:wrap;gap:0.5rem;justify-content:space-between;align-items:center;margin-bottom:1rem">
        <h2>Assistant Log</h2>
        <a href="/admin"><button class="alt">← Back to Admin Overview</button></a>
      </div>
      <p style="color:#5B5F6E;margin-top:0">Every LEARNX Assistant turn, answered or failed. Kept when a user clears their chat; deleted only after ${esc(process.env.ASSISTANT_LOG_DAYS || 90)} days (<code>ASSISTANT_LOG_DAYS</code>). Purchase steps are also in <code>intent_events</code>.</p>
      <h3 style="margin-bottom:0.5rem">Last 24 hours</h3>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:0.75rem;margin-bottom:1.5rem">
        ${stat('Turns', s.turns)}${stat('Users', s.users)}${stat('Errors', s.errors, Number(s.errors) ? '#b71c1c' : '#1A1D29')}
        ${stat('Model limit hit', s.busy)}${stat('Daily limit hit', s.daily_limit)}${stat('Replies fixed by app', s.fixed)}
        ${stat('Tokens', Number(s.tokens).toLocaleString('en-US'))}${stat('Avg reply time', `${s.avg_ms} ms`)}
      </div>
      ${user ? `<p>Showing only <strong>${esc(who?.email || user)}</strong> · <a href="/admin/assistant">show all users</a></p>` : ''}
      <form class="table-tools" hx-get="/admin/assistant/rows" hx-target="#log-rows" hx-swap="innerHTML"
        hx-trigger="input changed delay:300ms from:input[name=q], search from:input[name=q], change from:select" onsubmit="return false">
        <input type="search" name="q" value="${esc(q)}" placeholder="Search email, user id, message, reply or error code…" autocomplete="off">
        <select name="status" style="width:auto;margin:0">${Object.entries(LOG_FILTERS).map(([k, v]) => `<option value="${k}"${k === status ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select>
        <input type="hidden" name="user" value="${esc(user)}">
      </form>
      <div class="table-wrap"><table>
        <thead><tr><th>Turn</th><th>Message</th><th>Reply</th></tr></thead>
        <tbody id="log-rows">${await assistantLogRows({ q, status, user })}</tbody>
      </table></div>`;
    res.send(layout('Admin - Assistant Log', body, req.user));
  } catch (err) {
    next(err);
  }
});

// GET /admin/assistant/rows?q=&status=&user=&offset= - htmx: next page / filtered rows
router.get('/admin/assistant/rows', requireAdmin, async (req, res) => {
  try {
    const status = LOG_FILTERS[req.query.status] ? req.query.status : 'all';
    const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);
    res.send(await assistantLogRows({ q: req.query.q || '', status, user: req.query.user || '', offset }));
  } catch (err) {
    console.error('Error loading assistant log rows:', err);
    res.status(500).send('<tr><td colspan="3" class="err">Could not load the log.</td></tr>');
  }
});

module.exports = router;
