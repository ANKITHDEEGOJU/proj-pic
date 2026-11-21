'use strict';

const jwt = require('jsonwebtoken');
const COOKIE = 'token';

function issueToken(res, user) {
  const token = jwt.sign({ sub: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '2h' });
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', maxAge: 2 * 3600 * 1000 });
}
function clearToken(res) { res.clearCookie(COOKIE); }

// Admin rights come from ADMIN_EMAIL (that address can't be registered, see routes/auth.js).
const isAdminEmail = (email) => email === (process.env.ADMIN_EMAIL || 'admin@learnx.com');
// Where a logged-in user starts: the admin dashboard for the admin, the course list for everyone else.
const homePath = (user) => (user && user.isAdmin ? '/admin' : '/courses');

// Populates req.user if a valid JWT cookie exists. Never rejects.
function attachUser(req, _res, next) {
  try {
    const p = jwt.verify(req.cookies[COOKIE], process.env.JWT_SECRET, { algorithms: ['HS256'] });
    req.user = { id: p.sub, email: p.email, isAdmin: isAdminEmail(p.email) };
  } catch { req.user = null; }
  next();
}

// Rejects unauthenticated requests. HTMX gets HX-Redirect, browsers get 302.
function requireAuth(req, res, next) {
  if (req.user) return next();
  if (req.get('HX-Request')) { res.set('HX-Redirect', '/login'); return res.status(401).end(); }
  res.redirect('/login');
}

// The admin manages access (grants, pricing, reconciliation) and does not shop: buying as the admin
// would put the admin into the ledger as a customer. The shopper pages send the admin back to the
// dashboard. Still open to the admin: the admin pages, course guides (admin preview) and each
// organization's page (/org/<id>, linked from /admin/orgs).
const SHOPPER_PAGES = [
  /^\/courses(\/|$)/, /^\/cart(\/|$)/, /^\/checkout(\/|$)/, /^\/razorpay\/checkout/, /^\/subscription(\/|$)/,
  /^\/activity(\/|$)/, /^\/agent(\/|$)/, /^\/assistant(\/|$)/, /^\/org\/?$/, /^\/org\/seats\/checkout$/,
];
const GUIDE = /^\/courses\/[^/]+\/doc(\/status)?$/;
function keepAdminInAdminArea(req, res, next) {
  if (!req.user || !req.user.isAdmin || GUIDE.test(req.path) || !SHOPPER_PAGES.some((r) => r.test(req.path))) return next();
  if (req.method === 'GET' || req.method === 'HEAD') {
    if (req.get('HX-Request')) return res.set('HX-Redirect', '/admin').status(200).end();
    return res.redirect('/admin');
  }
  // A purchase or other shopper action: refused, nothing done.
  return res.status(403).send('<p class="error">The admin account does not buy or use the shop. Give access from Users instead.</p>');
}

module.exports = { issueToken, clearToken, attachUser, requireAuth, isAdminEmail, homePath, keepAdminInAdminArea };
