// A faster drop-in for makefun-site 1.0.0: run(input) returns the same output tree as the reference build, byte for
// byte, for every input. Written from the reference's README and code: the same front matter, Markdown, template and
// slug rules, re-implemented with bulk escaping, memoized slugs, a fused lexer/renderer and an array-accumulating
// template interpreter so the same work costs far less CPU.

// ---------------------------------------------------------------- text

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

const SPECIAL = /[&<>"']/;

/** `text` with & < > " and ' escaped; a text holding none of them is returned as it stands. */
export function escapeHtml(text) {
  if (!SPECIAL.test(text)) return text;
  let out = null;
  let last = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      if (out === null) out = text.slice(0, i);
      else out += text.slice(last, i);
      out += rep;
      last = i + 1;
    }
  }
  return out === null ? text : out + text.slice(last);
}

const SLUG_MAX = 64;
const NON_ASCII = /[^\x00-\x7F]/;
const MARKS = /\p{M}/gu;

/** The slug of `text`, unmemoized: NFKD, marks dropped, lowered, runs of other characters one "-", cut at 64. */
function slugifyRaw(text) {
  // Pure ASCII is unchanged by NFKD and holds no combining marks, so both steps are skipped for it.
  const plain = NON_ASCII.test(text) ? text.normalize('NFKD').replace(MARKS, '') : text;
  let out = '';
  let gap = false;
  // An index loop over code units: a non-BMP character is two surrogates, both "other" here, and the boolean
  // gap makes the pair count once, exactly as one code point did.
  for (let i = 0; i < plain.length; i++) {
    const c = plain.charCodeAt(i);
    let keep = -1;
    if (c >= 65 && c <= 90) keep = c + 32;
    else if ((c >= 97 && c <= 122) || (c >= 48 && c <= 57)) keep = c;
    if (keep === -1) {
      gap = out.length > 0;
      continue;
    }
    if (gap) out += '-';
    gap = false;
    out += String.fromCharCode(keep);
  }
  out = out.slice(0, SLUG_MAX).replace(/-+$/, '');
  return out === '' ? 'untitled' : out;
}

/** Slugs repeat heavily across one site (titles, tags, headings), so each build memoizes them. */
let slugCache = new Map();
export function slugify(text) {
  let r = slugCache.get(text);
  if (r === undefined) {
    r = slugifyRaw(text);
    slugCache.set(text, r);
  }
  return r;
}

