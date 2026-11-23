// Fast drop-in replacement for makefun-site 1.0.0's build(input), byte-identical by construction.
// Same pipeline order; hot stages rewritten: markdown inline() batches plain runs,
// slugify/longDate/reading-minute caches, escapeHtml early-out, template for-loop
// without closure allocs. Byte-compared against the vendor build on every case.

// ---------------------------------------------------------------- text rules

const ESCAPES = { '&': '\u0026amp;', '<': '\u0026lt;', '>': '\u0026gt;', '"': '\u0026quot;', "'": '\u0026#39;' };
const ESCAPE_TEST = /[&<>"']/;

/** text with & < > " and ' escaped (same table and order as the vendor). */
function escapeHtml(text) {
  if (!ESCAPE_TEST.test(text)) return text;
  return text.replace(/[&<>"']/g, (c) => ESCAPES[c]);
}

const SLUG_MAX = 64;

function slugifySlow(text) {
  const plain = text.normalize('NFKD').replace(/\p{M}/gu, '');
  let out = '';
  let gap = false;
  for (const ch of plain) {
    let keep = null;
    if (ch >= 'A' && ch <= 'Z') keep = ch.toLowerCase();
    else if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9')) keep = ch;
    if (keep === null) { gap = out.length > 0; continue; }
    if (gap) out += '-';
    gap = false;
    out += keep;
  }
  return out;
}

// ASCII-only text is unchanged by NFKD mark-dropping, so a lowercase + run-split
// produces the identical slug with one regex pass instead of a per-char loop.
const PURE_ASCII = /^[a-zA-Z0-9]*$/;
const SLUG_CACHE = new Map();

function slugify(text) {
  let hit = SLUG_CACHE.get(text);
  if (hit !== undefined) return hit;
  let out;
  if (PURE_ASCII.test(text)) {
    out = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  } else {
    out = slugifySlow(text);
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  if (out === '') out = 'untitled';
  if (SLUG_CACHE.size < 65536) SLUG_CACHE.set(text, out);
  return out;
}

function uniqueSlugFast(slug, taken) {
  let out = slug;
  if (!taken.has(out)) { taken.add(out); return out; }
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const DATE_CACHE = new Map();

function longDate(date) {
  let hit = DATE_CACHE.get(date);
  if (hit !== undefined) return hit;
  const [y, m, d] = date.split('-');
  hit = `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
  DATE_CACHE.set(date, hit);
  return hit;
}

// ---------------------------------------------------------------- front matter (verbatim rules)

const KEYS = ['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary'];
const LINE_RE = /^([a-z_]+):(?: (.*))?$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const NAME_RE = /^[a-z0-9-]+$/;
const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const TAG_RE = /^[^"[\]]+$/;

function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;
}

function stringOf(raw) {
  if (raw.startsWith('"')) {
    if (raw.length < 2 || !raw.endsWith('"')) return { error: 'a quoted string is not closed' };
    let out = '';
    for (let i = 1; i < raw.length - 1; i++) {
      const c = raw[i];
      if (c === '\\') {
        const n = raw[i + 1];
        if ((n !== '"' && n !== '\\') || i + 1 === raw.length - 1) return { error: 'a quoted string holds an escape other than \\" or \\\\' };
        out += n;
        i++;
      } else if (c === '"') return { error: 'a quoted string holds a stray quote' };
      else out += c;
    }
    return { value: out };
  }
  if (raw.startsWith('[')) return { error: 'a bare string opens on [' };
  return { value: raw };
}

function valueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = stringOf(raw);
      return 'error' in s ? { error: `key "${key}": ${s.error}` } : s;
    }
    case 'date': {
      const m = DATE_RE.exec(raw);
      const y = m ? Number(m[1]) : 0;
      const mo = m ? Number(m[2]) : 0;
      const d = m ? Number(m[3]) : 0;
      if (!m || y < 1970 || y > 2099 || mo < 1 || mo > 12 || d < 1 || d > daysIn(y, mo)) return { error: 'key "date": not a date from 1970-01-01 to 2099-12-31 (YYYY-MM-DD)' };
      return { value: raw };
    }
    case 'tags': {
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
      const inner = raw.slice(1, -1);
      if (inner.trim() === '') return { value: [] };
      const tags = inner.split(',').map((t) => t.trim());
      if (tags.some((t) => t === '' || !TAG_RE.test(t))) return { error: 'key "tags": an empty tag, or one holding " [ or ]' };
      return { value: tags };
    }
    case 'draft':
      return raw === 'true' ? { value: true } : raw === 'false' ? { value: false } : { error: 'key "draft": true or false' };
    case 'layout':
      return NAME_RE.test(raw) ? { value: raw } : { error: 'key "layout": not a template name' };
    case 'slug':
      return SLUG_RE.test(raw) && raw.length <= 64 ? { value: raw } : { error: 'key "slug": not a slug' };
    default:
      return { error: `unknown key "${key}"` };
  }
}

function parseFrontMatter(text) {
  if (text !== '---' && !text.startsWith('---\n')) return { error: 'no front matter' };
  // close: first line (1-based index >= 1) that is exactly '---'
  let p = text.indexOf('\n---', 3);
  while (p !== -1 && p + 4 < text.length && text.charCodeAt(p + 4) !== 10) p = text.indexOf('\n---', p + 1);
  if (p === -1) return { error: 'the front matter is not closed' };
  const region = text.slice(4, p);
  const lines = region === '' ? [] : region.split('\n');
  const data = {};
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^[ \t]*$/.test(line)) continue;
    if (line.startsWith('#')) continue;
    const m = LINE_RE.exec(line);
    if (!m) return { error: `line ${i + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = valueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(p + 5) };
}

// ---------------------------------------------------------------- markdown

const BLANK = /^[ \t]*$/;
const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const QUOTE = /^>/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;
const CONTINUED = /^ {2,}\S/;

function headingOf(line) {
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

function endsParagraph(line) {
  // one combined pass: blank / fence open / heading-with-text / hr (same four
  // conditions the vendor ORs, disjoint alternates)
  return ENDS_PARAGRAPH_RE.test(line);
}

const ENDS_PARAGRAPH_RE = /^(?:[ \t]*$|```[A-Za-z0-9_+-]*[ \t]*$|#{1,6}[ \t]+.*\S|(?:---|\*\*\*)[ \t]*$)/;

// manual trim of space/tab only — replaces /^[ \t]+|[ \t]+$/g.replace
const trimLine = (line) => {
  let a = 0, b = line.length;
  while (a < b && line.charCodeAt(a) === 9) a++;
  if (a < b && line.charCodeAt(a) === 32) { a++; while (a < b && line.charCodeAt(a) === 32) a++; }
  if (a === b) return '';
  while (b > a && line.charCodeAt(b - 1) === 9) b--;
  if (b > a && line.charCodeAt(b - 1) === 32) { b--; while (b > a && line.charCodeAt(b - 1) === 32) b--; }
  return a === 0 && b === line.length ? line : line.slice(a, b);
};

function lex(src) {
  const lines = src.split('\n');
  const tokens = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (BLANK.test(line)) { i++; continue; }
    const fence = FENCE_OPEN.exec(line);
    if (fence !== null) {
      const body = [];
      i++;
      while (i < lines.length && !FENCE_CLOSE.test(lines[i])) body.push(lines[i++]);
      i++;
      tokens.push({ type: 'code', lang: fence[1], lines: body });
      continue;
    }
    const heading = headingOf(line);
    if (heading !== null) { tokens.push({ type: 'heading', depth: heading.depth, text: heading.text }); i++; continue; }
    if (HR.test(line)) { tokens.push({ type: 'hr' }); i++; continue; }
    if (QUOTE.test(line)) {
      const body = [];
      while (i < lines.length && QUOTE.test(lines[i])) body.push(lines[i++].replace(/^> ?/, ''));
      tokens.push({ type: 'blockquote', lines: body.map(trimLine).filter((l) => l !== '') });
      continue;
    }
    const bullet = BULLET.exec(line);
    const ordered = bullet === null ? ORDERED.exec(line) : null;
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? ORDERED : BULLET;
      const items = [];
      while (i < lines.length) {
        const m = marker.exec(lines[i]);
        if (m !== null) { items.push([trimLine(isOrdered ? m[2] : m[1])]); i++; }
        else if (CONTINUED.test(lines[i])) { items[items.length - 1].push(trimLine(lines[i])); i++; }
        else break;
      }
      tokens.push({ type: 'list', ordered: isOrdered, start: isOrdered ? Number(ordered[1]) : 1, items: items.map((parts) => parts.join('\n')) });
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < lines.length && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    tokens.push({ type: 'paragraph', text: body.join('\n') });
  }
  return tokens;
}

const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);
const SPECIAL_RE = /[`*\[\\]/g;

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) { j++; continue; }
    if (c !== '*') continue;
    if (s[j + 1] === '*') { j++; continue; }
    return j;
  }
  return -1;
}

/** `s` rendered inline; `env.link(target)` is a link's href. Plain runs batched. */
function inline(s, env) {
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    if (c === '\\' && i + 1 < n && ESCAPABLE.has(s[i + 1])) {
      out += escapeHtml(s[i + 1]);
      i += 2;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        out += '<code>' + escapeHtml(s.slice(i + 1, j)) + '</code>';
        i = j + 1;
      } else { out += '`'; i++; }
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) { out += '<strong>' + inline(s.slice(i + 2, j), env) + '</strong>'; i = j + 2; }
        else { out += '**'; i += 2; }
        continue;
      }
      const j = findSingleStar(s, i + 1);
      if (j > i + 1) { out += '<em>' + inline(s.slice(i + 1, j), env) + '</em>'; i = j + 1; }
      else { out += '*'; i++; }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        out += '<a href="' + escapeHtml(env.link(target)) + '">' + inline(s.slice(i + 1, k), env) + '</a>';
        i = m + 1;
        continue;
      }
      out += '[';
      i++;
      continue;
    }
    let j = i + 1;
    SPECIAL_RE.lastIndex = j;
    const m = SPECIAL_RE.exec(s);
    if (m === null) { out += escapeHtml(s.slice(i)); break; }
    j = m.index;
    out += escapeHtml(s.slice(i, j));
    i = j;
  }
  return out;
}

