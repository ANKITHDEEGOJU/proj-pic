'use strict';
// Course documents: one guide per course.
//   - The guides ship as files: content/<course id>.md (CONTENT_DIR overrides the folder).
//     The admin never types a path: a course can only get the file named after it.
//   - Nothing is visible until an admin adds the file (Admin -> Course content). Adding stores a
//     copy in course_docs; adding again only updates it if the file changed (idempotent).
//   - Every add / update / remove is written to course_doc_events (append-only) for audit.
//   - Who may open a document is NOT stored anywhere: the route asks the normal access decision
//     on every request, so a purchase opens it and a refund / expired pass closes it.
const fs = require('node:fs');
const path = require('node:path');
const pool = require('../db');

const contentDir = () => process.env.CONTENT_DIR || path.join(__dirname, '..', '..', 'content');
const fileNameFor = (courseId) => `${courseId}.md`;
const MAX_BYTES = 200 * 1024;

// The bundled guide for a course, or null if there is none.
function bundledFile(courseId) {
  if (!/^[a-z0-9_-]{1,100}$/i.test(String(courseId))) return null;
  const file = path.join(contentDir(), fileNameFor(courseId));
  let body;
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > MAX_BYTES) return null;
    body = fs.readFileSync(file, 'utf8');
  } catch {
    return null;
  }
  const title = /^#\s+(.+)$/m.exec(body)?.[1]?.trim() || courseId;
  return { courseId, fileName: fileNameFor(courseId), title, body, bytes: Buffer.byteLength(body) };
}

// course id -> { title, fileName, addedBy, addedAt } for published documents (for course cards).
let published = new Map();
let loaded = false;

async function refresh() {
  const { rows } = await pool.query('SELECT course_id, title, file_name, added_by, added_at FROM course_docs');
  published = new Map(rows.map((r) => [r.course_id, { title: r.title, fileName: r.file_name, addedBy: r.added_by, addedAt: r.added_at }]));
  loaded = true;
  return published;
}
const ensureLoaded = () => (loaded ? published : refresh());
const isPublished = (courseId) => published.has(courseId);
const publishedInfo = (courseId) => published.get(courseId) || null;

async function get(courseId) {
  return (await pool.query('SELECT * FROM course_docs WHERE course_id = $1', [courseId])).rows[0] || null;
}

// Publish (or refresh) the bundled guide of one course. Returns { action: ADDED | UPDATED | UNCHANGED }.
async function add({ courseId, actor }) {
  const file = bundledFile(courseId);
  if (!file) {
    const e = new Error(`No document file ${fileNameFor(courseId)} for this course.`);
    e.code = 'NO_FILE';
    throw e;
  }
  const client = await pool.connect();
  let action = 'UNCHANGED';
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`course_doc:${courseId}`]);
    const cur = (await client.query('SELECT body FROM course_docs WHERE course_id = $1', [courseId])).rows[0];
    if (!cur || cur.body !== file.body) {
      action = cur ? 'UPDATED' : 'ADDED';
      await client.query(
        `INSERT INTO course_docs (course_id, file_name, title, body, added_by)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (course_id) DO UPDATE
           SET file_name = EXCLUDED.file_name, title = EXCLUDED.title, body = EXCLUDED.body,
               added_by = EXCLUDED.added_by, added_at = now()`,
        [courseId, file.fileName, file.title, file.body, actor]
      );
      await client.query('INSERT INTO course_doc_events (course_id, action, file_name, actor) VALUES ($1,$2,$3,$4)',
        [courseId, action, file.fileName, actor]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  await refresh();
  return { action, title: file.title };
}

// Take a course's document off. Returns { removed: true | false }.
async function remove({ courseId, actor }) {
  const client = await pool.connect();
  let removed = false;
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`course_doc:${courseId}`]);
    const gone = await client.query('DELETE FROM course_docs WHERE course_id = $1 RETURNING file_name', [courseId]);
    if (gone.rowCount) {
      removed = true;
      await client.query('INSERT INTO course_doc_events (course_id, action, file_name, actor) VALUES ($1,$2,$3,$4)',
        [courseId, 'REMOVED', gone.rows[0].file_name, actor]);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
  await refresh();
  return { removed };
}

async function history(limit = 30) {
  return (await pool.query('SELECT * FROM course_doc_events ORDER BY id DESC LIMIT $1', [limit])).rows;
}

module.exports = { bundledFile, refresh, ensureLoaded, isPublished, publishedInfo, get, add, remove, history, contentDir };