/** `slug` made unique against `taken` (and added to it): the first of slug, slug-2, slug-3 ... not taken. */
export function uniqueSlug(slug, taken) {
  let out = slug;
  for (let n = 2; taken.has(out); n++) out = `${slug}-${n}`;
  taken.add(out);
  return out;
}

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** A YYYY-MM-DD date in words, from the string alone. */
export function longDate(date) {
  const [y, m, d] = date.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1]} ${y}`;
}

/** Whether a code unit is whitespace to JavaScript's \s. */
function isWsCode(c) {
  if (c === 32 || (c >= 9 && c <= 13)) return true;
  if (c < 0xa0) return false; // no whitespace between \r and \xa0
  return (
    c === 0xa0 ||
    c === 0x1680 ||
    (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 ||
    c === 0x2029 ||
    c === 0x202f ||
    c === 0x205f ||
    c === 0x3000 ||
    c === 0xfeff
  );
}

/** The words of a body: its runs of characters other than whitespace, counted without building them. */
function wordsOf(text) {
  let n = 0;
  let inWord = false;
  for (let i = 0; i < text.length; i++) {
    if (isWsCode(text.charCodeAt(i))) inWord = false;
    else if (!inWord) {
      inWord = true;
      n++;
    }
  }
  return n;
}

// ---------------------------------------------------------------- front matter

/** The keys a source's front matter may give. */
const FM_KEYS = Object.freeze(['title', 'date', 'tags', 'draft', 'layout', 'slug', 'summary']);
const FM_LINE = /^([a-z_]+):(?: (.*))?$/;
const FM_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const FM_NAME = /^[a-z0-9-]+$/;
const FM_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const FM_TAG = /^[^"[\]]+$/;

/** The days of month `m` (1-12) of year `y`, by the Gregorian rule. */
function daysIn(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

/** A string value: "..." with \" and \\ its only escapes, or bare, the rest of the line (never opening on " or [). */
function fmStringOf(raw) {
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

/** One key's value, or why it is refused. */
function fmValueOf(key, raw) {
  switch (key) {
    case 'title':
    case 'summary': {
      const s = fmStringOf(raw);
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
      if (!raw.startsWith('[') || !raw.endsWith(']')) return { error: 'key "tags": not a list [a, b]' };
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

const FM_BLANK = /^[ \t]*$/;

/**
 * A source's front matter and body: { data, body }, or { error } with the first reason it is refused. `text` has
 * "\n" line ends. The closing line is found before any line is judged, as in the reference; the body is sliced out
 * by offset rather than re-joined.
 */
export function parseFrontMatter(text) {
  // The first line must be exactly "---": the text is "---" or opens "---\n".
  if (!text.startsWith('---') || (text.length > 3 && text.charCodeAt(3) !== 10)) return { error: 'no front matter' };
  // The closing line is the first later line that is exactly "---"; find it by offset, without splitting the body.
  let closeStart = -1;
  let closeEnd = -1;
  for (let pos = 4; pos <= text.length; ) {
    let end = text.indexOf('\n', pos);
    if (end === -1) end = text.length;
    if (end - pos === 3 && text.startsWith('---', pos)) {
      closeStart = pos;
      closeEnd = end;
      break;
    }
    if (end === text.length) break;
    pos = end + 1;
  }
  if (closeStart === -1) return { error: 'the front matter is not closed' };
  const head = closeStart === 4 ? [] : text.slice(4, closeStart - 1).split('\n');
  const data = {};
  for (let j = 0; j < head.length; j++) {
    const line = head[j];
    if (FM_BLANK.test(line) || line.startsWith('#')) continue;
    const m = FM_LINE.exec(line);
    if (!m) return { error: `line ${j + 2} is not "key: value"` };
    const key = m[1];
    const raw = (m[2] ?? '').replace(/[ \t]+$/, '');
    if (!FM_KEYS.includes(key)) return { error: `unknown key "${key}"` };
    if (Object.hasOwn(data, key)) return { error: `key "${key}" is given twice` };
    if (raw === '') return { error: `key "${key}" has no value` };
    const v = fmValueOf(key, raw);
    if ('error' in v) return v;
    data[key] = v.value;
  }
  if (!Object.hasOwn(data, 'title')) return { error: 'no title' };
  return { data, body: text.slice(closeEnd + 1) };
}

// ---------------------------------------------------------------- markdown

const FENCE_OPEN = /^```([A-Za-z0-9_+-]*)[ \t]*$/;
const FENCE_CLOSE = /^```[ \t]*$/;
const HEADING = /^(#{1,6})[ \t]+(.*?)[ \t]*$/;
const HR = /^(?:---|\*\*\*)[ \t]*$/;
const BULLET = /^[-*] (.*)$/;
const ORDERED = /^(\d{1,9})\. (.*)$/;

/** Whether `line` is blank: nothing but spaces and tabs. */
function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const c = line.charCodeAt(i);
    if (c !== 32 && c !== 9) return false;
  }
  return true;
}

/** `line` with spaces and tabs at either end dropped. */
function trimLine(line) {
  let a = 0;
  let b = line.length;
  while (a < b) {
    const c = line.charCodeAt(a);
    if (c !== 32 && c !== 9) break;
    a++;
  }
  while (b > a) {
    const c = line.charCodeAt(b - 1);
    if (c !== 32 && c !== 9) break;
    b--;
  }
  return a === 0 && b === line.length ? line : line.slice(a, b);
}

/** A heading line's level and text, or null (a heading's text is never empty). */
function headingOf(line) {
  const m = HEADING.exec(line);
  return m === null || m[2] === '' ? null : { depth: m[1].length, text: m[2] };
}

/** Whether `line` ends a paragraph: a blank line, a fence, a heading or a thematic break. */
function endsParagraph(line) {
  if (isBlank(line)) return true;
  if (line.startsWith('```') && FENCE_OPEN.test(line)) return true;
  if (line.charCodeAt(0) === 35 && headingOf(line) !== null) return true;
  if ((line.startsWith('---') || line.startsWith('***')) && HR.test(line)) return true;
  return false;
}

