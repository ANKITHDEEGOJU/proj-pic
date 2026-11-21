#!/usr/bin/env python3
# Builds docs/Project_Report.pdf from docs/Project_Report.md (no extra packages; needs Google Chrome):
#   python3 docs/build_report.py docs/Project_Report.md /tmp/report.html docs 1,4
#   google-chrome --headless=new --no-pdf-header-footer --allow-file-access-from-files \
#     --print-to-pdf=docs/Project_Report.pdf file:///tmp/report.html
# The last argument lists the sections that start on a new page.
"""docs/Project_Report.md -> styled HTML for print (headless Chrome).
Cover page (title, metadata, executive summary), one section per page group, running header,
page numbers, numbered figures, callouts. Usage: report2html.py in.md out.html base_dir"""
import html, os, re, sys

src, out, base = sys.argv[1], sys.argv[2], os.path.abspath(sys.argv[3])
BREAK_BEFORE = set(sys.argv[4].split(",")) if len(sys.argv) > 4 else None  # section numbers that start a page
lines = open(src, encoding="utf-8").read().split("\n")


def inline(t):
    codes = []
    t = re.sub(r"`([^`]+)`", lambda m: codes.append(m.group(1)) or f"\x00{len(codes)-1}\x00", t)
    t = t.replace("\\|", "|")
    t = re.sub(r"&(?!lt;|gt;|amp;|#)", "&amp;", t).replace("<", "&lt;").replace(">", "&gt;")

    def img(m):
        p = m.group(2)
        if not re.match(r"https?:", p):
            p = "file://" + os.path.normpath(os.path.join(base, p))
        return f'<figure><img src="{p}" alt="{m.group(1)}"><figcaption>{m.group(1)}</figcaption></figure>'

    t = re.sub(r"!\[([^\]]*)\]\(([^)]+)\)", img, t)
    t = re.sub(r"\[([^\]]+)\]\(([^)]+)\)", r'<a href="\2">\1</a>', t)
    t = re.sub(r"(?<![\"'>=])(https?://[^\s<|)]+)", r'<a href="\1">\1</a>', t)
    t = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", t)
    t = re.sub(r"(?<![\w*])\*(?!\s)(.+?)(?<!\s)\*(?![\w*])", r"<em>\1</em>", t)
    t = re.sub(r"\x00(\d+)\x00", lambda m: f"<code>{html.escape(codes[int(m.group(1))])}</code>", t)
    return t


def cells(row):
    return [c.strip() for c in re.split(r"(?<!\\)\|", row.strip().strip("|"))]


def blocks(ls):
    o, i = [], 0
    while i < len(ls):
        l = ls[i]
        if not l.strip():
            i += 1; continue
        if l.startswith(">"):
            buf = []
            while i < len(ls) and ls[i].startswith(">"):
                buf.append(ls[i][1:].lstrip()); i += 1
            o.append('<aside class="callout">' + "".join(blocks(buf)) + "</aside>"); continue
        if l.startswith("```"):
            j = i + 1; buf = []
            while j < len(ls) and not ls[j].startswith("```"):
                buf.append(ls[j]); j += 1
            o.append("<pre>" + html.escape("\n".join(buf)) + "</pre>"); i = j + 1; continue
        m = re.match(r"(#{3,6})\s+(.*)", l)
        if m:
            n = len(m.group(1)); o.append(f"<h{n}>{inline(m.group(2))}</h{n}>"); i += 1; continue
        if l.lstrip().startswith("|"):
            rows = []
            while i < len(ls) and ls[i].lstrip().startswith("|"):
                rows.append(ls[i]); i += 1
            head, body = cells(rows[0]), [cells(r) for r in rows[2:]]
            if len(body) >= 6 and len(head) <= 3 and all(len(c) <= 22 for r in body for c in r):
                half = (len(body) + 1) // 2
                mk = lambda part: ("<table><thead><tr>" + "".join(f"<th>{inline(h)}</th>" for h in head) + "</tr></thead><tbody>"
                                   + "".join("<tr>" + "".join(f"<td>{inline(c)}</td>" for c in r) + "</tr>" for r in part) + "</tbody></table>")
                o.append('<div class="two-up">' + mk(body[:half]) + mk(body[half:]) + "</div>")
                continue
            if all(not h for h in head):
                o.append('<table class="kv">' + "".join("<tr>" + "".join(f"<td>{inline(c)}</td>" for c in r) + "</tr>" for r in body) + "</table>")
            else:
                o.append(f'<table class="cols-{len(head)}{" keep" if len(body) <= 10 else ""}"><thead><tr>' + "".join(f"<th>{inline(h)}</th>" for h in head) + "</tr></thead><tbody>"
                         + "".join("<tr>" + "".join(f"<td>{inline(c)}</td>" for c in r) + "</tr>" for r in body) + "</tbody></table>")
            continue
        m = re.match(r"(\s*)([-*]|\d+\.)\s+(.*)", l)
        if m:
            tag = "ol" if m.group(2)[0].isdigit() else "ul"; items = []
            while i < len(ls):
                mm = re.match(r"(\s*)([-*]|\d+\.)\s+(.*)", ls[i])
                if mm and len(mm.group(1)) == len(m.group(1)):
                    items.append(mm.group(3)); i += 1
                elif ls[i].startswith("  ") and ls[i].strip() and items:
                    items[-1] += " " + ls[i].strip(); i += 1
                else:
                    break
            o.append(f"<{tag}>" + "".join(f"<li>{inline(x)}</li>" for x in items) + f"</{tag}>"); continue
        buf = []
        while i < len(ls) and ls[i].strip() and not re.match(r"(#{1,6}\s|\s*\||\s*([-*]|\d+\.)\s|```|>)", ls[i]):
            buf.append(ls[i].strip()); i += 1
        para = " ".join(buf)
        figs = re.findall(r"<figure>.*?</figure>", inline(para))
        if figs and "".join(figs) == inline(para).replace("</figure> <figure>", "</figure><figure>"):
            o.append(figs[0] if len(figs) == 1 else '<div class="fig-row">' + "".join(figs) + "</div>")
        else:
            o.append("<p>" + inline(para) + "</p>")
    return o


