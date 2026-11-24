// A faster drop-in for makefun-site 1.0.0: run(input) returns exactly the output tree
// makefun-site's build returns, byte for byte. Written from the published spec (its
// README) and the reference's observable behaviour. Optimisations over the reference:
// the Markdown lexer and renderer are fused into one pass over the lines; inline
// rendering scans for the next special character and escapes plain runs in bulk
// instead of escaping one character at a time; slugify and longDate are memoised
// per build; front matter is scanned without splitting the whole body; each page's
// card is built once and reused; template rendering appends to an array.
//
// The input: { site: { title, base_url, per_page, recent }, templates: { name: source },
// files: [{ path, content }] }. The output: { path: text } for every file the build
// writes. The build reads no clock, no environment, no randomness and no file.

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_RE = /[&<>"']/g;

/** `text` with & < > " and ' escaped. */
function esc(text) {
  return text.replace(ESC_RE, (c) => ESCAPES[c]);
}

/** Per-build caches, reset by run(): nothing is carried from one case to the next. */
let slugCache;
let dateCache;

/**
 * The slug of `text`: NFKD, combining marks dropped, A-Z lowered, every run of
 * characters other than a-z and 0-9 one "-", none at either end, at most 64
 * characters (a "-" left at the cut dropped), "untitled" when nothing is left.
 * Pure-ASCII text normalises to itself, so the NFKD pass is skipped for it.
 */
function slugify(text) {
  const hit = slugCache.get(text);
  if (hit !== undefined) return hit;
  let plain = text;
  let ascii = true;
  for (let k = 0; k < text.length; k++) {
    if (text.charCodeAt(k) > 127) {
      ascii = false;
      break;
    }
  }
  if (!ascii) plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (let k = 0; k < plain.length; k++) {
    const ch = plain[k];
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  out = out.slice(0, 64).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  slugCache.set(text, out);
  return out;
}

/** `slug` made unique against `taken` (and added to it). */
function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
function longDate(date) {
  const hit = dateCache.get(date);
  if (hit !== undefined) return hit;
  const y = date.slice(0, 4);
  const m = Number(date.slice(5, 7));
  const d = Number(date.slice(8, 10));
  const out = `${d} ${MONTHS[m - 1]} ${y}`;
  dateCache.set(date, out);
  return out;
}

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------- front matter

const FM_KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare. */
function stringOf(raw) {
  if (raw.charCodeAt(0) === 34) {
    if (raw.length < 2 || raw.charCodeAt(raw.length - 1) !== 34) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.charCodeAt(0) === 91) return { error: 'a bare string opens on [' };
  return { value: raw };
}

/** One key's value, or why it is refused. */
function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = FM_DATE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (raw.charCodeAt(0) !== 91 || raw.charCodeAt(raw.length - 1) !== 93) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !FM_TAG.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return FM_NAME.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return FM_SLUG.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function isBlankLine(line) {
  if (line === '') return true;
  if (line.charCodeAt(0) !== 32 && line.charCodeAt(0) !== 9) return false;
  for (let k = 1; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/**
 * A source's front matter and body: { data, body }, or { error } with the first
 * reason it is refused. `text` has "\n" line ends. Only the front matter lines
 * are walked; the body is one slice, never split and re-joined.
 */
function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) {
    // The first line is not exactly "---": check it without splitting the text.
    const nl = text.indexOf('\n');
    if ((nl === -1 ? text : text.slice(0, nl)) !== '---') return { error: 'no front matter' };
  }
  let p = text.indexOf('\n');
  if (p === -1) return { error: 'the front matter is not closed' };
  p++;
  const data = {};
  let lineNo = 2;
  let closeEnd = -1;
  for (;;) {
    const nl = text.indexOf('\n', p);
    const end = nl === -1 ? text.length : nl;
    const line = text.slice(p, end);
    if (line === '---') {
      closeEnd = end;
      break;
    }
    if (nl === -1) return { error: 'the front matter is not closed' };
    if (!isBlankLine(line) && line.charCodeAt(0) !== 35) {
      const ci = line.indexOf(':');
      let key = '';
      let raw = null;
      if (ci !== -1) {
        key = line.slice(0, ci);
        const rest = line.slice(ci + 1);
        if (rest === '') raw = '';
        else if (rest.charCodeAt(0) === 32) raw = rest.slice(1);
      }
      let ok = raw !== null;
      if (ok) {
        for (let k = 0; k < key.length; k++) {
          const c = key.charCodeAt(k);
          if (!((c >= 97 && c <= 122) || c === 95)) {
            ok = false;
            break;
          }
        }
        if (key.length === 0) ok = false;
      }
      if (!ok) return { error: `line ${lineNo} is not "key: value"` };
      raw = raw.replace(/[ \t]+$/, '');
      if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
      if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
      if (raw === '') return { error: `key "${key}" has no value` };
      const v = valueOf(key, raw);
      if ('error' in v) return v;
      data[key] = v.value;
    }
    p = nl + 1;
    lineNo++;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: closeEnd === text.length ? '' : text.slice(closeEnd + 1) };
}

// ---------------------------------------------------------------- markdown

const ESCAPABLE = new Set([92, 96, 42, 95, 91, 93, 40, 41, 35, 43, 45, 46, 33, 62]);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  let j = s.indexOf(what, from);
  while (j !== -1) {
    let k = j - 1;
    let bs = 0;
    while (k >= from && s.charCodeAt(k) === 92) {
      bs++;
      k--;
    }
    if (bs % 2 === 0) return j;
    j = s.indexOf(what, j + 1);
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  let j = s.indexOf('*', from);
  while (j !== -1) {
    let k = j - 1;
    let bs = 0;
    while (k >= from && s.charCodeAt(k) === 92) {
      bs++;
      k--;
    }
    if (bs % 2 === 1) {
      j = s.indexOf('*', j + 1);
      continue;
    }
    if (s.charCodeAt(j + 1) === 42) {
      j = s.indexOf('*', j + 2);
      continue;
    }
    return j;
  }
  return -1;
}

const SPECIAL_RE = /[\\`*\[&<>"']/g;

/**
 * `s` rendered inline, appended to `out`; `env.link(target)` is a link's href.
 * One regex jumps from one special character to the next, so plain runs are
 * never scanned twice: a run holds no escapable character (every escapable is
 * itself a special) and is pushed raw. Only a code span's text and a link's
 * href still go through the escape table.
 */
function inline(s, env, out) {
  const re = SPECIAL_RE;
  let i = 0;
  let plain = 0;
  const n = s.length;
  while (i < n) {
    re.lastIndex = i;
    const m = re.exec(s);
    if (m === null) break;
    const j = m.index;
    const c = s.charCodeAt(j);
    if (c === 92) {
      if (j + 1 < n && ESCAPABLE.has(s.charCodeAt(j + 1))) {
        if (plain < j) out.push(s.slice(plain, j));
        out.push(esc(s[j + 1]));
        i = j + 2;
        plain = i;
      } else i = j + 1;
    } else if (c === 96) {
      const k = s.indexOf('`', j + 1);
      if (k > j + 1) {
        if (plain < j) out.push(s.slice(plain, j));
        out.push('<code>', esc(s.slice(j + 1, k)), '</code>');
        i = k + 1;
        plain = i;
      } else i = j + 1;
    } else if (c === 42) {
      if (s.charCodeAt(j + 1) === 42) {
        const k = findUnescaped(s, '**', j + 2);
        if (k > j + 2) {
          if (plain < j) out.push(s.slice(plain, j));
          const sub = [];
          inline(s.slice(j + 2, k), env, sub);
          out.push('<strong>', sub.join(''), '</strong>');
          i = k + 2;
          plain = i;
        } else i = j + 2;
      } else {
        const k = findSingleStar(s, j + 1);
        if (k > j + 1) {
          if (plain < j) out.push(s.slice(plain, j));
          const sub = [];
          inline(s.slice(j + 1, k), env, sub);
          out.push('<em>', sub.join(''), '</em>');
          i = k + 1;
          plain = i;
        } else i = j + 1;
      }
    } else if (c === 91) {
      const k = findUnescaped(s, ']', j + 1);
      const q = k !== -1 && s.charCodeAt(k + 1) === 40 ? s.indexOf(')', k + 2) : -1;
      const target = q === -1 ? '' : s.slice(k + 2, q);
      if (target !== '' && !/\s/.test(target)) {
        if (plain < j) out.push(s.slice(plain, j));
        const href = esc(env.link(target));
        const sub = [];
        inline(s.slice(j + 1, k), env, sub);
        out.push('<a href="', href, '">', sub.join(''), '</a>');
        i = q + 1;
        plain = i;
      } else i = j + 1;
    } else {
      if (plain < j) out.push(s.slice(plain, j));
      out.push(ESCAPES[s[j]]);
      i = j + 1;
      plain = i;
    }
  }
  if (plain < n) out.push(s.slice(plain));
}