/** Whether `line` continues a list item: two or more spaces then a non-space. */
function isContinued(line) {
  let j = 0;
  while (j < line.length && line.charCodeAt(j) === 32) j++;
  return j >= 2 && j < line.length && !isWsCode(line.charCodeAt(j));
}

/** The characters a backslash escapes. */
const ESCAPABLE = new Set(['\\', '`', '*', '_', '[', ']', '(', ')', '#', '+', '-', '.', '!', '>']);

/** The first index from `from` where `s` holds `what` outside a backslash escape, or -1. */
function findUnescaped(s, what, from) {
  for (let j = from; j <= s.length - what.length; j++) {
    if (s[j] === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (s.startsWith(what, j)) return j;
  }
  return -1;
}

/** The first single * from `from` (one whose run is not **), outside an escape, or -1. */
function findSingleStar(s, from) {
  for (let j = from; j < s.length; j++) {
    const c = s[j];
    if (c === '\\' && j + 1 < s.length && ESCAPABLE.has(s[j + 1])) {
      j++;
      continue;
    }
    if (c !== '*') continue;
    if (s[j + 1] === '*') {
      j++;
      continue;
    }
    return j;
  }
  return -1;
}

/**
 * `s` rendered inline; `env.link(target)` is a link's href. Plain runs between constructs are escaped in bulk
 * rather than character by character; a construct that fails leaves its characters in the run, where escaping
 * them gives the same text the reference writes one by one.
 */
const INTERESTING = /[\\`*[]/g;

export function inline(s, env) {
  let out = '';
  let i = 0;
  let run = 0;
  const n = s.length;
  while (i < n) {
    // Jump straight to the next character that can open a construct; everything before it is plain run.
    INTERESTING.lastIndex = i;
    const hit = INTERESTING.exec(s);
    if (hit === null) break;
    i = hit.index;
    const c = s[i];
    if (c === '\\') {
      if (i + 1 < n && ESCAPABLE.has(s[i + 1])) {
        if (i > run) out += escapeHtml(s.slice(run, i));
        out += escapeHtml(s[i + 1]);
        i += 2;
        run = i;
      } else i++;
      continue;
    }
    if (c === '`') {
      const j = s.indexOf('`', i + 1);
      if (j > i + 1) {
        if (i > run) out += escapeHtml(s.slice(run, i));
        out += `<code>${escapeHtml(s.slice(i + 1, j))}</code>`;
        i = j + 1;
        run = i;
      } else i++;
      continue;
    }
    if (c === '*') {
      if (s[i + 1] === '*') {
        const j = findUnescaped(s, '**', i + 2);
        if (j > i + 2) {
          if (i > run) out += escapeHtml(s.slice(run, i));
          out += `<strong>${inline(s.slice(i + 2, j), env)}</strong>`;
          i = j + 2;
          run = i;
        } else i += 2;
      } else {
        const j = findSingleStar(s, i + 1);
        if (j > i + 1) {
          if (i > run) out += escapeHtml(s.slice(run, i));
          out += `<em>${inline(s.slice(i + 1, j), env)}</em>`;
          i = j + 1;
          run = i;
        } else i++;
      }
      continue;
    }
    if (c === '[') {
      const k = findUnescaped(s, ']', i + 1);
      const m = k !== -1 && s[k + 1] === '(' ? s.indexOf(')', k + 2) : -1;
      const target = m === -1 ? '' : s.slice(k + 2, m);
      if (target !== '' && !/\s/.test(target)) {
        if (i > run) out += escapeHtml(s.slice(run, i));
        out += `<a href="${escapeHtml(env.link(target))}">${inline(s.slice(i + 1, k), env)}</a>`;
        i = m + 1;
        run = i;
      } else i++;
      continue;
    }
    i++;
  }
  if (n > run) out += escapeHtml(s.slice(run, n));
  return out;
}

/**
 * `src` rendered in one pass over its lines (the reference lexes, then renders; the blocks, their order and their
 * text are the same): its HTML, its table of contents and its excerpt.
 */
