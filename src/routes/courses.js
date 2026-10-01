const router = require('express').Router();
const pool = require('../db');
const { requireAuth } = require('../auth');
const { layout, courseCards } = require('../views');

router.get('/', requireAuth, async (req, res) => {
  const { rows } = await pool.query('SELECT * FROM courses ORDER BY price_cents');
  res.send(layout('Courses', `<h2>Courses</h2>${courseCards(rows)}`, req.user));
});

module.exports = router;