# Split into: title, cover meta table, sections (## ...)
title = re.match(r"#\s+(.*)", lines[0]).group(1)
sec_idx = [k for k, l in enumerate(lines) if l.startswith("## ")]
pre = lines[1:sec_idx[0]]
sections = []
for a, b in zip(sec_idx, sec_idx[1:] + [len(lines)]):
    sections.append((lines[a][3:].strip(), lines[a + 1:b]))

main_title, _, subtitle = title.partition(": ")
cover = f"""<section class="cover">
  <div class="band">
    <div class="eyebrow">CS5903 · Final Project Report</div>
    <h1>{inline(main_title)}</h1>
    <div class="subtitle">{inline(subtitle[:1].upper() + subtitle[1:])}</div>
  </div>
  {''.join(blocks(pre))}
"""
body = [cover]
for k, (head, content) in enumerate(sections):
    m = re.match(r"(\d+)\.\s+(.*)", head)
    num, text = (m.group(1), m.group(2)) if m else ("", head)
    if head.lower().startswith("executive summary"):
        body.append(f'<div class="summary"><h2 class="plain">{inline(head)}</h2>{"".join(blocks(content))}</div></section>')
        continue
    brk = BREAK_BEFORE is None or (num or "R") in BREAK_BEFORE
    label = f'<span class="num">{num}</span>' if num else ""
    body.append(f'<section class="sec{" brk" if brk else ""}"><h2>{label}{inline(text)}</h2>{"".join(blocks(content))}</section>')