export function renderMarkdown(src, env) {
  const lines = src.split('\n');
  const ids = new Set();
  const blocks = [];
  const toc = [];
  let excerpt = null;
  let i = 0;
  const n = lines.length;
  while (i < n) {
    const line = lines[i];
    if (isBlank(line)) {
      i++;
      continue;
    }
    const c0 = line.charCodeAt(0);
    if (c0 === 96 && line.startsWith('```')) {
      const fence = FENCE_OPEN.exec(line);
      if (fence !== null) {
        const body = [];
        i++;
        while (i < n && !(lines[i].startsWith('```') && FENCE_CLOSE.test(lines[i]))) body.push(lines[i++]);
        i++;
        const cls = fence[1] === '' ? '' : ` class="language-${escapeHtml(fence[1])}"`;
        const inner = body.length === 0 ? '' : `${escapeHtml(body.join('\n'))}\n`;
        blocks.push(`<pre><code${cls}>${inner}</code></pre>`);
        continue;
      }
    }
    const heading = c0 === 35 ? headingOf(line) : null;
    if (heading !== null) {
      const id = uniqueSlug(slugify(heading.text), ids);
      const html = inline(heading.text, env);
      blocks.push(`<h${heading.depth} id="${id}">${html}</h${heading.depth}>`);
      if (heading.depth === 2 || heading.depth === 3) toc.push({ level: heading.depth, id, html });
      i++;
      continue;
    }
    if ((line.startsWith('---') || line.startsWith('***')) && HR.test(line)) {
      blocks.push('<hr>');
      i++;
      continue;
    }
    if (c0 === 62) {
      const kept = [];
      while (i < n && lines[i].charCodeAt(0) === 62) {
        let s = lines[i].slice(1);
        if (s.charCodeAt(0) === 32) s = s.slice(1);
        const t = trimLine(s);
        if (t !== '') kept.push(t);
        i++;
      }
      blocks.push(kept.length === 0 ? '<blockquote>\n</blockquote>' : `<blockquote>\n<p>${inline(kept.join('\n'), env)}</p>\n</blockquote>`);
      continue;
    }
    let bullet = null;
    let ordered = null;
    if ((c0 === 45 || c0 === 42) && line.charCodeAt(1) === 32) bullet = BULLET.exec(line);
    else if (c0 >= 48 && c0 <= 57) ordered = ORDERED.exec(line);
    if (bullet !== null || ordered !== null) {
      const isOrdered = ordered !== null;
      const marker = isOrdered ? ORDERED : BULLET;
      const items = [];
      while (i < n) {
        const m = marker.exec(lines[i]);
        if (m !== null) {
          items.push([trimLine(isOrdered ? m[2] : m[1])]);
          i++;
        } else if (isContinued(lines[i])) {
          items[items.length - 1].push(trimLine(lines[i]));
          i++;
        } else break;
      }
      const tag = isOrdered ? 'ol' : 'ul';
      const open = isOrdered && Number(ordered[1]) !== 1 ? `<ol start="${Number(ordered[1])}">` : `<${tag}>`;
      let block = `${open}\n`;
      for (const parts of items) block += `<li>${inline(parts.join('\n'), env)}</li>\n`;
      blocks.push(`${block}</${tag}>`);
      continue;
    }
    const body = [trimLine(line)];
    i++;
    while (i < n && !endsParagraph(lines[i])) body.push(trimLine(lines[i++]));
    const html = inline(body.join('\n'), env);
    if (excerpt === null) excerpt = html;
    blocks.push(`<p>${html}</p>`);
  }
  return { html: blocks.length === 0 ? '' : `${blocks.join('\n')}\n`, toc, excerpt: excerpt ?? '' };
}

// ---------------------------------------------------------------- templates

/** The deepest an include nests: one past it renders nothing. */
const INCLUDE_DEPTH = 8;

const TPL_PATH = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/;
const TPL_FOR = /^for ([A-Za-z_][A-Za-z0-9_]*) in (\S+)$/;
const TPL_IF = /^if (not )?(\S+)$/;
const TPL_INCLUDE = /^include "([a-z0-9-]+)"$/;

/** A template that does not parse: its name and why. */
class TemplateError extends Error {}

/** The path `text` names, split at its dots, or a TemplateError. */
function tplPathOf(name, text) {
  if (!TPL_PATH.test(text)) throw new TemplateError(`template "${name}": ${JSON.stringify(text)} is not a path`);
  return text.split('.');
}

