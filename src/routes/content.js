'use strict';
// Course documents (one guide per course).
//   GET  /admin/content                     admin: each course, its bundled file, Add / Remove, history
//   POST /admin/content/:courseId/add       admin: publish (or refresh) the course's bundled file
//   POST /admin/content/:courseId/remove    admin: take it off
//   GET  /courses/:slug/doc                 learner: the document, only with access to the course
//   GET  /courses/:slug/doc/status          learner: polled by an open document; reloads it when access ends
// Access is decided on every request by the normal access decision (purchase, All-Access pass,
// org seat, admin / scholarship grant). Nothing about document access is stored.
const router = require('express').Router();
const { requireAuth } = require('../auth');
const { requireAdmin } = require('./admin');
const { layout, esc, when } = require('../views');
const docs = require('../services/courseDocs');
const { renderMarkdown } = require('../services/markdown');

const courses = (catalog) => catalog.list().filter((p) => (p.type || 'COURSE') === 'COURSE');
const findCourse = (catalog, key) => courses(catalog).find((p) => p.id === key || p.slug === key) || null;

// ---- admin ------------------------------------------------------------------------------------
router.get('/admin/content', requireAdmin, async (req, res, next) => {
  try {
    await docs.refresh();
    const { catalog } = req.app.locals.engine;
    const rows = courses(catalog).map((c) => {
      const file = docs.bundledFile(c.id);
      const pub = docs.publishedInfo(c.id);
      const changed = pub && file && (pub.title !== file.title); // cheap hint; Add compares the full text
      const status = pub
        ? `<span class="ok">Published</span><br><small>${esc(pub.fileName)} · by ${esc(pub.addedBy)} · ${esc(when(pub.addedAt))}</small>`
        : '<span style="color:#5B5F6E">Not published</span>';
      const fileCell = file
        ? `<code>content/${esc(file.fileName)}</code><br><small>“${esc(file.title)}” · ${(file.bytes / 1024).toFixed(1)} KB</small>`
        : '<span class="err">No file</span>';
      const actions = `<div style="display:flex;flex-direction:column;gap:0.4rem;align-items:stretch">
        ${file ? `<form method="POST" action="/admin/content/${esc(c.id)}/add" style="margin:0" onsubmit="this.querySelector('button').disabled = true">
          <button type="submit" style="width:100%">${pub ? 'Update from file' : 'Add to course'}</button></form>` : ''}
        ${pub ? `<form method="POST" action="/admin/content/${esc(c.id)}/remove" style="margin:0" onsubmit="this.querySelector('button').disabled = true">
          <button type="submit" class="alt" style="width:100%">Remove</button></form>` : ''}
        ${pub ? `<a href="/courses/${esc(c.slug || c.id)}/doc"><button type="button" class="alt" style="width:100%">View</button></a>` : ''}</div>`;
      return `<tr><td><strong>${esc(c.name)}</strong><br><small style="color:#5B5F6E">${esc(c.id)}</small></td>
        <td style="overflow-wrap:anywhere">${fileCell}</td><td style="min-width:9rem;overflow-wrap:anywhere">${status}${changed ? '<br><small style="color:#8a4b00">The file has changed since it was added.</small>' : ''}</td><td style="min-width:9rem">${actions}</td></tr>`;
    }).join('');
    const hist = (await docs.history(20)).map((h) => `<tr><td><small>${esc(when(h.created_at))}</small></td><td>${esc(h.course_id)}</td>
      <td>${esc(h.action)}</td><td><small>${esc(h.file_name || '')}</small></td><td><small>${esc(h.actor)}</small></td></tr>`).join('');
    const note = { ADDED: 'Document added.', UPDATED: 'Document updated from the file.', UNCHANGED: 'Already published; the file has not changed.', REMOVED: 'Document removed.', NOT_PUBLISHED: 'That course has no document to remove.' }[req.query.done];
    const body = `
      <div style="display:flex;flex-wrap:wrap;gap:0.5rem;justify-content:space-between;align-items:center;margin-bottom:1rem">
        <h2>Course content</h2>
        <a href="/admin"><button class="alt">← Back to Admin Overview</button></a>
      </div>
      <p style="color:#5B5F6E;margin-top:0">One guide per course, from <code>content/&lt;course id&gt;.md</code>. Learners can open a published guide only while they have access to the course (purchase, All-Access Pass, organization seat or a grant); a refund or an expired pass closes it.</p>
      ${note ? `<p class="${req.query.done === 'NOT_PUBLISHED' ? 'err' : 'ok'}">${esc(note)}</p>` : ''}
      <div class="table-wrap"><table>
        <thead><tr><th>Course</th><th>Document file</th><th>Status</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <h3>History</h3>
      <div class="table-wrap"><table>
        <thead><tr><th>Time</th><th>Course</th><th>Action</th><th>File</th><th>By</th></tr></thead>
        <tbody>${hist || '<tr><td colspan="5">None yet</td></tr>'}</tbody>
      </table></div>`;
    res.send(layout('Admin - Course content', body, req.user));
  } catch (e) {
    next(e);
  }
});

