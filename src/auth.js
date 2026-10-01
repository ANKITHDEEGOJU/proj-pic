const jwt = require('jsonwebtoken');
const COOKIE = 'token';

function issueToken(res, user) {
  const token = jwt.sign({ sub: user.id, email: user.email }, process.env.JWT_SECRET, { expiresIn: '2h' });
  res.cookie(COOKIE, token, { httpOnly: true, sameSite: 'lax', maxAge: 2 * 3600 * 1000 });
}
function clearToken(res) { res.clearCookie(COOKIE); }

// Populates req.user if a valid JWT cookie exists. Never rejects.
function attachUser(req, _res, next) {
  try {
    const p = jwt.verify(req.cookies[COOKIE], process.env.JWT_SECRET);
    req.user = { id: p.sub, email: p.email };
  } catch { req.user = null; }
  next();
}

// Rejects unauthenticated requests. HTMX gets HX-Redirect, browsers get 302.
function requireAuth(req, res, next) {
  if (req.user) return next();
  if (req.get('HX-Request')) { res.set('HX-Redirect', '/login'); return res.status(401).end(); }
  res.redirect('/login');
}

module.exports = { issueToken, clearToken, attachUser, requireAuth };
