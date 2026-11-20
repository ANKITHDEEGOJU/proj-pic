'use strict';
// Minimal, safe Markdown -> HTML for the course documents. Everything is HTML-escaped first,
// so a document can never inject markup or scripts. Supported: # / ## / ### headings,
// paragraphs, - and 1. lists, ``` fenced code blocks, `inline code` and **bold**.
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Inline formatting on one already-split line: code spans first (their content is left as is).
function inline(text) {
  return text.split(/(`[^`]+`)/).map((part) => {
    if (/^`[^`]+`$/.test(part)) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
    return escapeHtml(part).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  }).join('');
}

function renderMarkdown(src) {
  const lines = String(src).replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  let para = [];
  let list = null; // { tag: 'ul' | 'ol', items: [] }
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`<${list.tag}>${list.items.map((i) => `<li>${inline(i)}</li>`).join('')}</${list.tag}>`); list = null; } };
  const flush = () => { flushPara(); flushList(); };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^```\s*([\w-]*)\s*$/.exec(line);
    if (fence) {
      flush();
      const code = [];
      for (i++; i < lines.length && !/^```\s*$/.test(lines[i]); i++) code.push(lines[i]);
      out.push(`<pre><code${fence[1] ? ` class="lang-${escapeHtml(fence[1])}"` : ''}>${escapeHtml(code.join('\n'))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,3})\s+(.+)$/.exec(line);
    if (h) { flush(); const n = h[1].length; out.push(`<h${n + 1}>${inline(h[2].trim())}</h${n + 1}>`); continue; }
    const ul = /^\s*[-*]\s+(.+)$/.exec(line);
    const ol = /^\s*\d+\.\s+(.+)$/.exec(line);
    if (ul || ol) {
      flushPara();
      const tag = ul ? 'ul' : 'ol';
      if (list && list.tag !== tag) flushList();
      if (!list) list = { tag, items: [] };
      list.items.push((ul || ol)[1]);
      continue;
    }
    if (!line.trim()) { flush(); continue; }
    if (list && /^\s{2,}\S/.test(line)) { list.items[list.items.length - 1] += ` ${line.trim()}`; continue; } // wrapped list item
    flushList();
    para.push(line.trim());
  }
  flush();
  return out.join('\n');
}

module.exports = { renderMarkdown, escapeHtml };