/** `src`'s tokens: text, {{ }}, {{{ }}} and {% %}, a standalone tag's line taken with it. */
function tplTokenize(name, src) {
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
      tokens.push({ t: raw ? 'raw' : 'var', path: tplPathOf(name, src.slice(open + (raw ? 3 : 2), close).trim()) });
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
export function parseTemplate(name, src) {
  const root = { kind: 'root', body: [] };
  const stack = [root];
  let body = root.body;
  for (const tok of tplTokenize(name, src)) {
    if (tok.t === 'text') body.push({ kind: 'text', text: tok.text });
    else if (tok.t === 'var' || tok.t === 'raw') body.push({ kind: tok.t, path: tok.path });
    else {
      const tag = tok.tag;
      const top = stack[stack.length - 1];
      let m;
      if ((m = TPL_FOR.exec(tag)) !== null) {
        const node = { kind: 'for', name: m[1], path: tplPathOf(name, m[2]), body: [] };
        body.push(node);
        stack.push(node);
        body = node.body;
      } else if ((m = TPL_IF.exec(tag)) !== null) {
        const node = { kind: 'if', not: m[1] !== undefined, path: tplPathOf(name, m[2]), then: [], else: null };
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
      } else if ((m = TPL_INCLUDE.exec(tag)) !== null) body.push({ kind: 'include', name: m[1] });
      else throw new TemplateError(`template "${name}": {% ${tag} %} is not a tag`);
    }
  }
  if (stack.length > 1) throw new TemplateError(`template "${name}": a ${stack[stack.length - 1].kind} is not closed`);
  return root.body;
}

/** The value at `path` in the scope chain: its first name from the nearest scope holding it, then own properties. */
function tplLookup(scope, path) {
  let s = scope;
  while (s !== null && !Object.hasOwn(s.vars, path[0])) s = s.parent;
  if (s === null) return undefined;
  let v = s.vars[path[0]];
  if (path.length === 1) return v;
  if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[1])) return undefined;
  v = v[path[1]];
  for (let k = 2; k < path.length; k++) {
    if (v === null || typeof v !== 'object' || !Object.hasOwn(v, path[k])) return undefined;
    v = v[path[k]];
  }
  return v;
}

/** A value as text: a string itself, a number in JavaScript's digits, true or false, an array's items joined by ", ", else "". */
function tplTextOf(v) {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (Array.isArray(v)) return v.map(tplTextOf).join(', ');
  return '';
}

/** Whether a value counts as true in an if: not undefined, null, false, "", 0 or an empty array. */
function tplTruthy(v) {
  if (Array.isArray(v)) return v.length > 0;
  return v !== undefined && v !== null && v !== false && v !== '' && v !== 0;
}

/**
 * What a node list's rendering depends on: the root names it reads that are not bound inside it (its free
 * roots), and whether it contains an include (whose rendering also depends on the include depth). Includes
 * are followed into the named template; a template that transitively includes itself gives null and is
 * never memoized. Rendering is pure, so two renders of one node whose free roots resolve to the same
 * values give the same text — the shared fragments of a site (nav, header, footer, a post's card) are
 * rendered once per build instead of once per page.
 */
function freeInfoOf(nodes, ctx, visiting) {
  const roots = new Set();
  let inc = false;
  const walk = (list, bound) => {
    for (const nd of list) {
      switch (nd.kind) {
        case 'var':
        case 'raw':
          if (!bound.has(nd.path[0])) roots.add(nd.path[0]);
          break;
        case 'if':
          if (!bound.has(nd.path[0])) roots.add(nd.path[0]);
          if (!walk(nd.then, bound)) return false;
          if (nd.else !== null && !walk(nd.else, bound)) return false;
          break;
        case 'for': {
          if (!bound.has(nd.path[0])) roots.add(nd.path[0]);
          const inner = new Set(bound);
          inner.add(nd.name);
          inner.add('loop');
          if (!walk(nd.body, inner)) return false;
          break;
        }
        case 'include': {
          inc = true;
          const sub = templateFreeInfo(nd.name, ctx, visiting);
          if (sub === null) return false;
          for (const r of sub.roots) if (!bound.has(r)) roots.add(r);
          break;
        }
      }
    }
    return true;
  };
  return walk(nodes, new Set()) ? { roots: [...roots], inc } : null;
}

