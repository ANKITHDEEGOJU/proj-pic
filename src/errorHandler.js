'use strict';
// The last Express middleware: logs the error with a short reference and answers with a generic
// message. Internal text (SQL errors, stack details, provider responses) never reaches the client.
const { randomUUID } = require('node:crypto');

module.exports = function errorHandler(err, req, res, _next) {
  const ref = randomUUID().slice(0, 8);
  console.error(`[error ${ref}] ${req.method} ${req.originalUrl}`, err);
  if (res.headersSent) return;
  if (req.get('HX-Request')) return res.status(500).send(`<span class="err">Server error (ref ${ref}). Please try again.</span>`);
  res.status(500).json({ error: 'Server error', ref });
};
