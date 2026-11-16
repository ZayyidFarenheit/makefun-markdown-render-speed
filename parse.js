// A fast Markdown renderer, byte-identical to marked 18.1.3 with default
// options (gfm on, breaks off, pedantic off, async off). Written from
// scratch against the CommonMark 0.31.2 and GFM 0.29 specs, tuned to the
// reference renderer's observable behaviour.
//
// Design: two phases. Block parsing walks the source line by line and
// builds a small node tree (link reference definitions are collected
// first, since they may be defined after their use). Inline parsing then
// renders each block's text with a single left-to-right scan that jumps
// between the characters that can start a construct. Output is built in
// arrays and joined once per block. No per-case state is kept: parse()
// returns for each input what it returns for that input alone.

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const RE_ESC = /[&<>"']/g;
const RE_ESC_NOENC = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const RE_NUMREF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const RE_NUMREF_G = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const RE_WS = /\s+/g;
const RE_PUNCT = /[\p{P}\p{S}]/u;
const RE_PUNCT_G = /[\p{P}\p{S}]/gu;
const RE_ALPHA_NUM = /[\p{L}\p{N}]/u;

// Escape HTML. encode=true escapes every & (used for code spans and
// autolink text); encode=false leaves & alone when it starts a valid
// entity or numeric reference.
function esc(s, encode) {
  return encode ? s.replace(RE_ESC, c => ESC[c]) : s.replace(RE_ESC_NOENC, c => ESC[c] || '&amp;');
}

// Decode numeric character references in a text run. A bare & that does
// not start a valid reference becomes &amp;. Named entities pass through.
function decEnt(s) {
  if (!RE_NUMREF.test(s)) return s;
  return s.replace(RE_NUMREF_G, (m, d, h) => {
    if (d === undefined && h === undefined) return '&amp;';
    const n = d === undefined ? parseInt(h, 16) : parseInt(d, 10);
    if (n === 0 || n > 0x10FFFF || (n >= 0xD800 && n <= 0xDFFF)) return '\uFFFD';
    if (n === 38) return '&amp;';
    return String.fromCodePoint(n);
  });
}

function encHref(s) {
  try { return encodeURI(s).replace(/%25/g, '%'); } catch { return null; }
}

// A link label, normalised for lookup: trim, collapse whitespace, fold case.
function normLabel(s) {
  return s.trim().replace(RE_WS, ' ').toLowerCase().toUpperCase().toLowerCase();
}

// Strip trailing copies of ch from s (L in the reference: t=false strips
// the char itself; t=true strips everything that is not the char).
function stripEnd(s, ch, not) {
  let n = s.length;
  if (!n) return '';
  let k = 0;
  for (; k < n;) {
    const c = s.charAt(n - k - 1);
    if (c === ch && !not) k++;
    else if (c !== ch && not) k++;
    else break;
  }
  return s.slice(0, n - k);
}

// Expand tabs to spaces, tracking the column (tab stops every 4).
function expandTabs(s, col) {
  let out = '', c = col || 0;
  for (const ch of s) {
    if (ch === '\t') { const r = 4 - (c % 4); out += ' '.repeat(r); c += r; }
    else { out += ch; c++; }
  }
  return out;
}

// In s, find the index of the first unmatched ')' (paren depth from 0),
// or -2 when a '(' is left open, -1 when balanced. Backslash escapes skip.
function parenClose(s) {
  if (s.indexOf('(') === -1 && s.indexOf(')') === -1) return -1;
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '(') depth++;
    else if (s[i] === ')') { depth--; if (depth < 0) return i; }
  }
  return depth > 0 ? -2 : -1;
}