/** A template's free info, cached on the build's ctx; null when its includes cycle. */
function templateFreeInfo(name, ctx, visiting) {
  if (ctx.freeCache.has(name)) return ctx.freeCache.get(name);
  const nodes = ctx.templates.get(name);
  if (nodes === undefined) return { roots: [], inc: true }; // a missing template renders nothing, at any scope
  if (visiting.has(name)) return null;
  visiting.add(name);
  const info = freeInfoOf(nodes, ctx, visiting);
  visiting.delete(name);
  const out = info === null ? null : { roots: info.roots, inc: true };
  ctx.freeCache.set(name, out);
  return out;
}

/** A node's free info, cached per build; null when it must not be memoized. */
function nodeFreeInfo(nd, ctx) {
  let info = ctx.nodeInfo.get(nd);
  if (info === undefined) {
    info = freeInfoOf([nd], ctx, new Set());
    ctx.nodeInfo.set(nd, info);
  }
  return info;
}

/** The memo key of `info` in `scope`: each free root's resolved value, objects by build-local identity. */
function memoKeyOf(info, scope, ctx, depth) {
  let key = info.inc ? `@${depth}|` : '';
  for (const root of info.roots) {
    const v = tplLookup(scope, [root]);
    if (v === undefined) key += 'u|';
    else if (v === null) key += 'n|';
    else if (typeof v === 'object') {
      let id = ctx.ids.get(v);
      if (id === undefined) {
        id = ctx.nextId++;
        ctx.ids.set(v, id);
      }
      key += `#${id}|`;
    } else key += `${JSON.stringify(v)}|`;
  }
  return key;
}

/** `renderFn` into `out`, or the memoized text of an earlier identical render of this node in this build. */
function renderMemoized(nd, info, scope, ctx, depth, out, renderFn) {
  if (info === null || info.roots.length > 8) {
    renderFn(out);
    return;
  }
  const key = memoKeyOf(info, scope, ctx, depth);
  let byNode = ctx.memo.get(nd);
  if (byNode !== undefined) {
    const hit = byNode.get(key);
    if (hit !== undefined) {
      out.push(hit);
      return;
    }
  }
  const sub = [];
  renderFn(sub);
  const text = sub.join('');
  if (byNode === undefined) {
    byNode = new Map();
    ctx.memo.set(nd, byNode);
  }
  byNode.set(key, text);
  out.push(text);
}

/** One for node rendered into `out` (its items in fresh child scopes). */
function renderFor(nd, scope, ctx, depth, out) {
  const xs = tplLookup(scope, nd.path);
  if (!Array.isArray(xs)) return;
  const len = xs.length;
  for (let k = 0; k < len; k++) {
    const vars = { [nd.name]: xs[k], loop: { index: k + 1, first: k === 0, last: k === len - 1, length: len } };
    renderNodes(nd.body, { vars, parent: scope }, ctx, depth, out);
  }
}

/** One include node rendered into `out` (nothing past the depth cap, or for a template that did not parse). */
function renderInclude(nd, scope, ctx, depth, out) {
  const t = ctx.templates.get(nd.name);
  if (t !== undefined && depth < INCLUDE_DEPTH) renderNodes(t, scope, ctx, depth + 1, out);
}

/** `nodes` rendered into the `out` array, in `scope`; `ctx` holds the parsed templates and the HTML escape. */
function renderNodes(nodes, scope, ctx, depth, out) {
  for (let idx = 0; idx < nodes.length; idx++) {
    const nd = nodes[idx];
    switch (nd.kind) {
      case 'text':
        out.push(nd.text);
        break;
      case 'var':
        out.push(ctx.escape(tplTextOf(tplLookup(scope, nd.path))));
        break;
      case 'raw':
        out.push(tplTextOf(tplLookup(scope, nd.path)));
        break;
      case 'if': {
        const v = tplTruthy(tplLookup(scope, nd.path));
        const branch = v !== nd.not ? nd.then : nd.else;
        if (branch !== null) renderNodes(branch, scope, ctx, depth, out);
        break;
      }
      case 'for':
        renderMemoized(nd, nodeFreeInfo(nd, ctx), scope, ctx, depth, out, (o) => renderFor(nd, scope, ctx, depth, o));
        break;
      case 'include':
        renderMemoized(nd, templateFreeInfo(nd.name, ctx, new Set()), scope, ctx, depth, out, (o) => renderInclude(nd, scope, ctx, depth, o));
        break;
    }
  }
}

// ---------------------------------------------------------------- the build

