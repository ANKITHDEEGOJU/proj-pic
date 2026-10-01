const router = require('express').Router();
const bcrypt = require('bcryptjs');
const pool = require('../db');
const { issueToken, clearToken } = require('../auth');
const { layout, authForm, errorFragment } = require('../views');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

router.get('/login',    (req, res) => req.user ? res.redirect('/') : res.send(layout('Login', authForm('login'), null)));
router.get('/register', (req, res) => req.user ? res.redirect('/') : res.send(layout('Register', authForm('register'), null)));

router.post('/register', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const password = String(req.body.password || '');
  if (!EMAIL_RE.test(email)) return res.send(errorFragment('Invalid email'));
  if (password.length < 8)   return res.send(errorFragment('Password must be at least 8 characters'));
  try {
    const hash = await bcrypt.hash(password, 12);
    const { rows } = await pool.query(
      'INSERT INTO users (email, password_hash) VALUES ($1,$2) RETURNING id, email', [email, hash]);
    issueToken(res, rows[0]);
    res.set('HX-Redirect', '/').end();
  } catch (e) {
    if (e.code === '23505') 
      return res.send(errorFragment('Email already registered'));
    console.error(e); 
    res.send(errorFragment('Server error'));
  }
});

router.post('/login', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const { rows } = await pool.query('SELECT id, email, password_hash FROM users WHERE email=$1', [email]);
  const ok = rows[0] && await bcrypt.compare(String(req.body.password || ''), rows[0].password_hash);
  if (!ok) 
    return res.send(errorFragment('Invalid credentials'));
  issueToken(res, rows[0]);
  res.set('HX-Redirect', '/').end();
});

router.post('/logout', (req, res) => { clearToken(res); res.set('HX-Redirect', '/login').end(); });

module.exports = router;