/** A line trimmed of spaces and tabs at both ends. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b && (line.charCodeAt(a) === 32 || line.charCodeAt(a) === 9)) a++;
  while (b > a && (line.charCodeAt(b - 1) === 32 || line.charCodeAt(b - 1) === 9)) b--;
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** A fence opening: its language, or null (the line is not one). */
function fenceOpen(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return null;
  let k = 3;
  while (k < line.length) {
    const c = line.charCodeAt(k);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 95 || c === 43 || c === 45) k++;
    else break;
  }
  const lang = line.slice(3, k);
  while (k < line.length) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return null;
    k++;
  }
  return lang;
}

/** Whether `line` closes a fence. */
function fenceClose(line) {
  if (line.charCodeAt(0) !== 96 || line.charCodeAt(1) !== 96 || line.charCodeAt(2) !== 96) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  let h = 0;
  while (h < 6 && line.charCodeAt(h) === 35) h++;
  if (h === 0) return null;
  const c = line.charCodeAt(h);
  if (c !== 32 && c !== 9) return null;
  const text = line.slice(h + 1).replace(/[ \t]+$/, '');
  if (text === '') return null;
  return { depth: h, text };
}

/** Whether `line` is a thematic break. */
function isHr(line) {
  if (!line.startsWith('---') && !line.startsWith('***')) return false;
  for (let k = 3; k < line.length; k++) {
    const c = line.charCodeAt(k);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a break. */
function endsParagraph(line) {
  return isBlankLine(line) || fenceOpen(line) !== null || headingOf(line) !== null || isHr(line);
}

/**
 * `src` rendered in one pass: its HTML (each block on its own lines, a "\n"
 * after the last), its table of contents (every level 2 and 3 heading: level, id
 * and its inline HTML) and its excerpt (the first paragraph's inline HTML, or "").
 */
function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const ids = new Set();
  const out = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const N = lines.length;
  while (i < N) {
    const line = lines[i];
    if (isBlankLine(line)) {
      i++;
      continue;
    }
    const lang = fenceOpen(line);
    if (lang !== null) {
      const body = [];
      i++;
      while (i < N && !fenceClose(lines[i])) body.push(lines[i++]);
      i++;
      const cls = lang === '' ? '' : ` class="language-${esc(lang)}"`;
      const parts = [`<pre><code${cls}>`];
      for (const l of body) {
        parts.push(esc(l), '\n');
      }
      parts.push('</code></pre>');
      out.push(parts.join(''), '\n');
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const sub = [];
      inline(heading.text, env, sub);
      const html = sub.join('');
      out.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`, '\n');
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if (isHr(line)) {
      out.push('<hr>', '\n');
      i++;
      continue;
    }
    if (line.charCodeAt(0) === 62) {
      const body = [];
      while (i < N && lines[i].charCodeAt(0) === 62) {
        const l = lines[i++];
        body.push(trimLine(l.charCodeAt(1) === 32 ? l.slice(2) : l.slice(1)));
      }
      const kept = body.filter((l) => l !== '');
      if (kept.length === 0) out.push('<blockquote>\n</blockquote>', '\n');
      else {
        const sub = [];
        inline(kept.join('\n'), env, sub);
        out.push(`<blockquote>\n<p>${sub.join('')}</p>\n</blockquote>`, '\n');
      }
      continue;
    }
    const bullet = line.startsWith('- ') || line.startsWith('* ');
    let ordered = null;
    if (!bullet) {
      let d = 0;
      while (d < 9 && lines[i].charCodeAt(d) >= 48 && lines[i].charCodeAt(d) <= 57) d++;
      if (d > 0 && line.charCodeAt(d) === 46 && line.charCodeAt(d + 1) === 32) ordered = { start: Number(line.slice(0, d)), off: d + 2 };
    }
    if (bullet || ordered !== null) {
      const isOrdered = ordered !== null;
      const items = [];
      while (i < N) {
        const l = lines[i];
        if (isOrdered) {
          let d = 0;
          while (d < 9 && l.charCodeAt(d) >= 48 && l.charCodeAt(d) <= 57) d++;
          if (d > 0 && l.charCodeAt(d) === 46 && l.charCodeAt(d + 1) === 32) {
            items.push([trimLine(l.slice(d + 2))]);
            i++;
            continue;
          }
        } else if (l.startsWith('- ') || l.startsWith('* ')) {
          items.push([trimLine(l.slice(2))]);
          i++;
          continue;
        }
        if (l.charCodeAt(0) === 32 && l.charCodeAt(1) === 32) {
          let k = 2;
          while (k < l.length && l.charCodeAt(k) === 32) k++;
          if (k < l.length) {
            const c = l.charCodeAt(k);
            if (c !== 32 && c !== 9 && c !== 13 && c !== 11 && c !== 12) {
              items[items.length - 1].push(trimLine(l));
              i++;
              continue;
            }
          }
        }
        break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && ordered.start !== 1 ? `<ol start="${ordered.start}">` : `<${tag}>`;
      const parts = [open, '\n'];
      for (const item of items) {
        const sub = [];
        inline(item.join('\n'), env, sub);
        parts.push('<li>', sub.join(''), '</li>\n');
      }
      parts.push(`</${tag}>`);
      out.push(parts.join(''), '\n');
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < N && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const text = body.join('\n');
    const sub = [];
    inline(text, env, sub);
    const html = sub.join('');
    if (excerpt === null) excerpt = html;
    out.push(`<p>${html}</p>`, '\n');
  }
  return { html: out.join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

const INCLUDE_DEPTH = 8;
const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INCLUDE_RE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) {
      text += src.slice(i);
      break;
    }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') {
      text += src.slice(i, open + 1);
      i = open + 1;
      continue;
    }
    text += src.slice(i, open);
    if (next === '{') {
      const raw = src[open + 2] === '{';
      const close = src.indexOf(raw ? '}}}' : '}}', open + (raw ? 3 : 2));
      if (close === -1) throw new TemplateError(`template "${name}": a ${raw ? '{{{' : '{{'} is not closed`);
      if (text !== '') tokens.push({ t: 'text', text });
      text = '';
      tokens.push({ t: raw ? 'raw' : 'var', path: pathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
      i = close + (raw ? 3 : 2);
      continue;
    }
    const close = src.indexOf('%}', open + 2);
    if (close === -1) throw new TemplateError(`template "${name}": a {% is not closed`);
    const end = close + 2;
    const lineStart = src.lastIndexOf('\n', open - 1) + 1;
    const nl = src.indexOf('\n', end);
    const lineEnd = nl === -1 ? src.length : nl;
    const standalone = /^[ \t]*$/.test(src.slice(lineStart, open)) && /^[ \t]*$/.test(src.slice(end, lineEnd));
    if (standalone) text = text.slice(0, text.length - (open - lineStart));
    if (text !== '') tokens.push({ t: 'text', text });
    text = '';
    tokens.push({ t: 'tag', tag: src.slice(open + 2, close).trim() });
    i = standalone ? (nl === -1 ? src.length : nl + 1) : end;
  }
  if (text !== '') tokens.push({ t: 'text', text });
  return tokens;
}

/** `src` parsed into its tree of nodes (a TemplateError when it does not parse). */
function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = FOR_RE.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: pathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = IF_RE.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: pathOf(name, m[2]), then: [], else: null };
        body.push(node);
        stack.push(node);
        body = node.then;
      } else if (tag === 'else') {
        if (top.kind !== 'if' || top.else !== null) throw new TemplateError(`template "${name}": an else outside an if`);
        top.else = [];
        body = top.else;
      } else if (tag === 'endfor' || tag === 'endif') {
        if (top.kind !== (tag === 'endfor' ? 'for' : 'if')) throw new TemplateError(`template "${name}": an ${tag} with no open ${tag.slice(3)}`);
        stack.pop();
        const parent = stack[stack.length - 1];
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : parent.else ?? parent.then;
      } else if ((m = INCLUDE_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function lookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  for (let k = 1; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text, escaped: esc(textOf(v)) in one call, with no escape scan for numbers and booleans. */
function escText(v) {
  if (typeof v === 'string') return esc(v);
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return esc(v.map(textOf).join(', '));
  return '';
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function truthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/** The value at `path` in the scope chain, fixed-arity lookups for compiled templates. */
function lk1(s, a) {
  while (s !== null && !Object.hasOwn(s.vars, a)) s = s.parent;
  return s === null ? undefined : s.vars[a];
}
function lk2(s, a, b) {
  while (s !== null && !Object.hasOwn(s.vars, a)) s = s.parent;
  if (s === null) return undefined;
  const v = s.vars[a];
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, b)) return undefined;
  return v[b];
}
function lk3(s, a, b, c) {
  while (s !== null && !Object.hasOwn(s.vars, a)) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[a];
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, b)) return undefined;
  v = v[b];
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, c)) return undefined;
  return v[c];
}

/** A lookup call for `path` in scope `sv`, as source text. */
function lkCall(sv, path) {
  if (path.length === 1) return `C.lk1(${sv},${JSON.stringify(path[0])})`;
  if (path.length === 2) return `C.lk2(${sv},${JSON.stringify(path[0])},${JSON.stringify(path[1])})`;
  if (path.length === 3) return `C.lk3(${sv},${JSON.stringify(path[0])},${JSON.stringify(path[1])},${JSON.stringify(path[2])})`;
  return `C.lk(${sv},${JSON.stringify(path)})`;
}

/** `nodes` compiled to source text for a function (S, out, C, depth). Runs of plain pushes are batched into one out.push call. */
function genNodes(nodes, sv, code) {
  let pending = [];
  const flush = () => {
    if (pending.length > 0) {
      code.push('out.push(', pending.join(','), ');');
      pending = [];
    }
  };
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        pending.push(JSON.stringify(n.text));
        break;
      case 'var':
        pending.push('C.ev(' + lkCall(sv, n.path) + ')');
        break;
      case 'raw':
        pending.push('C.tx(' + lkCall(sv, n.path) + ')');
        break;
      case 'if':
        flush();
        code.push('if(C.tru(', lkCall(sv, n.path), ')!==', n.not ? 'true' : 'false', '){');
        genNodes(n.then, sv, code);
        code.push('}');
        if (n.else !== null) {
          code.push('else{');
          genNodes(n.else, sv, code);
          code.push('}');
        }
        break;
      case 'for':
        flush();
        code.push('{const _x=', lkCall(sv, n.path), ';if(Array.isArray(_x)){const _s={vars:{},parent:', sv, '};const _l={index:0,first:false,last:false,length:_x.length};for(let _k=0;_k<_x.length;_k++){_s.vars.', n.name, '=_x[_k];_s.vars.loop=_l;_l.index=_k+1;_l.first=_k===0;_l.last=_k===_x.length-1;');
        genNodes(n.body, '_s', code);
        code.push('}}}');
        break;
      case 'include':
        flush();
        code.push('{const _f=C.t.get(', JSON.stringify(n.name), ');if(_f!==undefined&&depth<8)_f(', sv, ',out,C,depth+1);}');
        break;
    }
  }
  flush();
}

/**
 * `nodes` compiled to a function (S, out, C, depth), or null when the Function
 * constructor is unavailable. A compiled template walks no node tree: text is
 * pushed, values are looked up and loops run as plain code. Each for reuses one
 * scope object and one loop object for all its iterations (rendering is
 * synchronous, so nothing observes the reuse), and the element is bound before
 * the loop object, as the tree walk builds its vars.
 */
function compileTemplate(nodes) {
  const code = [];
  genNodes(nodes, 'S', code);
  try {
    return new Function('S', 'out', 'C', 'depth', code.join(''));
  } catch {
    return null;
  }
}

/**
 * `nodes` rendered in `scope` ({ vars, parent }), appended to `out`. `ctx` holds
 * the parsed templates and the include depth. This is the fallback when a
 * template could not be compiled.
 */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        out.push(n.text);
        break;
      case 'var':
        out.push(esc(textOf(lookup(scope, n.path))));
        break;
      case 'raw':
        out.push(textOf(lookup(scope, n.path)));
        break;
      case 'if': {
        const v = truthy(lookup(scope, n.path));
        const branch = v !== n.not ? n.then : n.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for': {
        const xs = lookup(scope, n.path);
        if (!Array.isArray(xs)) break;
        for (let k = 0; k < xs.length; k++) {
          const vars = { [n.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } };
          renderNodes(n.body, { vars, parent: scope }, ctx, depth, out);
        }
        break;
      }
      case 'include': {
        const t = ctx.templates.get(n.name);
        if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
        break;
      }
    }
  }
}

// ---------------------------------------------------------------- the build

const RESERVED = ['posts', 'tags', 'page'];

/** The words of a body: its runs of characters other than whitespace. */
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let k = 0; k < text.length; k++) {
    const c = text.charCodeAt(k);
    const ws = c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12;
    if (ws) inWord = false;
    else if (!inWord) {
      inWord = true;
      count++;
    }
  }
  return count;
}

/** Whether `target` opens with a scheme (`https:`, `mailto:` ...). */
function hasScheme(target) {
  const c0 = target.charCodeAt(0);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return false;
  for (let k = 1; k < target.length; k++) {
    const c = target.charCodeAt(k);
    if (c === 58) return true;
    if (!((c >= 65 && c <= 90) || (c >= 97 && c <= 122) || (c >= 48 && c <= 57) || c === 43 || c === 45 || c === 46)) return false;
  }
  return false;
}

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
  if (
    rel.indexOf('..') === -1 && rel.indexOf('//') === -1 && rel !== '.' &&
    !rel.startsWith('./') && !rel.endsWith('/.') && rel.indexOf('/./') === -1 &&
    dir.indexOf('//') === -1 && dir !== '.' && !dir.startsWith('./') && !dir.endsWith('/.') && dir.indexOf('/./') === -1
  ) {
    return dir === '' ? rel : `${dir}/${rel}`;
  }
  const parts = dir === '' ? [] : dir.split('/');
  for (const seg of rel.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

/** One site's output tree: path -> text. */
export function run(input) {
  slugCache = new Map();
  dateCache = new Map();

  const templates = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  // Every parsed template compiled once for this build; one that cannot be
  // compiled keeps a wrapper over the tree walk, so includes still render it.
  const ctx = { templates };
  const compiled = new Map();
  for (const [name, nodes] of templates) {
    const fn = compileTemplate(nodes);
    compiled.set(name, fn ?? ((S, out, C, depth) => renderNodes(nodes, S, ctx, depth, out)));
  }
  const C = { t: compiled, esc, txt: textOf, tru: truthy, lk: lookup, lk1, lk2, lk3, ev: escText, tx: textOf };

  const base = input.site.base_url.replace(/\/+$/, '');
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  const sources = [];
  const statics = [];
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.indexOf('\r') === -1 ? f.content : f.content.replace(/\r\n?/g, '\n') });
    else statics.push({ path: f.path, content: f.content });
  }

  // Front matter, in source order; refused sources and drafts are reported and dropped.
  const kept = [];
  for (const s of sources) {
    const fm = parseFrontMatter(s.text);
    if ('error' in fm) {
      report.push(`refused ${s.path}: ${fm.error}`);
      continue;
    }
    s.data = fm.data;
    s.body = fm.body;
    s.post = s.path.startsWith('posts/');
    const own = s.path.startsWith('tags/') ? 'tags' : s.path.startsWith('page/') ? 'page' : undefined;
    if (own !== undefined) {
      report.push(`refused ${s.path}: ${own}/ is the generator's own`);
      continue;
    }
    if (s.post && !Object.hasOwn(s.data, 'date')) {
      report.push(`refused ${s.path}: a post needs a date`);
      continue;
    }
    const layout = s.data.layout ?? (s.post ? 'post' : 'page');
    if (!templates.has(layout)) {
      report.push(`refused ${s.path}: layout "${layout}" is no template that parses`);
      continue;
    }
    s.layout = layout;
    if (s.data.draft === true) {
      report.push(`draft ${s.path}`);
      continue;
    }
    kept.push(s);
  }

  // Permalinks: each page's directory and url, its slug unique in its directory.
  const taken = new Map();
  const bySource = new Map();
  for (const s of kept) {
    const dir = s.post ? 'posts' : dirOf(s.path);
    let set = taken.get(dir);
    if (set === undefined) {
      set = new Set(dir === '' ? RESERVED : []);
      taken.set(dir, set);
    }
    const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), set);
    s.slug = slug;
    s.outDir = dir === '' ? slug : `${dir}/${slug}`;
    s.url = `${base}/${s.outDir}/`;
    bySource.set(s.path, s);
  }

  // Markdown: each body's HTML, its links resolved.
  const staticPaths = new Set(statics.map((f) => f.path));
  const broken = new Set();
  for (const s of kept) {
    const dir = dirOf(s.path);
    const env = {
      link: (target) => {
        if (hasScheme(target) || target.startsWith('/') || target.startsWith('#')) return target;
        const hash = target.indexOf('#');
        const rel = hash === -1 ? target : target.slice(0, hash);
        const frag = hash === -1 ? '' : target.slice(hash);
        const path = rel === '' ? null : resolvePath(dir, rel);
        if (path !== null && bySource.has(path)) return `${bySource.get(path).url}${frag}`;
        if (path !== null && staticPaths.has(path)) return `${base}/${path}${frag}`;
        broken.add(`broken-link ${s.path} -> ${target}`);
        return target;
      },
    };
    const md = renderMarkdown(s.body, env);
    s.html = md.html;
    s.toc = md.toc;
    s.excerpt = md.excerpt;
  }

  // Collections: the posts, newest date first, then by slug; newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // Tags: grouped by slug, each named as first met in the posts' order.
  const bySlug = new Map();
  const ownTags = (s) => {
    const seen = new Set();
    const out = [];
    for (const name of s.data.tags ?? []) {
      const slug = slugify(name);
      if (!seen.has(slug)) {
        seen.add(slug);
        out.push(name);
      }
    }
    return out;
  };
  for (const p of posts) {
    p.tagRefs = [];
    for (const name of ownTags(p)) {
      const slug = slugify(name);
      let tag = bySlug.get(slug);
      if (tag === undefined) {
        tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] };
        bySlug.set(slug, tag);
      }
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) {
    if (!s.post) {
      s.tagRefs = ownTags(s).map((name) => {
        const slug = slugify(name);
        return bySlug.get(slug) ?? { name, slug, url: '', posts: [] };
      });
    }
  }
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // Cards, built once per page and reused by every layout that shows it.
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const cardOf = (s) => {
    if (s.card !== undefined) return s.card;
    const card = {
      title: s.data.title,
      url: s.url,
      date: s.data.date ?? '',
      date_long: s.data.date === undefined ? '' : longDate(s.data.date),
      summary: s.data.summary ?? '',
      excerpt: s.excerpt,
      reading_minutes: Math.max(1, Math.ceil(wordsOf(s.body) / 200)),
      tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
    };
    s.card = card;
    return card;
  };
  const cards = new Map(posts.map((p) => [p, cardOf(p)]));
  const tagOf = (t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cards.get(p)) });
  const pageOf = (s) => {
    const card = cardOf(s);
    return {
      title: card.title,
      url: card.url,
      date: card.date,
      date_long: card.date_long,
      summary: card.summary,
      excerpt: card.excerpt,
      reading_minutes: card.reading_minutes,
      tags: card.tags,
      slug: s.slug,
      content: s.html,
      toc: s.toc,
      newer: linkOf(s.newer ?? null),
      older: linkOf(s.older ?? null),
      is_post: s.post,
    };
  };

  // Layouts: every page through its layout, the index pages and the tag pages.
  const output = {};
  const site = { title: input.site.title, base_url: base };
  const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
  const recent = posts.slice(0, input.site.recent).map((p) => cards.get(p));
  const render = (name, vars) => {
    const fn = compiled.get(name);
    if (fn === undefined) return null;
    const out = [];
    fn({ vars: { site, tags: allTags, recent, ...vars }, parent: null }, out, C, 0);
    return out.join('');
  };
  for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
  const per = input.site.per_page;
  const pages = Math.max(1, Math.ceil(posts.length / per));
  const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
  for (let k = 1; k <= pages; k++) {
    const html = render('index', {
      posts: posts.slice((k - 1) * per, k * per).map((p) => cards.get(p)),
      pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
    });
    if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
  }
  for (const t of tags) {
    const html = render('tag', { tag: tagOf(t) });
    if (html !== null) output[`tags/${t.slug}/index.html`] = html;
  }
  const tagsHtml = render('tags', {});
  if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
  for (const f of statics) {
    if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
    else output[f.path] = f.content;
  }

  // The report: every line reported above and each broken link, sorted, then the counts.
  const lines = [...report, ...broken].sort(byCodeUnits);
  const pageCount = kept.filter((s) => !s.post).length;
  lines.push(`built ${pageCount} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
  output['build-report.txt'] = `${lines.join('\n')}\n`;
  return output;
}