// Split a table row on unescaped pipes, trim cells, pad/truncate to count.
function splitRow(row, count) {
  const cells = [];
  let cur = '', i = 0;
  for (; i < row.length; i++) {
    const c = row[i];
    if (c === '\\' && i + 1 < row.length && row[i + 1] === '|') { cur += '|'; i++; continue; }
    if (c === '|') { cells.push(cur); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur);
  if (cells.length && !cells[0].trim()) cells.shift();
  if (cells.length && !cells[cells.length - 1].trim()) cells.pop();
  if (count !== undefined) {
    if (cells.length > count) cells.length = count;
    else while (cells.length < count) cells.push('');
  }
  for (let j = 0; j < cells.length; j++) cells[j] = cells[j].trim().replace(/\\\|/g, '|');
  return cells;
}

const PUNCT_SET = '!\"#$%&\'()*+,-./:;<=>?@[\\]^_`{|}~';
function isPunct(ch) {
  return ch.length === 1 && (PUNCT_SET.indexOf(ch) >= 0 || RE_PUNCT.test(ch));
}
function isAlnum(ch) {
  return ch.length === 1 && RE_ALPHA_NUM.test(ch);
}
// Word characters for the \b test before _: letters, digits and _ itself.
function isWordChar(ch) {
  return ch.length === 1 && (RE_ALPHA_NUM.test(ch) || ch === '_');
}

const EMAIL_LOCAL = /[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]/;
const EMAIL_RE = /^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+/;
const SCHEME_RE = /^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:/;
const URL_BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const TAG_OPEN = /^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*\s*\/?>/;
const TAG_CLOSE = /^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>/;
const TAG_COMMENT = /^<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const TAG_PI = /^<\?[\s\S]*?\?>/;
const TAG_DECL = /^<![a-zA-Z]+\s[\s\S]*?>/;
const TAG_CDATA = /^<!\[CDATA\[[\s\S]*?\]\]>/;

// The block tags that start an HTML block of type 6 (and the open/close
// test for type 1-6 in general).
const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const RE_BLOCK_TAG = new RegExp(`^</?(?:${BLOCK_TAGS})(?:[ \\t]+|$|/?>)`, 'i');
const RE_PRE_TAG = /^<(pre|code|kbd|script)(\s|>)/i;
const RE_PRE_CLOSE = /^<\/(pre|code|kbd|script)(\s|>)/i;

// ---------------------------------------------------------------- inline
// The inline renderer walks a block's text left to right. At each position
// it tries, in order: escape, HTML tag, link, reference link, emphasis /
// strong, code span, hard break, strikethrough, autolink, extended
// autolink, then a run of plain text. `st` carries the document-wide
// state (inLink, inRawBlock, linkEmitted, linkParenPossible); `plain`
// renders to plain text (for image alt text) instead of HTML.

const RE_CODE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const RE_ESCAPE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const RE_BR = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const RE_AUTOLINK = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+)>/;
const RE_URL = /^(?:(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?)|^((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-]))/;
const RE_EMAIL_AT = /^[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const RE_PROTO = /^(?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\//;

// Scan a plain-text run starting at i: stop before any character that can
// start a construct, before a hard break, and before a URL / email that
// the extended-autolink rule would claim. Returns the end index.
function scanText(src, i, st) {
  const n = src.length;
  let j = i;
  for (; j < n; j++) {
    const c = src[j];
    if (c === '\\' || c === '<' || c === '[' || c === '`' || c === '*' || c === '~') break;
    if (c === '!') { if (src[j + 1] === '[') break; continue; }
    if (c === '_') { if (j === 0 || !isWordChar(src[j - 1])) break; continue; }
    if (c === ' ') {
      // Two or more spaces before a newline end the run (hard break).
      let k = j;
      while (k < n && src[k] === ' ') k++;
      if (k - j >= 2 && src[k] === '\n') break;
      j = k - 1;
      continue;
    }
    if (c === 'w' || c === 'W') {
      // www. starts an autolink when preceded by start / space / * _ ~ (.
      if (src.slice(j, j + 4).toLowerCase() === 'www.') {
        const p = j === 0 ? '' : src[j - 1];
        if (p === '' || p === ' ' || p === '\t' || p === '\n' || p === '*' || p === '_' || p === '~' || p === '(') break;
      }
      // Fall through to the email check below (a word starting with w
      // can be an email local part, e.g. when@ivory.example.com).
    }
    if (c === 'h' || c === 'H' || c === 'f' || c === 'F' || c === 'm' || c === 'M' || c === 'x' || c === 'X') {
      const rest = src.slice(j);
      if (RE_PROTO.test(rest)) break;
      if ((c === 'm' || c === 'M' || c === 'x' || c === 'X') && /^(?:mailto:|xmpp:)/i.test(rest)) break;
      // An email address: a run of local-part characters ending in @domain.
      if (EMAIL_LOCAL.test(c) && (j === 0 || !EMAIL_LOCAL.test(src[j - 1]))) {
        if (RE_EMAIL_AT.test(rest)) break;
      }
      continue;
    }
    if (EMAIL_LOCAL.test(c) && c !== '@' && (j === 0 || !EMAIL_LOCAL.test(src[j - 1]))) {
      if (RE_EMAIL_AT.test(src.slice(j))) break;
    }
  }
  return j;
}

// The masked source used only to find the last position where an emphasis
// or strikethrough closer could be. Code spans, links and HTML are hidden
// (same length, so indices still line up); escaped punctuation becomes '+'.
const RE_MASK_PUNCT = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const RE_MASK_BLOCKSKIP = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)((?<b>`+)[^`]+\k<b>(?!`))|<(?! )[^<>]*?>/g;
// Sub-patterns for link labels (reused by the link and reflink rules).
// A label allows balanced brackets, backslash escapes, code spans, and
// a double backtick run just before the closing bracket.
const RE_LABEL = /(?:[^\[\]\\`]*(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*?\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/;
const RE_REF = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const RE_MASK_REFLINK = new RegExp(`!?\\[(${RE_LABEL.source})\\]\\[(${RE_REF.source})\\]|!?\\[(${RE_REF.source})\\](?:\\[\\])?(?!\\()`, 'g');

function linkInText(s, links) {
  if (!s.includes('[')) return false;
  for (const m of s.matchAll(RE_MASK_BLOCKSKIP)) {
    if (RE_LINK.test(m[0]) && s.charAt(m.index - 1) !== '!') return true;
  }
  for (const m of s.matchAll(RE_MASK_REFLINK)) {
    const r = m[0], o = r.lastIndexOf('[');
    const lbl = normLabel(r.slice(o + 1, -1));
    if (!(r.charAt(0) === '!' || !Object.hasOwn(links, lbl)) && !(o > 1 && linkInText(r.slice(1, o - 1), links))) return true;
  }
  return false;
}

function maskSrc(src, links) {
  let t = src;
  if (links && src.includes('[')) {
    const s = r => {
      const o = r.lastIndexOf('[');
      if (!Object.hasOwn(links, normLabel(r.slice(o + 1, -1)))) return r;
      if (o > 1 && r.charAt(0) !== '!') {
        const inner = r.slice(1, o - 1);
        if (linkInText(inner, links)) return '[' + inner.replace(RE_MASK_REFLINK, s) + '][' + 'a'.repeat(r.length - o - 2) + ']';
      }
      return '[' + 'a'.repeat(r.length - 2) + ']';
    };
    t = t.replace(RE_MASK_REFLINK, s);
  }
  t = t.replace(RE_MASK_PUNCT, (m, bq, ep) => ep ? '+'.repeat(m.length) : bq ? bq + m.slice(bq.length, -bq.length).replace(/`/g, '+') + bq : m);
  t = t.replace(RE_MASK_BLOCKSKIP, (m, bq) => {
    const o = bq ? bq.length : 0;
    return m.slice(0, o) + '[' + 'a'.repeat(m.length - o - 2) + ']';
  });
  return t;
}

// Last index in the masked source where a delimiter run could close:
// the run must be preceded by a non-whitespace character (or be first).
function lastCloser(masked) {
  const out = { '*': -1, '_': -1, '~': -1 };
  const n = masked.length;
  for (let s = 0; s < n; s++) {
    const r = masked[s];
    if (r !== '*' && r !== '_' && r !== '~') continue;
    const prev = s === 0 ? '\n' : masked[s - 1];
    let e = s + 1;
    while (e < n && masked[e] === r) e++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') out[r] = s;
    s = e - 1;
  }
  return out;
}

// Try a code span at src[i] (i points at a backtick). Returns [html, end].
function codeSpan(src, i, plain) {
  const m = RE_CODE.exec(src.slice(i));
  if (!m) return null;
  let text = m[2].replace(/\n/g, ' ');
  if (/\S/.test(text) && text.charAt(0) === ' ' && text.charAt(text.length - 1) === ' ') {
    text = text.substring(1, text.length - 1);
  }
  return [plain ? text : '<code>' + esc(text, true) + '</code>', i + m[0].length];
}

// Try an HTML tag or comment at src[i]. Returns [html, end, kind] where
// kind is 'a-open' | 'a-close' | 'pre-open' | 'pre-close' | ''.
function htmlTag(src, i) {
  const rest = src.slice(i);
  let m = TAG_COMMENT.exec(rest) || TAG_PI.exec(rest) || TAG_DECL.exec(rest) || TAG_CDATA.exec(rest);
  if (m) return [m[0], i + m[0].length, ''];
  m = TAG_CLOSE.exec(rest);
  if (m) {
    const tag = m[0].slice(2, -1).trim().toLowerCase();
    const isA = /^<\/a>/i.test(m[0]);
    const isPre = /^<\/(pre|code|kbd|script)(\s|>)/i.test(m[0]);
    return [m[0], i + m[0].length, isA ? 'a-close' : isPre ? 'pre-close' : ''];
  }
  m = TAG_OPEN.exec(rest);
  if (m) {
    const tag = /^<([a-zA-Z][a-zA-Z0-9-]*)/.exec(m[0])[1].toLowerCase();
    // The reference only toggles state on `<a ` (with a space) and on
    // <pre|code|kbd|script> followed by whitespace or `>`; a bare
    // <a> or <a/> does not set inLink.
    const isA = tag === 'a' && m[0].charAt(2) === ' ';
    const after = m[0].charAt(tag.length + 1);
    const isPre = (tag === 'pre' || tag === 'code' || tag === 'kbd' || tag === 'script') && (after === '>' || after === ' ' || after === '\t' || after === '\n' || after === '\r' || after === '\f');
    return [m[0], i + m[0].length, isA ? 'a-open' : isPre ? 'pre-open' : ''];
  }
  return null;
}

// Try an angle autolink <scheme:...> or <email> at src[i].
function angleAutolink(src, i, plain) {
  const m = RE_AUTOLINK.exec(src.slice(i));
  if (!m) return null;
  const inner = m[1];
  const isMail = inner.indexOf('@') >= 0 && !/^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:/.test(inner);
  const href = isMail ? 'mailto:' + inner : inner;
  const text = esc(inner, true);
  const h = encHref(href);
  if (h === null) return [plain ? inner : text, i + m[0].length];
  return [plain ? inner : '<a href="' + esc(h, true) + '">' + text + '</a>', i + m[0].length];
}

// Try an extended autolink (www. / scheme:// / email) at src[i].
function extAutolink(src, i, plain) {
  const m = RE_URL.exec(src.slice(i));
  if (!m) return null;
  let text = m[0];
  // Backpedal: trim trailing punctuation / unbalanced parens.
  let prev;
  do { prev = text; text = URL_BACKPEDAL.exec(text)?.[0] ?? ''; } while (text !== prev);
  if (!text) return null;
  let href;
  if (text.indexOf('@') >= 0 && !/^[a-zA-Z][a-zA-Z0-9+.-]{1,31}:/.test(text) && !/^www\./i.test(text)) href = 'mailto:' + text;
  else if (/^www\./i.test(text)) href = 'http://' + text;
  else href = text;
  const h = encHref(href);
  const disp = esc(text, true);
  if (h === null) return [plain ? text : disp, i + text.length];
  return [plain ? text : '<a href="' + esc(h, true) + '">' + disp + '</a>', i + text.length];
}

// ---------------------------------------------------------------- links
const RE_LINK_LABEL = /(?:\[(?:\[(?:\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|[^\[\]\\])*?\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/;
const RE_LE = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const RE_LINK = new RegExp(`^!?\\[(${RE_LINK_LABEL.source})\\]\\([ \\t\\n]*(<(?:\\\\.|[^\\n<>\\\\])+>|[^ \\t\\n\\x00-\\x1f]+|(?=\\)))(?:(?:[ \\t]+(?:\\n[ \\t]*)?|\\n[ \\t]*)("(?:\\\\[\\s\\S]|[^"\\\\])*"|'(?:\\\\[\\s\\S]|[^'\\\\])*'|\\((?:\\\\[\\s\\S]|[^)\\\\])*\\)))?[ \\t\\n]*\\)`);
const RE_REFLINK = new RegExp(`^!?\\[(${RE_LINK_LABEL.source})\\]\\[(${RE_LE.source})\\]`);
const RE_NOLINK = new RegExp(`^!?\\[(${RE_LE.source})\\](?:\\[\\])?`);
const RE_UNESCAPE_PUNCT = /\\([\p{P}\p{S}])/gu;

// Does the link text contain an HTML tag or autolink that is not closed
// inside the text? Then the outer brackets are not a link.
function linkHasNested(src, label, off) {
  if (!label.includes('<')) return false;
  for (let s = 0; s < label.length; s++) {
    if (label[s] === '\\') { s++; continue; }
    if (label[s] === '`') {
      const m = RE_CODE.exec(label.slice(s));
      if (m) { s += m[0].length - 1; continue; }
    }
    if (label[s] !== '<') continue;
    const rest = src.slice(off + s);
    const m = htmlTag(rest, 0) || angleAutolinkMatch(rest);
    if (m) {
      if (m[0].length > label.length - s) return true;
      s += m[0].length - 1;
    }
  }
  return false;
}

function angleAutolinkMatch(rest) {
  const m = RE_AUTOLINK.exec(rest);
  return m ? [m[0], m[0].length] : null;
}

// Build a link/image token's HTML from its label text (already unescaped).
// Returns {html, end} or null when the label contains a link.
function makeLink(raw, isImage, labelText, href, title, links, st, plain) {
  const savedLink = st.inLink, savedEmitted = st.linkEmitted, savedRaw = st.inRawBlock;
  st.inLink = true; st.linkEmitted = false;
  const innerHtml = inline(labelText, links, st, plain);
  const emittedInside = st.linkEmitted;
  st.linkEmitted = savedEmitted; st.inLink = savedLink;
  if (!isImage) {
    if (emittedInside) { st.inRawBlock = savedRaw; return null; }
    st.linkEmitted = true;
  }
  if (plain) return { html: innerHtml, end: 0 };
  const h = encHref(href);
  if (h === null) return { html: innerHtml, end: 0 };
  if (isImage) {
    // The alt text is the label rendered as plain text (all tags
    // stripped), then escaped — never the inline HTML.
    st.inLink = true; st.linkEmitted = false;
    const altText = inline(labelText, links, st, true);
    st.linkEmitted = savedEmitted; st.inLink = savedLink;
    let out = `<img src="${esc(h)}" alt="${esc(altText)}"`;
    if (title) out += ` title="${esc(title)}"`;
    return { html: out + '>', end: 0 };
  }
  let out = `<a href="${esc(h)}"`;
  if (title) out += ` title="${esc(title)}"`;
  return { html: out + '>' + innerHtml + '</a>', end: 0 };
}

// Try an inline link [text](href "title") or image at src[i].
function tryLink(src, i, links, st, plain) {
  if (st.linkParenPossible === false) return null;
  const m = RE_LINK.exec(src.slice(i));
  if (!m) return null;
  let raw = m[0];
  const isImage = raw.charAt(0) === '!';
  const label = m[1];
  const off = isImage ? 2 : 1;
  if (linkHasNested(src.slice(i), label, off)) return null;
  let href = m[2].trim();
  let title = '';
  let titleCleared = false;
  if (href.charAt(0) === '<') {
    if (href.charAt(href.length - 1) !== '>') return null;
    const stripped = stripEnd(href.slice(0, -1), '\\');
    if ((href.length - stripped.length) % 2 === 0) return null;
  } else {
    const cut = parenClose(href);
    if (cut === -2) return null;
    if (cut > -1) {
      const h = (isImage ? 5 : 4) + label.length + cut;
      href = href.substring(0, cut);
      raw = raw.substring(0, h).trim();
      titleCleared = true;
    }
  }
  const tail = stripEnd(raw.slice(0, -1), '\\');
  if ((raw.length - tail.length) % 2 === 0) return null;
  if (m[3] !== undefined && !titleCleared) title = m[3].slice(1, -1);
  href = href.trim();
  if (href.charAt(0) === '<') href = href.slice(1, -1);
  href = href.replace(RE_UNESCAPE_PUNCT, '$1');
  title = title.replace(RE_UNESCAPE_PUNCT, '$1');
  const labelText = label.replace(/\\([\[\]])/g, '$1');
  const r = makeLink(raw, isImage, labelText, href, title || null, links, st, plain);
  if (!r) return null;
  return { html: r.html, end: i + raw.length };
}

// Try a reference link [text][ref], [text][] or [text] at src[i].
function tryReflink(src, i, links, st, plain) {
  const m = RE_REFLINK.exec(src.slice(i)) || RE_NOLINK.exec(src.slice(i));
  if (!m) return null;
  const raw = m[0];
  const isImage = raw.charAt(0) === '!';
  const off = isImage ? 2 : 1;
  const label = m[1];
  if (linkHasNested(src.slice(i), label, off)) return null;
  const ref = normLabel(m[2] || label);
  const def = links[ref];
  if (!def) {
    // Not a defined reference: the [ (or ![) is literal text.
    return { html: plain ? raw.charAt(0) : esc(raw.charAt(0)), end: i + 1 };
  }
  const labelText = label.replace(/\\([\[\]])/g, '$1');
  const r = makeLink(raw, isImage, labelText, def.href, def.title || null, links, st, plain);
  if (!r) return null;
  return { html: r.html, end: i + raw.length };
}

// ---------------------------------------------------------------- emphasis
const RE_LDELIM = /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u;
const RE_RDELIM_AST = /^[^_*]*?__[^_*]*?\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?=[\s]|$)|(?:[^\s\p{P}\p{S}]|~)(\*+)(?!\*)(?=(?!~)[\s\p{P}\p{S}]|$)|(?!\*)(?!~)[\s\p{P}\p{S}](\*+)(?=(?:[^\s\p{P}\p{S}]|~))|[\s](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?!\*)(?!~)[\p{P}\p{S}](\*+)(?!\*)(?=(?!~)[\p{P}\p{S}])|(?:[^\s\p{P}\p{S}]|~)(\*+)(?=(?:[^\s\p{P}\p{S}]|~))/gu;
const RE_RDELIM_UND = /^[^_*]*?\*\*[^_*]*?_[^_*]*?(?=\*\*)|[^_]+(?=[^_])|(?!_)[\p{P}\p{S}](_+)(?=[\s]|$)|[^\s\p{P}\p{S}](_+)(?!_)(?=[\s\p{P}\p{S}]|$)|(?!_)[\s\p{P}\p{S}](_+)(?=[^\s\p{P}\p{S}])|[\s](_+)(?!_)(?=[\p{P}\p{S}])|(?!_)[\p{P}\p{S}](_+)(?!_)(?=[\p{P}\p{S}])/gu;
const RE_DEL_LDELIM = /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u;
const RE_DEL_RDELIM = /^[^~]+(?=[^~])|(?!~)[\p{P}\p{S}](~~?)(?=[\s]|$)|[^\s\p{P}\p{S}](~~?)(?!~)(?=[\s\p{P}\p{S}]|$)|(?!~)[\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])|[\s](~~?)(?!~)(?=[\p{P}\p{S}])|(?!~)[\p{P}\p{S}](~~?)(?!~)(?=[\p{P}\p{S}])|[^\s\p{P}\p{S}](~~?)(?=[^\s\p{P}\p{S}])/gu;
const RE_PUNCT_SINGLE = /^((?![*_])[\s\p{P}\p{S}])/u;

// Try emphasis / strong at src[i] (i points at * or _). `full` is the
// whole inline source, `masked` its masked copy, `closer` the last-closer
// indices, `prev` the previous text character ('' when none).
function tryEmStrong(src, i, full, masked, closer, prev, links, st, plain) {
  const rest = src.slice(i);
  const s = RE_LDELIM.exec(rest);
  if (!s || (!s[1] && !s[2] && !s[3] && !s[4])) return null;
  const r = s[0][0];
  const o = prev === r;
  const pos = full.length - rest.length; // == i when rest is src.slice(i)
  let l = pos;
  while (l > 0 && full[l - 1] === r) l--;
  const p = [...full.slice(Math.max(0, l - 2), l)].at(-1) ?? '';
  const h = p === '*' || p === '_' || RE_PUNCT_SINGLE.test(p);
  let n = prev;
  if (l < pos) n = p;
  const u = l < pos ? h : RE_PUNCT_SINGLE.test(n);
  if (s[4] && isAlnum(n)) return null;
  const d = s[1] || s[3] || '';
  if (!d || !n || u) {
    const k = [...s[0]].length - 1;
    let m = k, f = 0;
    const y = pos - l + k;
    const R = p.trim() !== '' && (!!d || (r === '*' && !h));
    if (r !== '*' && r !== '_') return null;
    const A = r === '*' ? RE_RDELIM_AST : RE_RDELIM_UND;
    const v = closer[r];
    const Q = pos + k;
    if (v < Q) return null;
    const t2 = masked.slice(Q);
    const ee = v - Q;
    let m2;
    for (A.lastIndex = 0; (m2 = A.exec(t2)) !== null && !(m2.index > ee);) {
      const g = m2[1] || m2[2] || m2[3] || m2[4] || m2[5] || m2[6];
      if (!g) continue;
      let b = [...g].length;
      if (m2[3] || m2[4]) { m += b; continue; }
      else if (m2[5] || m2[6] || R) {
        if (o && (m2[5] || m2[6])) break;
        if (y % 3 && !((y + b) % 3)) { f += b; continue; }
      }
      m -= b;
      if (m > 0) continue;
      b = Math.min(b, b + m + f);
      const te = [...m2[0]][0].length;
      const M = rest.slice(0, k + m2.index + te + b);
      if (Math.min(k, b) % 2) {
        const inner = M.slice(1, -1);
        return { html: plain ? inline(inner, links, st, true) : '<em>' + inline(inner, links, st, plain) + '</em>', end: i + M.length };
      }
      const inner = M.slice(2, -2);
      return { html: plain ? inline(inner, links, st, true) : '<strong>' + inline(inner, links, st, plain) + '</strong>', end: i + M.length };
    }
  }
  return null;
}

// Try strikethrough at src[i] (i points at ~).
function tryDel(src, i, full, masked, closer, prev, links, st, plain) {
  const rest = src.slice(i);
  const s = RE_DEL_LDELIM.exec(rest);
  if (!s) return null;
  if (!((s[1] || '') || !prev || RE_PUNCT_SINGLE.test(prev))) return null;
  const o = [...s[0]].length - 1;
  let p = o;
  const u = closer['~'];
  const pos = full.length - rest.length;
  const d = pos + o;
  if (u < d) return null;
  const t2 = masked.slice(d);
  const k = u - d;
  let m2;
  for (RE_DEL_RDELIM.lastIndex = 0; (m2 = RE_DEL_RDELIM.exec(t2)) !== null && !(m2.index > k);) {
    const g = m2[1] || m2[2] || m2[3] || m2[4] || m2[5] || m2[6];
    if (!g) continue;
    let l = [...g].length;
    if (l !== o) continue;
    if (m2[3] || m2[4]) { p += l; continue; }
    p -= l;
    if (p > 0) continue;
    l = Math.min(l, l + p);
    const te = [...m2[0]][0].length;
    const raw = rest.slice(0, o + m2.index + te + l);
    const inner = raw.slice(o, -o);
    return { html: plain ? inline(inner, links, st, true) : '<del>' + inline(inner, links, st, plain) + '</del>', end: i + raw.length };
  }
  return null;
}

// Render one inline source to HTML (or plain text when plain is true).
function inline(src, links, st, plain) {
  if (!src) return '';
  const hasDelim = src.includes('*') || src.includes('_') || src.includes('~');
  const masked = hasDelim ? maskSrc(src, links) : src;
  const closer = hasDelim ? lastCloser(masked) : null;
  const out = [];
  let i = 0, prev = '', prevIsText = false;
  const n = src.length;
  // linkParenPossible: a link needs a ')' somewhere in this source.
  const savedParen = st.linkParenPossible;
  st.linkParenPossible = savedParen && src.includes(')');
  try {
    while (i < n) {
      const c = src[i];
      let r = null;
      if (c === '\\') {
        const m = RE_ESCAPE.exec(src.slice(i));
        if (m) r = { html: plain ? m[1] : esc(m[1]), end: i + m[0].length };
        else {
          const b = RE_BR.exec(src.slice(i));
          if (b) r = { html: plain ? '' : '<br>', end: i + b[0].length };
        }
      } else if (c === '<') {
        const t = htmlTag(src, i);
        if (t) {
          if (t[2] === 'a-open') st.inLink = true;
          else if (t[2] === 'a-close') st.inLink = false;
          if (t[2] === 'pre-open') st.inRawBlock = true;
          else if (t[2] === 'pre-close') st.inRawBlock = false;
          r = { html: plain ? t[0] : t[0], end: t[1] };
        } else {
          const a = angleAutolink(src, i, plain);
          if (a) r = { html: a[0], end: a[1] };
        }
      } else if (c === '[' || (c === '!' && src[i + 1] === '[')) {
        r = tryLink(src, i, links, st, plain) || tryReflink(src, i, links, st, plain);
      } else if (c === '*' || c === '_') {
        r = tryEmStrong(src, i, src, masked, closer, prevIsText ? prev : '', links, st, plain);
        if (!r) {
          // No emphasis: only ONE delimiter char is literal text (the
          // reference's text rule stops at the next delimiter, so the
          // following char in the run is retried as an opener).
          r = { html: plain ? c : esc(decEnt(c)), end: i + 1, literal: true };
        }
      } else if (c === '`') {
        const cs = codeSpan(src, i, plain);
        if (cs) r = { html: cs[0], end: cs[1] };
        else {
          // No code span here: the whole backtick run is literal text
          // (so a later, shorter run is not retried as an opener).
          let j = i + 1;
          while (j < n && src[j] === '`') j++;
          const run = src.slice(i, j);
          r = { html: plain ? run : esc(decEnt(run)), end: j, literal: true };
        }
      } else if (c === ' ' || c === '\n') {
        const m = RE_BR.exec(src.slice(i));
        if (m) r = { html: plain ? '' : '<br>', end: i + m[0].length };
      } else if (c === '~') {
        r = tryDel(src, i, src, masked, closer, prevIsText ? prev : '', links, st, plain);
        if (!r) {
          let j = i + 1;
          while (j < n && src[j] === '~') j++;
          const run = src.slice(i, j);
          r = { html: plain ? run : esc(decEnt(run)), end: j, literal: true };
        }
      }
      if (!r) {
        // Extended autolink (www. / scheme:// / email), suppressed inside
        // a link. Then a plain text run.
        if (!st.inLink) {
          const a = extAutolink(src, i, plain);
          if (a) r = { html: a[0], end: a[1] };
        }
        if (!r) {
          const j = scanText(src, i, st);
          if (j === i) {
            // A single character the scanner would not consume (e.g. '_'
            // after a word character, or '!' not followed by '[').
            const ch = src[i];
            r = { html: plain ? (st.inRawBlock ? ch : decEnt(ch)) : (st.inRawBlock ? ch : esc(decEnt(ch))), end: i + 1, literal: true };
          } else {
            const text = src.slice(i, j);
            r = { html: plain ? (st.inRawBlock ? text : decEnt(text)) : (st.inRawBlock ? text : esc(decEnt(text))), end: j, literal: true };
          }
        }
      }
      out.push(r.html);
      if (r.literal) {
        const last = src[r.end - 1];
        prev = last === '_' ? '' : last;
        prevIsText = true;
      } else { prev = ''; prevIsText = false; }
      i = r.end;
    }
  } finally {
    st.linkParenPossible = savedParen;
  }
  return out.join('');
}

// ------------------------------------------------------------------ blocks
// Block parsing walks the remaining source and, at each position, tries
// the block rules in the reference order: blank lines, indented code,
// fenced code, ATX heading, thematic break, blockquote, list, HTML
// block, link reference definition, table, setext heading, paragraph,
// and (inside containers) plain text. Nodes are plain objects; inline
// text is rendered later, once every reference definition is known.

function lineEnd(s, i) {
  const j = s.indexOf('\n', i);
  return j === -1 ? s.length : j;
}

// Indentation of the line starting at i: the visual column of the first
// non-space/tab character and the index where the content starts. A tab
// advances to the next multiple of 4.
function indentAt(s, i) {
  let col = 0, j = i;
  for (; j < s.length; j++) {
    const c = s[j];
    if (c === ' ') col++;
    else if (c === '\t') col += 4 - (col % 4);
    else break;
  }
  return { col, idx: j };
}

function isBlank(s, i) {
  const e = lineEnd(s, i);
  for (let j = i; j < e; j++) if (s[j] !== ' ' && s[j] !== '\t') return false;
  return true;
}

// Drop trailing blank lines from a block's raw text, keeping at most one
// trailing newline (the reference's ge()).
function trimBlankTail(raw) {
  const lines = raw.split('\n');
  let t = lines.length - 1;
  while (t >= 0 && /^[ \t]*$/.test(lines[t])) t--;
  if (lines.length - t <= 2) return raw;
  return lines.slice(0, t + 1).join('\n');
}

// The first line of s, without its newline.
function firstLine(s) {
  const e = lineEnd(s, 0);
  return s.slice(0, e);
}

// Does the line starting at i begin (after at most 3 spaces) with one of
// the given literal prefixes? Tabs count as 4 columns, so a tab at the
// start never matches a <=3-space prefix.
function startsAt(s, i, lit) {
  const { col, idx } = indentAt(s, i);
  if (col > 3) return -1;
  return s.startsWith(lit, idx) ? idx : -1;
}

// Block-start tests used by the paragraph interruption rule. Each takes
// the source and a line start and answers whether that line opens a block
// that interrupts a paragraph.
function isFenceStart(s, i) {
  const { col, idx } = indentAt(s, i);
  if (col > 3) return false;
  const c = s[idx];
  if (c !== '`' && c !== '~') return false;
  let j = idx;
  while (s[j] === c) j++;
  if (j - idx < 3) return false;
  if (c === '`') {
    const e = lineEnd(s, idx);
    if (s.slice(j, e).includes('`')) return false;
  }
  return true;
}

function isAtxStart(s, i) {
  const { col, idx } = indentAt(s, i);
  if (col > 3) return false;
  let j = idx, n = 0;
  while (s[j] === '#') { j++; n++; }
  if (n === 0 || n > 6) return false;
  const c = s[j];
  return c === undefined || c === '\n' || c === ' ' || c === '\t';
}

function isHrStart(s, i) {
  const { col, idx } = indentAt(s, i);
  if (col > 3) return false;
  const e = lineEnd(s, idx);
  const line = s.slice(idx, e);
  return /^(?:-[ \t]*){3,}$/.test(line) || /^(?:_[ \t]*){3,}$/.test(line) || /^(?:\*[ \t]*){3,}$/.test(line);
}

function isBlockquoteStart(s, i) {
  const { col, idx } = indentAt(s, i);
  return col <= 3 && s[idx] === '>';
}

function isListStart(s, i) {
  const { col, idx } = indentAt(s, i);
  if (col > 3) return false;
  const c = s[idx];
  if (c === '*' || c === '+' || c === '-') {
    const d = s[idx + 1];
    return d === ' ' || d === '\t' || d === '\n' || d === undefined;
  }
  if (c >= '0' && c <= '9') {
    let j = idx;
    while (s[j] >= '0' && s[j] <= '9') j++;
    if (j - idx > 9 || j - idx === 0) return false;
    const d = s[j];
    if (d !== '.' && d !== ')') return false;
    const e = s[j + 1];
    return e === ' ' || e === '\t' || e === '\n' || e === undefined;
  }
  return false;
}

function isHtmlStart(s, i) {
  const { col, idx } = indentAt(s, i);
  if (col > 3) return false;
  const rest = s.slice(idx);
  if (RE_BLOCK_TAG.test(rest)) return true;
  if (/^<(script|pre|style|textarea)(?:[\s>]|$)/i.test(rest)) return true;
  if (rest.startsWith('<!--') || rest.startsWith('<?') || rest.startsWith('<![CDATA[')) return true;
  if (/^<![A-Za-z]/.test(rest)) return true;
  return false;
}

// The wider gate for an HTML block at the top level: the narrow set plus
// a generic open or close tag (type 7/8). A generic tag does NOT
// interrupt a paragraph, so this is only used by tryHtml.
const RE_GENERIC_TAG = /^<[a-zA-Z][a-zA-Z0-9-]*(?: +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?)* *\/?>|^<\/[a-zA-Z][a-zA-Z0-9-]* *>/;
function isHtmlBlockStart(s, i) {
  if (isHtmlStart(s, i)) return true;
  const { col, idx } = indentAt(s, i);
  if (col > 3) return false;
  return RE_GENERIC_TAG.test(s.slice(idx));
}

function isSetextLine(s, i) {
  const { col, idx } = indentAt(s, i);
  if (col > 3) return false;
  const e = lineEnd(s, idx);
  const line = s.slice(idx, e);
  return /^=+ *[ \t]*$/.test(line) || /^-+ *[ \t]*$/.test(line);
}

// Blank-line run at the start of s: returns its length (0 when none).
function blankRun(s) {
  let i = 0;
  while (i < s.length) {
    const e = lineEnd(s, i);
    let blank = true;
    for (let j = i; j < e; j++) if (s[j] !== ' ' && s[j] !== '\t') { blank = false; break; }
    if (!blank) break;
    i = e + 1;
    if (i > s.length) break;
  }
  return i;
}

// Indented code block at the start of s. Returns {node, len} or null.
function tryIndentedCode(s) {
  const { col } = indentAt(s, 0);
  if (col < 4 && !(s[0] === '\t' || (s[0] === ' ' && s[1] === ' ' && s[2] === ' ' && s[3] === '\t'))) {
    // Needs a 4-column indent or a <=3-space + tab indent.
    if (col < 4) return null;
  }
  // First line must be indented code (4 cols or 0-3 spaces + tab) and
  // non-blank.
  const first = indentAt(s, 0);
  const isCodeLine = (c) => c >= 4 || (s.slice(0, first.idx).includes('\t'));
  if (!isCodeLine(first.col) || isBlank(s, 0)) return null;
  let i = 0, raw = '';
  while (i < s.length) {
    const e = lineEnd(s, i);
    if (isBlank(s, i)) {
      // Blank lines are absorbed; stop when a non-blank non-code line
      // follows (checked by peeking ahead below).
      let j = e + 1, k = j;
      while (k < s.length && isBlank(s, k)) k = lineEnd(s, k) + 1;
      if (k >= s.length) { raw += s.slice(i); i = s.length; break; }
      const nc = indentAt(s, k);
      const codeNext = nc.col >= 4 || s.slice(k, nc.idx).includes('\t');
      if (!codeNext) { raw += s.slice(i, e); i = e; break; }
      raw += s.slice(i, k); i = k; continue;
    }
    const c = indentAt(s, i);
    const codeLine = c.col >= 4 || s.slice(i, c.idx).includes('\t');
    if (!codeLine) break;
    raw += s.slice(i, e + 1); i = e + 1;
  }
  raw = trimBlankTail(raw);
  // Strip 1-4 columns of indent from each line.
  const text = raw.split('\n').map(line => {
    let col = 0, j = 0;
    while (j < line.length && col < 4) {
      if (line[j] === ' ') { col++; j++; }
      else if (line[j] === '\t') { col += 4 - (col % 4); j++; if (col > 4) break; }
      else break;
    }
    return line.slice(j);
  }).join('\n');
  return { node: { t: 'code', lang: '', text }, len: raw.length + (raw.endsWith('\n') ? 0 : 0) };
}

// Fenced code block at the start of s. Returns {node, len} or null.
function tryFences(s) {
  const { col, idx } = indentAt(s, 0);
  if (col > 3) return null;
  const fence = s[idx];
  if (fence !== '`' && fence !== '~') return null;
  let j = idx;
  while (s[j] === fence) j++;
  const flen = j - idx;
  if (flen < 3) return null;
  const eol = lineEnd(s, idx);
  const info = s.slice(j, eol);
  if (fence === '`' && info.includes('`')) return null;
  const lang = info.trim().replace(RE_UNESCAPE_PUNCT, '$1');
  // Scan for the closing fence.
  let i = eol + 1, contentStart = i, contentEnd = -1, closeEnd = s.length, foundClose = false;
  while (i < s.length) {
    const e = lineEnd(s, i);
    const c2 = indentAt(s, i);
    if (c2.col <= 3) {
      let k = c2.idx, n2 = 0;
      while (s[k] === fence) { k++; n2++; }
      if (n2 >= flen) {
        const rest = s.slice(k, e);
        if (/^[ \t]*$/.test(rest)) { contentEnd = i; closeEnd = e; foundClose = true; break; }
      }
    }
    i = e + 1;
  }
  if (contentEnd === -1) { contentEnd = s.length; closeEnd = s.length; }
  let text = s.slice(contentStart, contentEnd);
  // The reference's content group stops before the newline that precedes
  // the closing fence, so a trailing newline there is not part of the
  // content (an unclosed fence keeps its text as-is).
  if (foundClose && text.endsWith('\n')) text = text.slice(0, -1);
  // Indent compensation: a ``` fence indented on its opening line has
  // that much leading whitespace stripped from each content line.
  if (fence === '`' && idx > 0) {
    const pad = s.slice(0, idx);
    text = text.split('\n').map(line => {
      const m = /^[ \t]*/.exec(line)[0];
      return line.slice(Math.min(m.length, pad.length));
    }).join('\n');
  }
  const len = closeEnd;
  return { node: { t: 'code', lang, text }, len };
}

// ATX heading at the start of s.
function tryAtx(s) {
  const { col, idx } = indentAt(s, 0);
  if (col > 3) return null;
  let j = idx, n = 0;
  while (s[j] === '#') { j++; n++; }
  if (n === 0 || n > 6) return null;
  const c = s[j];
  if (c !== undefined && c !== '\n' && c !== ' ' && c !== '\t') return null;
  const e = lineEnd(s, idx);
  let text = s.slice(j, e).trim();
  if (/#$/.test(text)) {
    const stripped = stripEnd(text, '#');
    if (!stripped || /[ \t]$/.test(stripped)) text = stripped.trim();
  }
  return { node: { t: 'h', depth: n, text }, len: e + 1 > s.length ? s.length : e + 1 };
}

// Thematic break at the start of s.
function tryHr(s) {
  if (!isHrStart(s, 0)) return null;
  const e = lineEnd(s, 0);
  return { node: { t: 'hr' }, len: e + 1 > s.length ? s.length : e + 1 };
}

// Strip one blockquote marker from a line: up to 3 spaces, '>', then
// one optional space or tab. A tab after the marker expands from the
// marker's column (so inside nested quotes it counts as one level).
function stripBQMarker(line, idx) {
  let j = idx + 1; // past '>'
  if (line[j] === ' ') return line.slice(j + 1);
  if (line[j] === '\t') {
    const col = idx + 1; // column after '>'
    const r = 4 - (col % 4);
    return ' '.repeat(r - 1) + line.slice(j + 1);
  }
  return line.slice(j);
}

// Is this stripped line a paragraph line? The reference's paragraph
// pattern takes any non-blank line as a first line; whether a following
// lazy line belongs is decided by the lazy-line checks, and a chunk
// ending in a fence/heading/rule/HTML/table stops the quote anyway.
function isParaLine(content) {
  if (!content || /^[ \t]*$/.test(content)) return false;
  return true;
}

// Would the line at i interrupt a paragraph? (ATX, fence, hr, blockquote,
// list, HTML block, table delimiter, setext underline.) A list only
// interrupts a paragraph when it has content after the marker, and an
// ordered list only when it starts with 1.
function isListInterrupt(s, i) {
  const { col, idx } = indentAt(s, i);
  if (col > 3) return false;
  const rest = s.slice(idx);
  return /^(?:[*+-]|1[.)])[ \t]+[^ \t\n]/.test(rest);
}

function interruptsPara(s, i) {
  if (isBlank(s, i)) return true;
  if (isFenceStart(s, i) || isAtxStart(s, i) || isHrStart(s, i)) return true;
  if (isBlockquoteStart(s, i) || isListInterrupt(s, i) || isHtmlStart(s, i)) return true;
  if (isSetextLine(s, i)) return true;
  return false;
}

// Blockquote at the start of s. Returns {node, len} or null.
function tryBlockquote(s, links) {
  if (!isBlockquoteStart(s, 0)) return null;
  // Collect the run: '>' lines plus lazy paragraph continuations.
  const rawLines = [];
  const lineEnds = [];
  let i = 0, openPara = false;
  while (i < s.length) {
    const e = lineEnd(s, i);
    const { col, idx } = indentAt(s, i);
    if (col <= 3 && s[idx] === '>') {
      rawLines.push(s.slice(i, e));
      openPara = isParaLine(stripBQMarker(s.slice(i, e), idx - i));
    } else if (openPara && !isBlank(s, i) && !isFenceStart(s, i) && !isAtxStart(s, i) && !isHrStart(s, i) && !isBlockquoteStart(s, i) && !isListStart(s, i) && !isHtmlStart(s, i)) {
      // A lazy continuation: any plain line, INCLUDING a setext
      // underline (it is protected with 4 spaces when re-lexed).
      rawLines.push(s.slice(i, e));
      openPara = isParaLine(s.slice(i, e));
    } else break;
    i = e < s.length ? e + 1 : e;
    lineEnds.push(i);
  }
  // Process in chunks (a chunk ends at a lazy line that follows a '>'
  // line); strip markers, re-lex, and merge lazy paragraphs. The
  // consumed length covers only the lines actually incorporated: when a
  // chunk ends in a code block, heading, rule, HTML block or table, the
  // remaining lines stay outside the quote.
  let nodes = [];
  let rest = rawLines.slice();
  let rawOut = '', textOut = '', used = 0;
  while (rest.length > 0) {
    let p = 0, seenMarker = false;
    const chunk = [];
    for (; p < rest.length; p++) {
      const { col, idx } = indentAt(rest[p], 0);
      const isMarker = col <= 3 && rest[p][idx] === '>';
      if (isMarker) { chunk.push(rest[p]); seenMarker = true; }
      else if (!seenMarker) chunk.push(rest[p]);
      else break;
    }
    rest = rest.slice(p);
    used += chunk.length;
    let h = chunk.join('\n');
    // Expand tabs after each marker, protect lazy setext underlines, strip.
    h = h.replace(/^( {0,3}>)([ \t]+)/gm, (m, b, w) => b + expandTabs(w, b.length));
    h = h.replace(/\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g, '\n    $1');
    h = h.replace(/^ {0,3}>[ \t]?/gm, '');
    rawOut = rawOut ? rawOut + '\n\n' + chunk.join('\n') : chunk.join('\n');
    textOut = textOut ? textOut + '\n\n' + h : h;
    // Re-lex into the shared node array: a paragraph that continues a
    // lazy line merges with the previous chunk's paragraph.
    blockTokens(h, links, true, true, nodes);
    if (rest.length === 0) break;
    const last = nodes[nodes.length - 1];
    if (!last) break;
    if (last.t === 'code' || last.t === 'h' || last.t === 'hr' || last.t === 'html' || last.t === 'table') break;
    if (last.t === 'q') {
      // A nested quote may extend over the remaining lines. The
      // reference strips one level of `>` markers from the remaining
      // lines before re-parsing, so a lazy paragraph continues instead
      // of becoming a new nested quote. The re-parse may consume only
      // some of the remaining lines; the rest stay for the next chunk.
      const g = last;
      const restStripped = rest.join('\n').replace(/^ {0,3}>[ \t]?/gm, '');
      const combined = g.raw + '\n' + restStripped;
      const re = tryBlockquote(combined, links);
      if (re) {
        nodes[nodes.length - 1] = re.node;
        const y = combined.slice(re.len).replace(/^\n/, '');
        const R = y ? y.split('\n').length : 0;
        const A = R ? rest.slice(0, rest.length - R) : rest;
        if (A.length > 0) {
          rawOut = rawOut + '\n\n' + A.join('\n');
          textOut = textOut.substring(0, textOut.length - g.text.length) + re.node.text;
          used += A.length;
          rest = rest.slice(A.length);
          if (rest.length > 0) {
            const { col, idx } = indentAt(rest[0], 0);
            if (col <= 3 && rest[0][idx] === '>') continue;
          }
        }
      }
      break;
    } else if (last.t === 'list') {
      // A nested list may extend over the remaining lines (no marker
      // stripping for lists). Consume what the re-parse took, then
      // continue with the next chunk.
      const g = last;
      const combined = g.raw + '\n' + rest.join('\n');
      const re = tryList(combined, links);
      if (re) {
        nodes[nodes.length - 1] = re.node;
        const f = re.len > g.raw.length ? combined.slice(g.raw.length + 1, re.len).split('\n').length : 0;
        if (f > 0) {
          const y = rest.slice(0, f).join('\n');
          rawOut = rawOut + '\n\n' + y;
          textOut = textOut + '\n\n' + y;
          used += f;
          rest = rest.slice(f);
          continue;
        }
      }
      break;
    }
    // Otherwise (paragraph/text) the loop continues with the next chunk,
    // whose paragraph merges into this one.
  }
  const len = used > 0 ? lineEnds[used - 1] : 0;
  return { node: { t: 'q', nodes, raw: rawOut, text: textOut }, len };
}

// List at the start of s. Returns {node, len} or null.
function tryList(s, links) {
  const first = /^ {0,3}((?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/.exec(s);
  if (!first) return null;
  const marker = first[1].trim();
  const ordered = marker.length > 1;
  const start = ordered ? +marker.slice(0, -1) : 0;
  const markerRe = ordered ? `\\d{1,9}\\${marker.slice(-1)}` : `\\${marker}`;
  const itemRe = new RegExp(`^( {0,3}${markerRe})((?:[ \\t][^\\n]*)?(?:\\n|$))`);
  const list = { t: 'list', ordered, start, loose: false, items: [], raw: '' };
  let rest = s, consumedTotal = 0, prevBlankEnded = false;
  while (rest) {
    if (isHrStart(rest, 0)) break;
    const m = itemRe.exec(rest);
    if (!m) break;
    const itemStart = consumedTotal;
    rest = rest.slice(m[0].length);
    consumedTotal += m[0].length;
    const g = m[2].split('\n', 1)[0];
    const b = m[1].length;
    const mExp = g.replace(/^[ \t]+/, v => expandTabs(v, b));
    const f0 = rest.split('\n', 1)[0];
    const emptyFirst = !mExp.trim();
    let R, d;
    if (emptyFirst) { R = b + 1; d = ''; }
    else {
      R = mExp.search(/[^ ]/);
      if (R === -1) R = 0;
      if (R > 4) R = 1;
      d = mExp.slice(R); R += b;
    }
    let emptyItem = false;
    if (emptyFirst && /^[ \t]*$/.test(f0)) {
      rest = rest.slice(f0.length + 1);
      consumedTotal += f0.length + 1;
      emptyItem = true;
    }
    if (!emptyItem) {
      // The reference builds these interruption patterns through a
      // helper that clamps the indent to max(0, min(3, R - 1)): a line
      // indented R or more is content, not a new bullet / hr / fence.
      const n = Math.max(0, Math.min(3, R - 1));
      const nextBullet = new RegExp(`^ {0,${n}}(?:[*+-]|\\d{1,9}[.)])((?:[ \\t][^\\n]*)?(?:\\n|$))`);
      const hrAt = new RegExp(`^ {0,${n}}((?:-[ \\t]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)`);
      const fenceAt = new RegExp(`^ {0,${n}}(?:\`\`\`|~~~)`);
      const headAt = new RegExp(`^ {0,${n}}#{1,6}(?:\\s|$)`);
      const htmlAt = new RegExp(`^ {0,${n}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i');
      const bqAt = new RegExp(`^ {0,${n}}>`);
      let mCur = mExp;
      // y: whether the previous line processed was blank. After a blank
      // line, an under-indented line ends the item (it is not a lazy
      // continuation). It starts true when the first line is empty.
      let prevBlank = emptyFirst;
      while (rest) {
        const line = rest.split('\n', 1)[0];
        const f = line;
        const Z = f.replace(/^[ \t]+/, v => expandTabs(v, 0));
        if (fenceAt.test(f) || headAt.test(f) || htmlAt.test(f) || bqAt.test(f) || nextBullet.test(f) || hrAt.test(f)) break;
        if (Z.search(/[^ ]/) >= R || !f.trim()) {
          d += '\n' + Z.slice(R);
        } else {
          if (prevBlank || mCur.replace(/\t/g, '    ').search(/[^ ]/) >= 4 || fenceAt.test(mCur) || headAt.test(mCur) || htmlAt.test(mCur) || hrAt.test(mCur)) break;
          let qe;
          if (/^ {0,3}(?:=+|-+) *$/.test(f)) {
            // Possible lazy setext: only when the item text + line is one.
            const probe = mCur + '\n' + f;
            if (/^[^\n]+\n {0,3}(?:=+|-+) *$/.test(probe)) qe = '    ' + Z.replace(/^ {0,3}/, '');
            else qe = f;
          } else qe = f;
          d += '\n' + qe;
        }
        prevBlank = !f.trim();
        rest = rest.slice(line.length + 1);
        consumedTotal += line.length + 1;
        mCur = Z.slice(R);
      }
    }
    const itemRaw = s.slice(itemStart, consumedTotal);
    if (list.loose) { /* already loose */ }
    else if (prevBlankEnded) list.loose = true;
    else if (/\n[ \t]*\n[ \t]*$/.test(itemRaw)) prevBlankEnded = true;
    list.items.push({ raw: itemRaw, task: /^\[[ xX]\][ \t]+\S/.test(d), loose: false, text: d, nodes: [] });
  }
  if (!list.items.length) return null;
  const lastItem = list.items[list.items.length - 1];
  lastItem.raw = lastItem.raw.replace(/[ \t\n]+$/, '');
  lastItem.text = lastItem.text.replace(/[ \t\n]+$/, '');
  list.raw = s.slice(0, consumedTotal).replace(/[ \t\n]+$/, '');
  // Lex each item's content (top=false: paragraphs become text tokens).
  for (const item of list.items) {
    const sub = blockTokens(item.text, links, false, false);
    item.nodes = sub.nodes;
    if (!list.loose && sub.hadSpace) list.loose = true;
  }
  // Task lists: strip the marker, insert a checkbox token.
  for (const item of list.items) {
    const d0 = item.nodes[0];
    if (item.task && d0 && (d0.t === 'text' || d0.t === 'p')) {
      const k = /^\[[ xX]\]/.exec(item.text);
      item.text = item.text.replace(/^\[[ xX]\][ \t]+/, '');
      d0.text = d0.text.replace(/^\[[ xX]\][ \t]+/, '');
      if (k) {
        const cb = { t: 'checkbox', checked: k[0] !== '[ ]', raw: k[0] + ' ' };
        item.checked = cb.checked;
        if (list.loose) {
          if (item.nodes[0] && (item.nodes[0].t === 'p' || item.nodes[0].t === 'text')) {
            item.nodes[0].prefix = cb;
          } else {
            item.nodes.unshift({ t: 'p', text: '', prefix: cb });
          }
        } else {
          item.nodes.unshift(cb);
        }
      }
    } else if (item.task) item.task = false;
  }
  if (list.loose) {
    for (const item of list.items) {
      item.loose = true;
      for (const nd of item.nodes) if (nd.t === 'text') nd.t = 'p';
    }
  }
  // The consumed length is the trimmed raw: trailing blank lines after
  // the list stay in the input (they are a space token for the caller,
  // which is what makes an outer list loose).
  return { node: list, len: list.raw.length };
}

// HTML block at the start of s. Returns {node, len} or null.
function tryHtml(s) {
  if (!isHtmlBlockStart(s, 0)) return null;
  const { idx } = indentAt(s, 0);
  const rest = s.slice(idx);
  let end = -1, pre = false, type67 = false;
  let m = /^<(script|pre|style|textarea)[\s>]/i.exec(rest);
  if (m) {
    pre = true;
    const close = new RegExp(`</${m[1]}>`, 'i').exec(rest);
    if (close) {
      const e = lineEnd(rest, close.index + close[0].length);
      end = e + 1;
    } else end = rest.length;
  } else if (rest.startsWith('<!--')) {
    const c = rest.indexOf('-->');
    end = c === -1 ? rest.length : lineEnd(rest, c + 3) + 1;
  } else if (rest.startsWith('<?')) {
    const c = rest.indexOf('?>');
    end = c === -1 ? rest.length : lineEnd(rest, c + 2) + 1;
  } else if (/^<![A-Za-z]/.test(rest)) {
    const c = rest.indexOf('>');
    end = c === -1 ? rest.length : lineEnd(rest, c + 1) + 1;
  } else if (rest.startsWith('<![CDATA[')) {
    const c = rest.indexOf(']]>');
    end = c === -1 ? rest.length : lineEnd(rest, c + 3) + 1;
  } else {
    // Type 6 (block tag, ends at a blank line) or type 7 (a complete
    // tag on its own line, ends at a blank line).
    type67 = true;
    const isTag6 = RE_BLOCK_TAG.test(rest);
    const isTag7 = /^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*\s*\/?>/.test(rest) ||
      /^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>/.test(rest);
    if (!isTag6 && !isTag7) return null;
    if (isTag7) {
      // The whole first line must be the tag (plus spaces/tabs).
      const e = lineEnd(rest, 0);
      const line = rest.slice(0, e);
      if (!/^<[a-zA-Z][a-zA-Z0-9-]*(?:\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?)*\s*\/?>[ \t]*$/.test(line) &&
          !/^<\/[a-zA-Z][a-zA-Z0-9-]*\s*>[ \t]*$/.test(line)) {
        if (!isTag6) return null;
      }
    }
    // Scan to the first blank line.
    let i = 0;
    end = rest.length;
    while (i < rest.length) {
      const e = lineEnd(rest, i);
      if (isBlank(rest, i)) { end = i; break; }
      i = e + 1;
    }
    // The reference match also swallows the blank lines that follow, so
    // that ge() can trim them; the consumed length is the trimmed raw,
    // so those blank lines stay in the input for the space rule.
    while (end < rest.length && isBlank(rest, end)) end = lineEnd(rest, end) + 1;
  }
  if (end > rest.length) end = rest.length;
  if (!type67) {
    // Types 1-5 end with (\n+|$) / [^\n]*\n*: the match takes all
    // consecutive newlines after the closing line; ge() then decides
    // whether the trailing newline survives.
    while (end < rest.length && rest[end] === '\n') end++;
  }
  let raw = s.slice(0, idx + end);
  raw = trimBlankTail(raw);
  return { node: { t: 'html', text: raw, pre }, len: raw.length };
}

// Link reference definition at the start of s. Returns {def, len} or null.
function tryDef(s) {
  const { col, idx } = indentAt(s, 0);
  if (col > 3) return null;
  if (s[idx] !== '[') return null;
  const labelM = RE_LE.exec(s.slice(idx + 1));
  if (!labelM) return null;
  const label = labelM[0];
  let j = idx + 1 + label.length;
  if (s[j] !== ']') return null;
  j++;
  if (s[j] !== ':') return null;
  j++;
  // Optional spaces, or a newline + spaces.
  let k = j;
  while (s[k] === ' ' || s[k] === '\t') k++;
  if (s[k] === '\n') { k++; while (s[k] === ' ' || s[k] === '\t') k++; }
  // Href: <...> or a run of non-space characters.
  let href = '';
  let angled = false;
  if (s[k] === '<') {
    angled = true;
    let e = k + 1;
    while (e < s.length && s[e] !== '>' && s[e] !== '\n') {
      if (s[e] === '\\') e++;
      e++;
    }
    if (s[e] !== '>') return null;
    href = s.slice(k + 1, e);
    k = e + 1;
  } else {
    let e = k;
    while (e < s.length && s[e] !== ' ' && s[e] !== '\t' && s[e] !== '\n') e++;
    href = s.slice(k, e);
    if (!href) return null;
    k = e;
  }
  // The href must have balanced parens unless angle-bracketed.
  if (!angled && parenClose(href) !== -1) return null;
  // Optional title: it needs a separator first — spaces (optionally
  // followed by a newline + spaces), or a newline + spaces. The title
  // itself: a " title may span lines; a ' title may span one newline
  // but not a blank line; a ( title may span lines but not contain an
  // unescaped '('.
  let title = null, end = k;
  let t = k, sep = false;
  while (s[t] === ' ' || s[t] === '\t') { t++; sep = true; }
  if (s[t] === '\n') {
    let t2 = t + 1;
    while (s[t2] === ' ' || s[t2] === '\t') t2++;
    if (s[t2] === '"' || s[t2] === "'" || s[t2] === '(') { t = t2; sep = true; }
  }
  if (sep && (s[t] === '"' || s[t] === "'" || s[t] === '(')) {
    const q = s[t] === '(' ? ')' : s[t];
    let e = t + 1, ok = false;
    while (e < s.length) {
      if (s[e] === '\\') { e += 2; continue; }
      if (s[e] === q) { ok = true; break; }
      if (q === "'" && s[e] === '\n' && s[e + 1] === '\n') break;
      if (q === ')' && s[e] === '(') break;
      e++;
    }
    if (ok) {
      const titleText = s.slice(t + 1, e);
      title = titleText.replace(RE_UNESCAPE_PUNCT, '$1');
      end = e + 1;
    }
  }
  // After the href/title only spaces may follow, then a newline or the
  // end of the input; anything else invalidates the definition. If the
  // title fails that check, the title group does not match and the
  // definition falls back to having no title.
  let e2 = end;
  while (s[e2] === ' ' || s[e2] === '\t') e2++;
  if (e2 < s.length && s[e2] !== '\n') {
    if (title !== null) {
      title = null; end = k;
      e2 = end;
      while (s[e2] === ' ' || s[e2] === '\t') e2++;
      if (e2 < s.length && s[e2] !== '\n') return null;
    } else return null;
  }
  let len = e2;
  while (s[len] === '\n') len++;
  const rawFull = s.slice(0, len);
  const raw = rawFull.replace(/\n+$/, '');
  href = href.replace(RE_UNESCAPE_PUNCT, '$1');
  return { def: { tag: normLabel(label), href, title }, raw, len: raw.length };
}

// Table at the start of s. Returns {node, len} or null.
function tryTable(s, links) {
  const e0 = lineEnd(s, 0);
  const headerLine = s.slice(0, e0);
  if (/^ *$/.test(headerLine)) return null;
  if (/^ /.test(headerLine) && !/^ {0,3}\S/.test(headerLine)) return null;
  const firstNonSpace = headerLine.search(/\S/);
  if (firstNonSpace === -1 || firstNonSpace > 3) return null;
  const e1 = e0 + 1;
  if (e1 >= s.length) return null;
  const e2 = lineEnd(s, e1);
  const delimLine = s.slice(e1, e2);
  if (!/^ {0,3}(?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?[ \t]*$/.test(delimLine)) return null;
  if (!/[:|]/.test(delimLine)) return null;
  const header = splitRow(headerLine);
  const delim = splitRow(delimLine.replace(/^\||\| *$/g, ''));
  const delimCells = delimLine.replace(/^\||\| *$/g, '').split('|');
  if (header.length !== delimCells.length) return null;
  const align = delimCells.map(cell => {
    const c = cell.trim();
    if (/^ *-+: *$/.test(cell)) return 'right';
    if (/^ *:-+: *$/.test(cell)) return 'center';
    if (/^ *:-+ *$/.test(cell)) return 'left';
    return null;
  });
  const rows = [];
  let i = e2 + 1, consumed = e2 + 1;
  while (i < s.length) {
    const e = lineEnd(s, i);
    const line = s.slice(i, e);
    // A row line must not be spaces-only (the reference's row lookahead
    // excludes ` *\n` only — a tab-only line IS a row, with empty cells),
    // and must not start another block or an indented code line.
    if (/^ *$/.test(line)) break;
    if (/^(?: {4}| {0,3}\t)[^\n]/.test(line)) break;
    if (isHrStart(s, i) || isAtxStart(s, i) || isBlockquoteStart(s, i) || isFenceStart(s, i) || isListStart(s, i) || isHtmlStart(s, i)) break;
    rows.push(splitRow(line, header.length));
    i = e + 1; consumed = i;
  }
  return { node: { t: 'table', header: header.map((h, k) => ({ text: h, align: align[k] })), align, rows: rows.map(r => r.map((c, k) => ({ text: c, align: align[k] }))) }, len: consumed };
}

// Paragraph (top only) or plain text. Returns {node, len} or null.
// Handles setext headings: a paragraph followed by an = / - underline
// becomes a heading.
function tryParagraph(s, links, top) {
  const e0 = lineEnd(s, 0);
  if (isBlank(s, 0)) return null;
  if (!top) {
    // Inside a container the reference's text rule takes a single line;
    // the other rules (list, fence, ...) get a chance on the next line,
    // and consecutive text lines merge in blockTokens. A setext
    // underline after the first line still makes a heading.
    const first = s.slice(0, e0);
    const i = e0 + 1;
    if (i < s.length && isSetextLine(s, i)) {
      const e = lineEnd(s, i);
      const underline = s.slice(i, e).trim();
      const depth = underline.charAt(0) === '=' ? 1 : 2;
      return { node: { t: 'h', depth, text: first.trim() }, len: e };
    }
    return { node: { t: 'text', text: first }, len: e0 };
  }
  const lines = [s.slice(0, e0)];
  let i = e0 + 1;
  while (i < s.length) {
    if (isBlank(s, i)) {
      // A whitespace-only line ends the paragraph — unless it is the
      // last line (no newline after it), in which case the reference's
      // paragraph pattern still takes it as a continuation line.
      if (lineEnd(s, i) !== s.length) break;
      lines.push(s.slice(i, lineEnd(s, i)));
      i = lineEnd(s, i) + 1;
      continue;
    }
    if (isSetextLine(s, i)) break;
    // Inside a container (top=false) an indented-code line is not a
    // paragraph continuation: the code rule takes it and merges the
    // dedented content into the text. At the top level it stays in the
    // paragraph.
    if (!top && indentAt(s, i).col >= 4) break;
    // Table: this line + the next form a header + delimiter row.
    if (top) {
      const eN = lineEnd(s, i);
      const nextLine = s.slice(i, eN);
      const after = eN + 1;
      if (after <= s.length) {
        const eD = lineEnd(s, after);
        const delimLine = s.slice(after, eD);
        if (/^ {0,3}(?:\| *)?:?-+:? *(?:\| *:?-+:? *)*(?:\| *)?[ \t]*$/.test(delimLine) && /[:|]/.test(delimLine)) break;
      }
    }
    if (interruptsPara(s, i)) break;
    lines.push(s.slice(i, lineEnd(s, i)));
    i = lineEnd(s, i) + 1;
  }
  const text = lines.join('\n');
  const consumed = i - 1; // up to the end of the last line (no trailing \n)
  // Setext heading? Works inside containers too (a list item's text can
  // be a setext heading).
  if (i < s.length && isSetextLine(s, i)) {
    const e = lineEnd(s, i);
    const underline = s.slice(i, e).trim();
    const depth = underline.charAt(0) === '=' ? 1 : 2;
    return { node: { t: 'h', depth, text: text.trim() }, len: e };
  }
  if (!top) return { node: { t: 'text', text }, len: consumed };
  return { node: { t: 'p', text }, len: consumed };
}

// The block lexer. `mergePara` merges a paragraph into the previous
// paragraph (used for blockquote chunks). Returns {nodes, hadSpace}.
function blockTokens(s, links, top, mergePara, out) {
  const nodes = out || [];
  let hadSpace = false;
  let rest = s;
  while (rest) {
    // Blank lines. A run longer than one character is a space token: it
    // separates the next block from the previous one (so text nodes do
    // not merge across it). A run with two or more newlines also marks
    // the container as having space (loose lists).
    const br = blankRun(rest);
    let separated = false;
    if (br > 0) {
      const run = rest.slice(0, br);
      if ((run.match(/\n/g) || []).length >= 2) hadSpace = true;
      separated = run.length > 1;
      rest = rest.slice(br);
      if (!rest) break;
    }
    const prev = nodes[nodes.length - 1];
    // Indented code (merges into a preceding paragraph/text).
    let r = tryIndentedCode(rest);
    if (r) {
      if (prev && (prev.t === 'p' || prev.t === 'text') && !separated) prev.text += '\n' + r.node.text;
      else nodes.push(r.node);
      rest = rest.slice(r.len);
      continue;
    }
    r = tryFences(rest);
    if (r) { nodes.push(r.node); rest = rest.slice(r.len); continue; }
    r = tryAtx(rest);
    if (r) { nodes.push(r.node); rest = rest.slice(r.len); continue; }
    r = tryHr(rest);
    if (r) { nodes.push(r.node); rest = rest.slice(r.len); continue; }
    r = tryBlockquote(rest, links);
    if (r) { nodes.push(r.node); rest = rest.slice(r.len); continue; }
    r = tryList(rest, links);
    if (r) { nodes.push(r.node); rest = rest.slice(r.len); continue; }
    r = tryHtml(rest);
    if (r) { nodes.push(r.node); rest = rest.slice(r.len); continue; }
    // Link reference definition.
    const d = tryDef(rest);
    if (d) {
      if (prev && (prev.t === 'p' || prev.t === 'text') && !separated) {
        prev.text += '\n' + d.raw;
      } else {
        if (!links[d.def.tag]) links[d.def.tag] = { href: d.def.href, title: d.def.title };
        nodes.push({ t: 'def' });
      }
      rest = rest.slice(d.len);
      continue;
    }
    r = tryTable(rest, links);
    if (r) { nodes.push(r.node); rest = rest.slice(r.len); continue; }
    // Paragraph / setext / text.
    r = tryParagraph(rest, links, top);
    if (r) {
      if (mergePara && r.node.t === 'p' && prev && prev.t === 'p' && !separated) {
        prev.text += '\n' + r.node.text;
      } else if (!top && r.node.t === 'text' && prev && prev.t === 'text' && !separated) {
        prev.text += '\n' + r.node.text;
      } else {
        nodes.push(r.node);
      }
      rest = rest.slice(r.len);
      // Consume the single newline after the paragraph (the space rule
      // would eat it next iteration; keep it simple by slicing it here
      // only when it is not followed by a blank line).
      if (rest.charAt(0) === '\n' && rest.charAt(1) !== '\n') rest = rest.slice(1);
      continue;
    }
    // Fallback: one line as text (non-top) or as a paragraph (top).
    const e = lineEnd(rest, 0);
    const line = rest.slice(0, e);
    if (!top && prev && prev.t === 'text' && !separated) prev.text += '\n' + line;
    else nodes.push(top ? { t: 'p', text: line } : { t: 'text', text: line });
    rest = rest.slice(e + 1 > rest.length ? rest.length : e + 1);
  }
  return { nodes, hadSpace };
}

// ---------------------------------------------------------------- renderer
function renderCheckbox(cb) {
  return '<input ' + (cb.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
}

// Block-level inline rendering: the raw-block flag is reset before each
// block's inline source, the in-link flag carries over.
function inl(text, links, st) {
  st.inRawBlock = false;
  return inline(text, links, st, false);
}

function renderCell(c, head, links, st) {
  const tag = head ? 'th' : 'td';
  const align = c.align ? ` align="${c.align}"` : '';
  return `<${tag}${align}>` + inl(c.text, links, st) + `</${tag}>\n`;
}

function renderTable(t, links, st) {
  let head = '';
  for (const c of t.header) head += renderCell(c, true, links, st);
  let body = '';
  for (const row of t.rows) {
    let cells = '';
    for (const c of row) cells += renderCell(c, false, links, st);
    body += `<tr>\n${cells}</tr>\n`;
  }
  if (body) body = `<tbody>${body}</tbody>`;
  return `<table>\n<thead>\n<tr>\n${head}</tr>\n</thead>\n${body}</table>\n`;
}

function renderNodes(nodes, links, st) {
  const out = [];
  for (const nd of nodes) {
    switch (nd.t) {
      case 'p':
        out.push('<p>' + (nd.prefix ? renderCheckbox(nd.prefix) : '') + inl(nd.text, links, st) + '</p>\n');
        break;
      case 'text':
        out.push(inl(nd.text, links, st));
        break;
      case 'h':
        out.push(`<h${nd.depth}>` + inl(nd.text, links, st) + `</h${nd.depth}>\n`);
        break;
      case 'code': {
        const lang = (nd.lang || '').match(/^\S*/)?.[0] || '';
        const text = nd.text ? nd.text.replace(/\n$/, '') + '\n' : '';
        out.push(lang ? `<pre><code class="language-${esc(lang)}">` + esc(text, true) + `</code></pre>\n`
          : `<pre><code>` + esc(text, true) + `</code></pre>\n`);
        break;
      }
      case 'html':
        out.push(nd.text);
        break;
      case 'hr':
        out.push('<hr>\n');
        break;
      case 'q':
        out.push('<blockquote>\n' + renderNodes(nd.nodes, links, st) + '</blockquote>\n');
        break;
      case 'list': {
        let s = '';
        for (const item of nd.items) s += `<li>${renderNodes(item.nodes, links, st)}</li>\n`;
        const tag = nd.ordered ? 'ol' : 'ul';
        const start = nd.ordered && nd.start !== 1 ? ` start="${nd.start}"` : '';
        out.push(`<${tag}${start}>\n` + s + `</${tag}>\n`);
        break;
      }
      case 'table':
        out.push(renderTable(nd, links, st));
        break;
      case 'checkbox':
        out.push(renderCheckbox(nd));
        break;
      case 'def':
        break;
    }
  }
  return out.join('');
}

export function parse(markdown) {
  const src = String(markdown).replace(/\r\n|\r/g, '\n');
  const links = Object.create(null);
  const { nodes } = blockTokens(src, links, true, false);
  const st = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true };
  return renderNodes(nodes, links, st);
}