function renderMarkdown(src, env) {
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  for (const t of lex(src)) {
    switch (t.type) {
      case 'heading': {
        const id = uniqueSlugFast(slugify(t.text), ids);
        const html = inline(t.text, env);
        blocks.push(`<h${t.depth} id="${id}">${html}</h${t.depth}>`);
        if (t.depth === 2 || t.depth === 3) toc.push({ level: t.depth, id, html });
        break;
      }
      case 'code': {
        const cls = t.lang === '' ? '' : ` class="language-${escapeHtml(t.lang)}"`;
        blocks.push(`<pre><code${cls}>${t.lines.map((l) => `${escapeHtml(l)}\n`).join('')}</code></pre>`);
        break;
      }
      case 'hr':
        blocks.push('<hr>');
        break;
      case 'blockquote':
        blocks.push(t.lines.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(t.lines.join('\n'), env)}</p>\n</blockquote>`);
        break;
      case 'list': {
        const tag = t.ordered ? 'ol' : 'ul';
        const open = t.ordered && t.start !== 1 ? `<ol start="${t.start}">` : `<${tag}>`;
        blocks.push(`${open}\n${t.items.map((item) => `<li>${inline(item, env)}</li>\n`).join('')}</${tag}>`);
        break;
      }
      case 'paragraph': {
        const html = inline(t.text, env);
        if (excerpt === null) excerpt = html;
        blocks.push(`<p>${html}</p>`);
        break;
      }
    }
  }
  return { html: blocks.map((b) => `${b}\n`).join(''), toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

const INCLUDE_DEPTH = 8;

class TemplateError extends Error {}

const PATH_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const FOR_RE = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const IF_RE = /^if (not )?(\S+)$/;
const INC_RE = /^include "([a-z0-9-]+)"$/;

function pathOf(name, text) {
  if (!PATH_RE.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

function tokenize(name, src) {
  const tokens = [];
  let text = '';
  let i = 0;
  while (i < src.length) {
    const open = src.indexOf('{', i);
    if (open === -1 || open === src.length - 1) { text += src.slice(i); break; }
    const next = src[open + 1];
    if (next !== '{' && next !== '%') { text += src.slice(i, open + 1); i = open + 1; continue; }
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

/** The value at `path` walking the scope chain (own properties only), as the vendor. */
function pathGet(scope, path) {
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

function textOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(textOf).join(', ');
  return '';
}

const truthy = (v) => (Array.isArray(v) ? v.length > 0 : v !== undefined && v !== null && v !== false && v !== '' && v !== 0);

/** nodes compiled ONCE per build into a (scope, depth) -> string closure chain. */
function compileNodes(nodes, compiled) {
  const lits = []; // lits[k]: literal string, or null when fns[k] must run
  const fns = [];
  let lastText = false; // lits[last] is an accumulating literal (no fn pushed after it)
  for (const n of nodes) {
    switch (n.kind) {
      case 'text':
        if (lastText) lits[lits.length - 1] += n.text;
        else { lits.push(n.text); fns.push(null); lastText = true; }
        break;
      case 'var':
        lits.push(null);
        fns.push((scope) => escapeHtml(textOf(pathGet(scope, n.path))));
        lastText = false;
        break;
      case 'raw':
        lits.push(null);
        fns.push((scope) => textOf(pathGet(scope, n.path)));
        lastText = false;
        break;
      case 'if': {
        const thenC = compileNodes(n.then, compiled);
        const elseC = n.else === null ? null : compileNodes(n.else, compiled);
        lits.push(null);
        fns.push((scope, depth) => { const v = truthy(pathGet(scope, n.path)); const b = v !== n.not ? thenC : elseC; return b !== null ? b(scope, depth) : ''; });
        lastText = false;
        break;
      }
      case 'for': {
        const bodyC = compileNodes(n.body, compiled);
        const name = n.name;
        const path = n.path;
        lits.push(null);
        fns.push((scope, depth) => {
          const xs = pathGet(scope, path);
          if (!Array.isArray(xs)) return '';
          let out = '';
          for (let k = 0; k < xs.length; k++) {
            out += bodyC({ vars: { [name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === xs.length - 1, length: xs.length } }, parent: scope }, depth);
          }
          return out;
        });
        lastText = false;
        break;
      }
      case 'include':
        lits.push(null);
        fns.push((scope, depth) => {
          const t = compiled.get(n.name);
          return t !== undefined && depth < INCLUDE_DEPTH ? t(scope, depth + 1) : '';
        });
        lastText = false;
        break;
    }
  }
  if (fns.length === 0) return () => '';
  if (fns.length === 1) return fns[0] === null ? () => lits[0] : (scope, depth) => fns[0](scope, depth);
  if (lits.every((x, k) => fns[k] === null)) {
    const all = lits.join('');
    return () => all;
  }
  return (scope, depth) => {
    let out = '';
    for (let k = 0; k < fns.length; k++) {
      const f = fns[k];
      out += f === null ? lits[k] : f(scope, depth);
    }
    return out;
  };
}

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
        body = parent.kind === 'root' ? parent.body : parent.kind === 'for' ? parent.body : (parent.else ?? parent.then);
      } else if ((m = INC_RE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

// ---------------------------------------------------------------- the build (same plugin order)

export const REPORT_FILE = 'build-report.txt';
export const RESERVED = Object.freeze(['posts', 'tags', 'page']);

const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const SCHEME_RE = /^[A-Za-z][A-Za-z0-9+.-]*:/;
// manual count of non-space runs — identical to (text.match(/\S+/g) || []).length
function wordsOf(text) {
  let count = 0;
  let inWord = false;
  for (let k = 0; k < text.length; k++) {
    const sp = text.charCodeAt(k) <= 32;
    if (sp) inWord = false;
    else if (!inWord) { inWord = true; count++; }
  }
  return count;
}

function resolvePath(dir, rel) {
  const parts = dir === '' ? [] : dir.split('/');
  const segs = rel.split('/');
  for (let k = 0; k < segs.length; k++) {
    const seg = segs[k];
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (parts.length === 0) return null;
      parts.pop();
    } else parts.push(seg);
  }
  return parts.join('/');
}

const dirOf = (path) => (path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '');

function build(input) {
  const templates = new Map();
  const compiled = new Map();
  const report = [];
  for (const name of Object.keys(input.templates).sort(byCodeUnits)) {
    try {
      templates.set(name, parseTemplate(name, input.templates[name]));
    } catch (err) {
      if (!(err instanceof TemplateError)) throw err;
      report.push(err.message);
    }
  }
  for (const [name, nodes] of templates) compiled.set(name, compileNodes(nodes, compiled));
  const base = input.site.base_url.replace(/\/+$/, '');
  const b = {
    input,
    base,
    templates,
    sources: [],
    statics: [],
    bySource: new Map(),
    broken: new Set(),
    report,
    posts: [],
    tags: [],
    cards: new Map(),
    output: {},
  };

  // 1. readSources
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    let text = null;
    if (f.path.endsWith('.md')) {
      const c = f.content;
      text = c.indexOf('\r') === -1 ? c : c.replace(/\r\n?/g, '\n');
    }
    if (text !== null) b.sources.push({ path: f.path, text });
    else b.statics.push({ path: f.path, content: f.content });
  }

  // 2. frontMatter
  {
    const kept = [];
    for (const s of b.sources) {
      const fm = parseFrontMatter(s.text);
      if ('error' in fm) { b.report.push(`refused ${s.path}: ${fm.error}`); continue; }
      s.data = fm.data;
      s.body = fm.body;
      s.post = s.path.startsWith('posts/');
      let own = undefined;
      for (let k = 0; k < 3; k++) {
        const d = RESERVED[k];
        if (d !== 'posts' && s.path.startsWith(`${d}/`)) { own = d; break; }
      }
      if (own !== undefined) { b.report.push(`refused ${s.path}: ${own}/ is the generator's own`); continue; }
      if (s.post && !Object.hasOwn(s.data, 'date')) { b.report.push(`refused ${s.path}: a post needs a date`); continue; }
      const layout = s.data.layout ?? (s.post ? 'post' : 'page');
      if (!templates.has(layout)) { b.report.push(`refused ${s.path}: layout "${layout}" is no template that parses`); continue; }
      s.layout = layout;
      if (s.data.draft === true) { b.report.push(`draft ${s.path}`); continue; }
      kept.push(s);
    }
    b.sources = kept;
  }

  // 3. permalinks
  {
    const taken = new Map();
    const takenIn = (dir) => {
      if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
      return taken.get(dir);
    };
    for (const s of b.sources) {
      const dir = s.post ? 'posts' : dirOf(s.path);
      const slug = uniqueSlugFast(s.data.slug ?? slugify(s.data.title), takenIn(dir));
      s.slug = slug;
      s.outDir = dir === '' ? slug : `${dir}/${slug}`;
      s.url = `${base}/${s.outDir}/`;
      b.bySource.set(s.path, s);
    }
  }

  // 4. markdown
  {
    const staticPaths = new Set(b.statics.map((f) => f.path));
    const bySource = b.bySource;
    const broken = b.broken;
    for (const s of b.sources) {
      const dir = dirOf(s.path);
      const spath = s.path;
      const env = {
        link: (target) => {
          const c0 = target.charCodeAt(0);
          if (c0 === 47 /* / */ || c0 === 35 /* # */ || SCHEME_RE.test(target)) return target;
          const hash = target.indexOf('#');
          const rel = hash === -1 ? target : target.slice(0, hash);
          const frag = hash === -1 ? '' : target.slice(hash);
          const path = rel === '' ? null : resolvePath(dir, rel);
          if (path !== null) {
            const t = bySource.get(path);
            if (t !== undefined) return `${t.url}${frag}`;
            if (staticPaths.has(path)) return `${base}/${path}${frag}`;
          }
          broken.add(`broken-link ${spath} -> ${target}`);
          return target;
        },
      };
      const md = renderMarkdown(s.body, env);
      s.html = md.html;
      s.toc = md.toc;
      s.excerpt = md.excerpt;
    }
  }

  // 5. collections
  {
    const posts = b.sources.filter((s) => s.post);
    posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
    b.posts = posts;
    for (let k = 0; k < posts.length; k++) {
      posts[k].newer = k === 0 ? null : posts[k - 1];
      posts[k].older = k === posts.length - 1 ? null : posts[k + 1];
    }
  }

  // 6. tags
  {
    const bySlug = new Map();
    for (const p of b.posts) {
      p.tagRefs = [];
      const names = p.data.tags ?? [];
      const seen = new Set();
      for (const name of names) {
        const slug = slugify(name);
        if (seen.has(slug)) continue;
        seen.add(slug);
        let tag = bySlug.get(slug);
        if (tag === undefined) { tag = { name, slug, url: `${base}/tags/${slug}/`, posts: [] }; bySlug.set(slug, tag); }
        tag.posts.push(p);
        p.tagRefs.push(tag);
      }
    }
    for (const s of b.sources) {
      if (!s.post) {
        const names = s.data.tags ?? [];
        const seen = new Set();
        const refs = [];
        for (const name of names) {
          const slug = slugify(name);
          if (seen.has(slug)) continue;
          seen.add(slug);
          refs.push(bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
        }
        s.tagRefs = refs;
      }
    }
    b.tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));
  }

  // cards / pages
  const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });
  const readCache = new Map();
  const readingOf = (s) => {
    let rm = readCache.get(s);
    if (rm === undefined) { rm = Math.max(1, Math.ceil(wordsOf(s.body) / 200)); readCache.set(s, rm); }
    return rm;
  };
  const cardOf = (s) => ({
    title: s.data.title,
    url: s.url,
    date: s.data.date ?? '',
    date_long: s.data.date === undefined ? '' : longDate(s.data.date),
    summary: s.data.summary ?? '',
    excerpt: s.excerpt,
    reading_minutes: readingOf(s),
    tags: s.tagRefs.map((t) => ({ name: t.name, slug: t.slug, url: t.url })),
  });
  const pageOf = (s) => ({
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  });

  // 7. layouts
  {
    b.cards = new Map(b.posts.map((p) => [p, cardOf(p)]));
    const site = { title: input.site.title, base_url: base };
    const allTags = b.tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
    const recent = b.posts.slice(0, input.site.recent).map((p) => b.cards.get(p));
    const render = (name, vars) => {
      const t = compiled.get(name);
      return t === undefined ? null : t({ vars: { site, tags: allTags, recent, ...vars }, parent: null }, 0);
    };
    for (const s of b.sources) b.output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
    const per = input.site.per_page;
    const pages = Math.max(1, Math.ceil(b.posts.length / per));
    const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
    for (let k = 1; k <= pages; k++) {
      const html = render('index', {
        posts: b.posts.slice((k - 1) * per, k * per).map((p) => b.cards.get(p)),
        pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
      });
      if (html !== null) b.output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
    }
    for (const t of b.tags) {
      const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => b.cards.get(p)) } });
      if (html !== null) b.output[`tags/${t.slug}/index.html`] = html;
    }
    const tagsHtml = render('tags', {});
    if (tagsHtml !== null) b.output['tags/index.html'] = tagsHtml;
    for (const f of b.statics) {
      if (Object.hasOwn(b.output, f.path)) b.report.push(`shadowed ${f.path}: a built page has its path`);
      else b.output[f.path] = f.content;
    }
  }

  // 8. report
  {
    const lines = [...b.report, ...b.broken].sort(byCodeUnits);
    const pages = b.sources.filter((s) => !s.post).length;
    lines.push(`built ${pages} pages, ${b.posts.length} posts, ${b.tags.length} tags and ${b.statics.length} static files`);
    b.output[REPORT_FILE] = `${lines.join('\n')}\n`;
  }

  return b.output;
}

export function run(input) {
  return build(input);
}