router.post('/admin/content/:courseId/add', requireAdmin, async (req, res, next) => {
  try {
    const c = findCourse(req.app.locals.engine.catalog, req.params.courseId);
    if (!c) return res.status(404).send('Unknown course');
    const out = await docs.add({ courseId: c.id, actor: req.user.email });
    res.redirect(`/admin/content?done=${out.action}`);
  } catch (e) {
    if (e.code === 'NO_FILE') return res.status(400).send(esc(e.message));
    next(e);
  }
});

router.post('/admin/content/:courseId/remove', requireAdmin, async (req, res, next) => {
  try {
    const c = findCourse(req.app.locals.engine.catalog, req.params.courseId);
    if (!c) return res.status(404).send('Unknown course');
    const out = await docs.remove({ courseId: c.id, actor: req.user.email });
    res.redirect(`/admin/content?done=${out.removed ? 'REMOVED' : 'NOT_PUBLISHED'}`);
  } catch (e) {
    next(e);
  }
});

// ---- learner ----------------------------------------------------------------------------------
const DENIED = {
  NO_PURCHASE_RECORD: "You don't have access to this course yet. Buy it, or get the All-Access Pass, to open its guide.",
  PURCHASE_REFUNDED: 'Your purchase of this course was refunded, so its guide is closed.',
  PURCHASE_CHARGED_BACK: 'The payment for this course was charged back, so its guide is closed.',
  ACCESS_REVOKED: 'Your access to this course was revoked by an admin.',
  SEAT_UNASSIGNED: 'Your organization seat for this course was taken back.',
  SUBSCRIPTION_EXPIRED: 'Your All-Access Pass has ended. Renew it to open the guide again.',
  ENTITLEMENT_EXPIRED: 'Your access to this course has expired.',
};

router.get('/courses/:slug/doc', requireAuth, async (req, res, next) => {
  // Paid content: never kept by the browser or a proxy (a refunded user must not reopen a copy).
  res.set('Cache-Control', 'no-store, private');
  try {
    await docs.ensureLoaded();
    const { catalog, decisions } = req.app.locals.engine;
    const c = findCourse(catalog, req.params.slug);
    const doc = c && (await docs.get(c.id));
    // The admin came from the Guides page (the course list is a shopper page).
    const back = req.user.isAdmin ? '<a href="/admin/content"><button class="alt">← Back to Guides</button></a>'
      : '<a href="/courses"><button class="alt">← Back to Courses</button></a>';
    if (!doc) {
      return res.status(404).send(layout('Course guide', `<h2>Course guide</h2><div class="card"><p>This course has no guide yet.</p>
        ${back}</div>`, req.user));
    }
    const slug = c.slug || c.id;
    const d = decisions.evaluateAccess(req.user.id, slug); // asked on every request, never cached
    const adminPreview = !d.allowed && req.user.isAdmin; // the admin can check what they published
    if (!d.allowed && !adminPreview) {
      // Only the course name here: nothing from the document (not even its title) without access.
      return res.status(403).send(layout(`${c.name}: course guide`, `<h2>${esc(c.name)}: course guide</h2>
        <div class="card" style="border-left:4px solid #c62828">
          <p class="err" style="margin-top:0">${esc(DENIED[d.reason] || 'You do not have access to this course.')}</p>
          <p style="color:#5B5F6E"><small>Access check: ${esc(d.reason)}${d.expiresAt ? ` (ended ${esc(when(d.expiresAt))})` : ''}</small></p>
          <a href="/courses"><button>Go to Courses</button></a>
        </div>`, req.user));
    }
    const via = adminPreview ? 'admin preview (you do not own this course)'
      : d.reason === 'ACTIVE_SUBSCRIPTION_PASS' ? `your All-Access Pass${d.expiresAt ? ` (until ${when(d.expiresAt)})` : ''}`
      : d.grantedVia === 'SEAT_ASSIGNED' ? 'your organization seat'
      : d.grantedVia === 'MANUAL_GRANT' ? 'a granted access'
      : 'your purchase';
    res.send(layout(doc.title, `
      <div style="display:flex;flex-wrap:wrap;gap:0.5rem;justify-content:space-between;align-items:center">
        <small style="color:#5B5F6E">Open through ${esc(via)}</small>
        ${back}
      </div>
      ${adminPreview ? '' : `<!-- Re-checks access while the guide is open; reloads it (showing why) when access ends. -->
      <div hx-get="/courses/${esc(slug)}/doc/status" hx-trigger="every 30s" hx-swap="none"></div>`}
      <article class="card course-doc" style="overflow-wrap:anywhere">
        <style>.course-doc pre{overflow-x:auto;background:#f6f7f9;padding:0.75rem;border-radius:6px;font-size:0.85rem}
          .course-doc code{font-size:0.9em}.course-doc h2{margin-top:0}
          .card.course-doc strong{display:inline;font-size:inherit;margin:0;color:inherit}</style>
        ${renderMarkdown(doc.body)}
      </article>`, req.user));
  } catch (e) {
    next(e);
  }
});

router.get('/courses/:slug/doc/status', requireAuth, (req, res) => {
  const { catalog, decisions } = req.app.locals.engine;
  const c = findCourse(catalog, req.params.slug);
  const allowed = c && docs.isPublished(c.id) && decisions.evaluateAccess(req.user.id, c.slug || c.id).allowed;
  if (allowed) return res.status(204).end();
  res.set('HX-Refresh', 'true').status(200).end();
});

module.exports = router;