css = r"""
@page {
  size: A4; margin: 15mm 14mm 14mm 14mm;
  @top-left { content: "LEARNX · Final Project Report"; font: 600 7.5pt 'Noto Sans', Arial, sans-serif; color: #7a7f8f; letter-spacing: .04em; }
  @top-right { content: "CS5903 · Project 7 · Group 46"; font: 7.5pt 'Noto Sans', Arial, sans-serif; color: #7a7f8f; }
  @bottom-right { content: counter(page) " / " counter(pages); font: 7.5pt 'Noto Sans', Arial, sans-serif; color: #7a7f8f; }
  @bottom-left { content: "github.com/ANKITHDEEGOJU/proj-pic"; font: 7.5pt 'Noto Sans', Arial, sans-serif; color: #9aa0ae; }
}
@page :first { margin-top: 14mm; @top-left { content: none; } @top-right { content: none; } }
:root { --ink: #1b1e27; --muted: #5b5f6e; --blue: #2743d8; --blue-ink: #1f36b0; --tint: #eef1fd; --line: #d9ddea; --zebra: #f7f8fc; }
* { box-sizing: border-box; }
body { font-family: 'Noto Sans', 'Liberation Sans', Arial, sans-serif; font-size: 9.1pt; line-height: 1.34; color: var(--ink); margin: 0; }
.cover .band { background: var(--blue); color: #fff; border-radius: 10px; padding: 16pt 18pt 15pt; margin-bottom: 12pt; }
.cover .eyebrow { font-size: 7.8pt; letter-spacing: .14em; text-transform: uppercase; opacity: .85; margin-bottom: 6pt; }
.cover h1 { font-size: 26pt; line-height: 1.1; margin: 0 0 5pt; letter-spacing: -.01em; }
.cover .subtitle { font-size: 11.5pt; opacity: .95; }
.cover table.kv { margin-bottom: 10pt; }
.summary { border: 1px solid var(--line); border-radius: 10px; padding: 4pt 14pt 6pt; background: #fbfbfe; }
h2 { font-size: 15pt; color: var(--blue-ink); margin: 0 0 9pt; padding-bottom: 5pt; border-bottom: 1.5px solid var(--line); break-after: avoid; display: flex; align-items: center; gap: 8pt; }
h2.plain { font-size: 12.5pt; border: 0; margin: 8pt 0 4pt; padding: 0; }
h2 .num { display: inline-flex; align-items: center; justify-content: center; min-width: 20pt; height: 20pt; border-radius: 6pt; background: var(--blue); color: #fff; font-size: 10.5pt; padding: 0 5pt; }
h3 { font-size: 11pt; margin: 10pt 0 4pt; break-after: avoid; }
section.sec { margin-top: 16pt; }
section.sec.brk { break-before: page; margin-top: 0; }
p { margin: 2pt 0 5pt; text-align: left; orphans: 3; widows: 3; }
p > strong:first-child { color: var(--blue-ink); }
ul, ol { margin: 2pt 0 5pt; padding-left: 15pt; } li { margin: 1pt 0; } li::marker { color: var(--blue); }
table { border-collapse: separate; border-spacing: 0; width: 100%; margin: 5pt 0 9pt; font-size: 8.3pt; border: 1px solid var(--line); border-radius: 7px; overflow: hidden; break-inside: auto; }
thead { display: table-header-group; }
tr { break-inside: avoid; }
th, td { padding: 2.8pt 5pt; vertical-align: top; text-align: left; border-bottom: 1px solid var(--line); overflow-wrap: break-word; word-break: normal; hyphens: manual; }
tbody tr:last-child td { border-bottom: 0; }
th { white-space: nowrap; background: var(--tint); color: var(--blue-ink); font-weight: 700; font-size: 8pt; }
tbody tr:nth-child(even) td { background: var(--zebra); }
table.kv td { border-bottom: 1px solid var(--line); }
table.kv td:first-child { width: 24%; background: var(--tint); color: var(--blue-ink); font-weight: 600; }
table.kv tr:nth-child(even) td:not(:first-child) { background: #fff; }
code { font-family: 'DejaVu Sans Mono', 'Liberation Mono', monospace; font-size: 7.9pt; background: #f0f2f8; padding: 0 2.5px; border-radius: 3px; color: #2b2f3c; }
pre { background: #f0f2f8; padding: 6pt; font-size: 8pt; white-space: pre-wrap; border-radius: 6px; }
figure { margin: 6pt 0 8pt; break-inside: avoid; counter-increment: fig; border: 1px solid var(--line); border-radius: 8px; padding: 8pt 8pt 6pt; text-align: center; }
figure img { max-width: 100%; max-height: 74mm; }
figcaption { font-size: 8pt; color: var(--muted); margin-top: 4pt; text-align: left; }
figcaption::before { content: "Figure " counter(fig) ". "; font-weight: 700; color: var(--blue-ink); }
aside.callout { background: var(--tint); border-radius: 8px; padding: 6pt 10pt; margin: 6pt 0 9pt; break-inside: avoid; }
aside.callout p { margin: 2pt 0; }
.two-up { display: flex; gap: 8pt; } .two-up table { flex: 1; }
.fig-row figure img { max-height: 62mm; }
table.cols-6 th:nth-child(1) { width: 3%; } table.cols-6 th:nth-child(2) { width: 16%; } table.cols-6 th:nth-child(3) { width: 22%; }
table.cols-6 th:nth-child(4) { width: 17%; } table.cols-6 th:nth-child(5) { width: 15%; } table.cols-6 th:nth-child(6) { width: 27%; }
table.cols-6 th { white-space: normal; }
table.keep { break-inside: avoid; }
p:has(+ table), p:has(+ .two-up), p:has(+ ul), p:has(+ ol) { break-after: avoid; }
a { color: var(--blue); text-decoration: none; overflow-wrap: anywhere; }
body { counter-reset: fig; }
"""
open(out, "w", encoding="utf-8").write(
    f'<!doctype html><html lang="en"><head><meta charset="utf-8"><title>LEARNX — Final Project Report</title><style>{css}</style></head><body>'
    + "\n".join(body) + "</body></html>")
print("ok")