const REPORT_FILE = 'build-report.txt';
const RESERVED = Object.freeze(['posts', 'tags', 'page']);

/** Code-unit order (never the locale's). */
const byCodeUnits = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

/** `rel` (a link's path, "/"-separated) from the directory `dir` of a source, or null when it climbs out of the root. */
function resolvePath(dir, rel) {
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

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** A source's tags as { name, slug } pairs, each slug once, in its own order. */
function ownTags(s) {
  const seen = new Set();
  const out = [];
  for (const name of s.data.tags ?? []) {
    const slug = slugify(name);
    if (!seen.has(slug)) {
      seen.add(slug);
      out.push({ name, slug });
    }
  }
  return out;
}

/** A page's link record as templates read it. */
const linkOf = (s) => (s === null ? null : { title: s.data.title, url: s.url, date: s.data.date ?? '', date_long: s.data.date === undefined ? '' : longDate(s.data.date) });

/** A post's card, as lists show it; computed once per source and kept on it. */
function cardOf(s) {
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
}

/** A page as its layout reads it. */
function pageOf(s) {
  return {
    ...cardOf(s),
    slug: s.slug,
    content: s.html,
    toc: s.toc.map((h) => ({ level: h.level, id: h.id, html: h.html })),
    newer: linkOf(s.newer ?? null),
    older: linkOf(s.older ?? null),
    is_post: s.post,
  };
}

/** One site's output tree: path -> text. The reference's pipeline, stage for stage. */
export function build(input) {
  slugCache = new Map();
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
  const base = input.site.base_url.replace(/\/+$/, '');

  // 1. The sources, in code-unit order of their paths, line ends made "\n"; a source that is not .md is static.
  const sources = [];
  const statics = [];
  const files = [...input.files].sort((x, y) => byCodeUnits(x.path, y.path));
  for (const f of files) {
    if (f.path.endsWith('.md')) sources.push({ path: f.path, text: f.content.includes('\r') ? f.content.replace(/\r\n?/g, '\n') : f.content });
    else statics.push({ path: f.path, content: f.content });
  }

  // 2. Each source's front matter: a refused source is reported and dropped, and so is a draft.
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
    const own = RESERVED.find((d) => d !== 'posts' && s.path.startsWith(`${d}/`));
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

  // 3. Each page's output directory and url: its slug made unique in its directory, in source order.
  const bySource = new Map();
  {
    const taken = new Map();
    const takenIn = (dir) => {
      if (!taken.has(dir)) taken.set(dir, new Set(dir === '' ? RESERVED : []));
      return taken.get(dir);
    };
    for (const s of kept) {
      const dir = s.post ? 'posts' : dirOf(s.path);
      const slug = uniqueSlug(s.data.slug ?? slugify(s.data.title), takenIn(dir));
      s.slug = slug;
      s.outDir = dir === '' ? slug : `${dir}/${slug}`;
      s.url = `${base}/${s.outDir}/`;
      bySource.set(s.path, s);
    }
  }

  // 4. Each body's Markdown, its links resolved to the pages and static files they name.
  const broken = new Set();
  {
    const staticPaths = new Set(statics.map((f) => f.path));
    // A (directory, relative path) pair resolves once per build: the pages and static files it can name are
    // fixed before any body is rendered. The value cached is the URL the pair resolves to, or null (broken).
    const linkCache = new Map();
    for (const s of kept) {
      const dir = dirOf(s.path);
      const env = {
        link: (target) => {
          if (SCHEME.test(target) || target.startsWith('/') || target.startsWith('#')) return target;
          const hash = target.indexOf('#');
          const rel = hash === -1 ? target : target.slice(0, hash);
          const frag = hash === -1 ? '' : target.slice(hash);
          const key = `${dir}\0${rel}`;
          let hit = linkCache.get(key);
          if (hit === undefined) {
            const path = rel === '' ? null : resolvePath(dir, rel);
            hit = path !== null && bySource.has(path) ? bySource.get(path).url : path !== null && staticPaths.has(path) ? `${base}/${path}` : null;
            linkCache.set(key, hit);
          }
          if (hit !== null) return `${hit}${frag}`;
          broken.add(`broken-link ${s.path} -> ${target}`);
          return target;
        },
      };
      const md = renderMarkdown(s.body, env);
      s.html = md.html;
      s.toc = md.toc;
      s.excerpt = md.excerpt;
    }
  }

  // 5. The posts, newest first and then by slug; each post's newer and older neighbours.
  const posts = kept.filter((s) => s.post);
  posts.sort((x, y) => byCodeUnits(y.data.date, x.data.date) || byCodeUnits(x.slug, y.slug));
  posts.forEach((p, k) => {
    p.newer = k === 0 ? null : posts[k - 1];
    p.older = k === posts.length - 1 ? null : posts[k + 1];
  });

  // 6. The tags: grouped by their slug, each named as first met in the posts' order, ordered by count and then slug.
  const bySlug = new Map();
  for (const p of posts) {
    p.tagRefs = [];
    for (const { name, slug } of ownTags(p)) {
      if (!bySlug.has(slug)) bySlug.set(slug, { name, slug, url: `${base}/tags/${slug}/`, posts: [] });
      const tag = bySlug.get(slug);
      tag.posts.push(p);
      p.tagRefs.push(tag);
    }
  }
  for (const s of kept) if (!s.post) s.tagRefs = ownTags(s).map(({ name, slug }) => bySlug.get(slug) ?? { name, slug, url: '', posts: [] });
  const tags = [...bySlug.values()].sort((x, y) => y.posts.length - x.posts.length || byCodeUnits(x.slug, y.slug));

  // 7. Every page through its layout, the index pages and the tag pages through theirs.
  const output = {};
  {
    const site = { title: input.site.title, base_url: base };
    const allTags = tags.map((t) => ({ name: t.name, slug: t.slug, url: t.url, count: t.posts.length }));
    const recent = posts.slice(0, input.site.recent).map((p) => cardOf(p));
    const ctx = { templates, escape: escapeHtml, memo: new Map(), ids: new WeakMap(), nextId: 1, freeCache: new Map(), nodeInfo: new WeakMap() };
    // site, tags and recent sit in one shared base scope under every render's own scope, instead of being
    // spread into a fresh object per page; the chain gives the same lookups (no render binds those names).
    const baseScope = { vars: { site, tags: allTags, recent }, parent: null };
    const render = (name, vars) => {
      const nodes = templates.get(name);
      if (nodes === undefined) return null;
      const out = [];
      renderNodes(nodes, { vars, parent: baseScope }, ctx, 0, out);
      return out.join('');
    };
    for (const s of kept) output[`${s.outDir}/index.html`] = render(s.layout, { page: pageOf(s) });
    const per = input.site.per_page;
    const pages = Math.max(1, Math.ceil(posts.length / per));
    const indexUrl = (k) => (k === 1 ? `${base}/` : `${base}/page/${k}/`);
    for (let k = 1; k <= pages; k++) {
      const html = render('index', {
        posts: posts.slice((k - 1) * per, k * per).map((p) => cardOf(p)),
        pager: { number: k, total: pages, url: indexUrl(k), newer_url: k === 1 ? '' : indexUrl(k - 1), older_url: k === pages ? '' : indexUrl(k + 1) },
      });
      if (html !== null) output[k === 1 ? 'index.html' : `page/${k}/index.html`] = html;
    }
    for (const t of tags) {
      const html = render('tag', { tag: { name: t.name, slug: t.slug, url: t.url, count: t.posts.length, posts: t.posts.map((p) => cardOf(p)) } });
      if (html !== null) output[`tags/${t.slug}/index.html`] = html;
    }
    const tagsHtml = render('tags', {});
    if (tagsHtml !== null) output['tags/index.html'] = tagsHtml;
    for (const f of statics) {
      if (Object.hasOwn(output, f.path)) report.push(`shadowed ${f.path}: a built page has its path`);
      else output[f.path] = f.content;
    }
  }

  // 8. The report: every refusal, draft, broken link and template that did not parse, sorted, then the counts.
  {
    const lines = [...report, ...broken].sort(byCodeUnits);
    const pages = kept.filter((s) => !s.post).length;
    lines.push(`built ${pages} pages, ${posts.length} posts, ${tags.length} tags and ${statics.length} static files`);
    output[REPORT_FILE] = `${lines.join('\n')}\n`;
  }
  return output;
}

/** makefun-site 1.0.0's answer for one case's input, faster. */
export function run(input) {
  return build(input);
}
