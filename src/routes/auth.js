'use strict';

const router = require('express').Router();
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { issueToken, clearToken, isAdminEmail, homePath } = require('../auth');
const { layout, authForm, errorFragment } = require('../views');
const limit = require('../services/rateLimit');

// Too many attempts: refused before any password work. Sent as 200 so htmx shows the message.
const tooMany = (res, sec) => res.set('Retry-After', String(sec)).send(errorFragment(`Too many attempts. Try again in ${limit.waitText(sec)}.`));

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Home: the admin goes to the dashboard, other logged-in users to the course list, everyone else to login.
router.get('/', (req, res) => res.redirect(req.user ? homePath(req.user) : '/login'));

router.get('/login',    (req, res) => req.user ? res.redirect(homePath(req.user)) : res.send(layout('Login', authForm('login'), null)));
router.get('/register', (req, res) => req.user ? res.redirect(homePath(req.user)) : res.send(layout('Register', authForm('register'), null)));

router.post('/register', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!EMAIL_RE.test(email)) return res.send(errorFragment('Invalid email'));
  if (password.length < 8)   return res.send(errorFragment('Password must be at least 8 characters'));
  if (password.length > 200) return res.send(errorFragment('Password is too long'));
  // The admin address can't be claimed by signing up (admin rights come from ADMIN_EMAIL), unless
  // explicitly allowed for first setup with ADMIN_ALLOW_REGISTER=1.
  if (email === String(process.env.ADMIN_EMAIL || 'admin@learnx.com').trim().toLowerCase() && process.env.ADMIN_ALLOW_REGISTER !== '1')
    return res.send(errorFragment('This email address is reserved'));
  const ipLimit = limit.hit('registerIp', req.ip);
  if (ipLimit.blocked) return tooMany(res, ipLimit.retryAfterSec);
  try {
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1,$2) RETURNING id, email', [email, hash]);
    issueToken(res, rows[0]);
    res.set('HX-Redirect', homePath({ isAdmin: isAdminEmail(rows[0].email) })).end();
  } catch (e) {
    if (e.code === '23505') 
      return res.send(errorFragment('Email already registered'));
    console.error(e); 
    res.send(errorFragment('Server error'));
  }
});

// Limits (see services/rateLimit.js): every attempt is counted BEFORE the password is checked, so
// parallel requests can't get extra guesses; a successful login clears that email's counts. The
// per-email+IP limit is the tight one; the per-email cap (from any IP) is higher, so a stranger can't
// easily lock someone else's account. A blocked request touches neither the database nor bcrypt.
router.post('/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase().slice(0, 254);
  const password = String(req.body.password || '').slice(0, 200);
  for (const [kind, key] of [['loginIp', req.ip], ['loginFail', `${email}|${req.ip}`], ['loginEmail', email]]) {
    const l = limit.hit(kind, key);
    if (l.blocked) return tooMany(res, l.retryAfterSec);
  }
  try {
    const { rows } = await pool.query('SELECT id, email, password_hash FROM users WHERE email=$1', [email]);
    const ok = rows[0] && await bcrypt.compare(password, rows[0].password_hash);
    if (!ok) return res.send(errorFragment('Invalid credentials'));
    limit.reset('loginFail', `${email}|${req.ip}`);
    limit.reset('loginEmail', email);
    issueToken(res, rows[0]);
    res.set('HX-Redirect', homePath({ isAdmin: isAdminEmail(rows[0].email) })).end();
  } catch (e) {
    console.error('[login]', e);
    res.send(errorFragment('Server error'));
  }
});

router.post('/logout', (req, res) => { clearToken(res); res.set('HX-Redirect', '/login').end(); });

module.exports = router;
