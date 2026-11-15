// A fast, dependency-free Markdown renderer: parse(markdown) returns exactly
// the HTML marked 18.1.3 renders with its default options (GFM on, breaks
// off, pedantic off, async off), byte for byte. Written from scratch:
// a line-based block parser (CommonMark 0.31.2 + GFM 0.29 extensions) and
// a delimiter-stack inline parser. Deterministic, no state kept between calls.

// ---- character helpers (char codes) ----
const CC_SPACE = 32, CC_TAB = 9, CC_LT = 60, CC_GT = 62, CC_AMP = 38,
  CC_QUOT = 34, CC_SQ = 39, CC_SLASH = 47, CC_BSLASH = 92, CC_TICK = 96,
  CC_STAR = 42, CC_US = 95, CC_TILDE = 126, CC_LB = 91, CC_RB = 93,
  CC_LP = 40, CC_RP = 41, CC_BANG = 33, CC_HASH = 35, CC_COLON = 58,
  CC_SEMI = 59, CC_EQ = 61, CC_DASH = 45, CC_PLUS = 43, CC_DOT = 46,
  CC_PIPE = 124, CC_CARET = 94, CC_PCT = 37;

// Document-wide anchor state (reset per parse() call): true while an
// inline <a> tag is open. While true, bare extended autolinks (URLs and
// emails) are NOT formed — marked suppresses them inside an open anchor
// — but angle autolinks <https://...> and markdown links still form.
// Set by an opening <a> tag, cleared by </a>. Only an <a> whose tag
// contains a literal space or "=" sets it (<a/> and <a\n/> do not).
let inAnchor = false;

function isSpace(c) { return c === CC_SPACE || c === CC_TAB; }
function isDigit(c) { return c >= 48 && c <= 57; }
function isAlpha(c) { return (c >= 65 && c <= 90) || (c >= 97 && c <= 122); }
function isAlnum(c) { return isAlpha(c) || isDigit(c); }
function isPunct(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) ||
    (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}
function isBlank(s) {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c !== CC_SPACE && c !== CC_TAB) return false;
  }
  return true;
}
// Count of leading spaces/tabs as columns (tab = next multiple of 4).
function indentOf(s) {
  let col = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === CC_SPACE) col++;
    else if (c === CC_TAB) col += 4 - (col % 4);
    else break;
  }
  return col;
}
// Index of first non-space/tab char.
function firstNonSpace(s) {
  let i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c !== CC_SPACE && c !== CC_TAB) break;
    i++;
  }
  return i;
}

// ---- HTML escaping ----
// Escape text or attribute content, except that an &-sequence that looks
// like an entity reference (&name; &#123; &#x1a;) is left alone. This is
// marked's escape behaviour (its no-encode form).
function esc(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === CC_AMP) {
      if (looksLikeEntity(s, i)) continue;
      rep = '&amp;';
    } else if (c === CC_LT) rep = '&lt;';
    else if (c === CC_GT) rep = '&gt;';
    else if (c === CC_QUOT) rep = '&quot;';
    else if (c === CC_SQ) rep = '&#39;';
    if (rep !== null) {
      out += s.slice(start, i) + rep;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}
// Raw escape for code blocks: every & becomes &amp; (even one that
// looks like an entity in the source: &amp; -> &amp;amp;).
function escRaw(s) {
  let out = '';
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === CC_AMP) rep = '&amp;';
    else if (c === CC_LT) rep = '&lt;';
    else if (c === CC_GT) rep = '&gt;';
    else if (c === CC_QUOT) rep = '&quot;';
    else if (c === CC_SQ) rep = '&#39;';
    if (rep !== null) {
      out += s.slice(start, i) + rep;
      start = i + 1;
    }
  }
  return start === 0 ? s : out + s.slice(start);
}
// Is the & at i the start of something that looks like an entity reference?
function looksLikeEntity(s, i) {
  let j = i + 1;
  if (s.charCodeAt(j) === CC_HASH) {
    j++;
    let hex = false;
    const c = s.charCodeAt(j);
    if (c === 120 || c === 88) { hex = true; j++; }
    let n = 0;
    while (j < s.length) {
      const d = s.charCodeAt(j);
      const ok = hex
        ? (d >= 48 && d <= 57) || (d >= 97 && d <= 102) || (d >= 65 && d <= 70)
        : (d >= 48 && d <= 57);
      if (!ok) break;
      n++; j++;
    }
    return n >= 1 && n <= (hex ? 6 : 7) && s.charCodeAt(j) === CC_SEMI;
  }
  let k = j;
  while (k < s.length && isAlnum(s.charCodeAt(k))) k++;
  return k > j && s.charCodeAt(k) === CC_SEMI;
}
// Decode a numeric character reference starting at i (& at s[i]).
// Returns {ch, next} or null when it is not a valid numeric reference.
// Valid: &#1-7 decimal digits; or &#x/&#X 1-6 hex digits; the value is
// replaced by U+FFFD when it is 0, a surrogate, or above U+10FFFF.
function decodeNumeric(s, i) {
  let j = i + 2; // skip &#
  let hex = false;
  const c = s.charCodeAt(j);
  if (c === 120 || c === 88) { hex = true; j++; }
  let n = 0, v = 0;
  while (j < s.length) {
    const d = s.charCodeAt(j);
    let dv = -1;
    if (d >= 48 && d <= 57) dv = d - 48;
    else if (hex && d >= 97 && d <= 102) dv = d - 87;
    else if (hex && d >= 65 && d <= 70) dv = d - 55;
    if (dv < 0) break;
    v = v * (hex ? 16 : 10) + dv;
    n++; j++;
  }
  if (n < 1 || n > (hex ? 6 : 7) || s.charCodeAt(j) !== CC_SEMI) return null;
  if (v === 0 || v > 0x10FFFF || (v >= 0xD800 && v <= 0xDFFF)) v = 0xFFFD;
  return { ch: String.fromCodePoint(v), next: j + 1 };
}

// ---- URL cleaning (for link hrefs and image srcs) ----
// marked's cleanUrl: encodeURI, then un-escape %25 back to %. It encodes
// non-ASCII (NBSP -> %C2%A0), ", <, >, `, {, }, |, ^, [, ]; ~ and the
// URL punctuation pass through. Throws on a lone surrogate -> null.
function cleanUrl(href) {
  if (!href) return href;
  try {
    return encodeURI(href).replace(/%25/g, '%');
  } catch (e) {
    return null;
  }
}

// ---- block parser ----
// Node types: doc, para, heading, code (indented), fence, quote, list,
// item, html, hr, table. Leaves hold `lines` (raw strings); containers
// hold `c` (children). `lastBlank` tracks whether the last line seen while
// the block was open was blank (used for list tightness).

function blk(t) {
  return { t, c: [], parent: null, open: true, lastBlank: false, lines: null };
}

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p param search section summary table tbody td tfoot th thead title tr track ul').split(' '));

// Advance `n` columns from (pos, col) in `line`; a tab is expanded to
// spaces when only partly consumed. Returns [line, pos, col].
function advanceCols(line, pos, col, n) {
  let p = pos, c = col;
  while (n > 0 && p < line.length) {
    const ch = line.charCodeAt(p);
    if (ch === CC_SPACE) { p++; c++; n--; }
    else if (ch === CC_TAB) {
      const adv = 4 - (c % 4);
      if (adv <= n) { p++; c += adv; n -= adv; }
      else {
        line = line.slice(0, p) + '        '.slice(0, adv) + line.slice(p + 1);
        p += n; c += n; n = 0;
      }
    } else break;
  }
  return [line, p, c];
}
// Expand tabs in code-block content to spaces, based on the absolute
// column. A tab at absolute column 0 is preserved (marked keeps it);
// any other tab advances to the next multiple of 4.
// Expand tabs that sit in the leading whitespace of a line (before the
// first non-whitespace character), based on the absolute column.
// Tabs after content are preserved (cm-003). Used for indented code:
// a tab in the leading whitespace past the 4-column indent is expanded
// by marked (e.g. "       \ty" in a list item becomes "  y"), while a
// tab after text stays a tab.
function expandLeadingTabs(s, col) {
  let i = 0, c = col, out = '';
  while (i < s.length) {
    const ch = s.charCodeAt(i);
    if (ch === CC_SPACE) { out += ' '; i++; c++; }
    else if (ch === CC_TAB) { const n = 4 - (c % 4); out += '    '.slice(0, n); c += n; i++; }
    else break;
  }
  return out + s.slice(i);
}
function expandCodeTabs(s, col) {
  if (col === 0 || s.indexOf('\t') === -1) return s;
  let out = '', c = col;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (ch === CC_TAB) { const n = 4 - (c % 4); out += '    '.slice(0, n); c += n; }
    else { out += s[i]; c++; }
  }
  return out;
}
// Columns of indentation of `line` starting at (pos, col).
function indentFrom(line, pos, col) {
  let c = col, p = pos;
  while (p < line.length) {
    const ch = line.charCodeAt(p);
    if (ch === CC_SPACE) { c++; p++; }
    else if (ch === CC_TAB) c += 4 - (c % 4), p++;
    else break;
  }
  return c - col;
}

// Is the line (from pos) a fenced-code start? Returns [fenceChar, len, info]
// or null. Info is the rest of the line, trimmed.
function fenceStart(line, pos) {
  const ch = line.charCodeAt(pos);
  if (ch !== CC_TICK && ch !== CC_TILDE) return null;
  let i = pos;
  while (line.charCodeAt(i) === ch) i++;
  const len = i - pos;
  if (len < 3) return null;
  const info = line.slice(i).trim();
  if (ch === CC_TICK && info.indexOf('`') !== -1) return null;
  return [ch, len, info];
}
// Is the line (from pos) a closing fence for `fenceChar`/`flen`?
function fenceEnd(line, pos, fenceChar, flen) {
  let i = pos;
  while (line.charCodeAt(i) === CC_SPACE) i++;
  if (line.charCodeAt(i) !== fenceChar) return false;
  let j = i;
  while (line.charCodeAt(j) === fenceChar) j++;
  if (j - i < flen) return false;
  while (j < line.length) {
    if (line.charCodeAt(j) !== CC_SPACE && line.charCodeAt(j) !== CC_TAB) return false;
    j++;
  }
  return true;
}
// Is the line (from pos) an ATX heading? Returns [level, content] or null.
function atxHeading(line, pos) {
  let i = pos;
  if (line.charCodeAt(i) !== CC_HASH) return null;
  let level = 0;
  while (line.charCodeAt(i) === CC_HASH) { level++; i++; }
  if (level > 6) return null;
  const c = line.charCodeAt(i);
  if (c !== CC_SPACE && c !== CC_TAB && i < line.length) return null;
  let content = line.slice(i).trim();
  // Strip a closing sequence of #'s preceded by a space, or the
  // whole content when it is only #'s (### ### -> empty heading).
  if (content.length > 0 && content.charCodeAt(content.length - 1) === CC_HASH) {
    let j = content.length - 1;
    while (j >= 0 && content.charCodeAt(j) === CC_HASH) j--;
    if (j < 0 || content.charCodeAt(j) === CC_SPACE || content.charCodeAt(j) === CC_TAB) {
      content = content.slice(0, j + 1).trim();
    }
  }
  return [level, content];
}
// Is the line (from pos) a thematic break?
function isThematicBreak(line, pos) {
  let i = pos, ch = 0, n = 0;
  while (i < line.length) {
    const c = line.charCodeAt(i);
    if (c === CC_SPACE || c === CC_TAB) { i++; continue; }
    if (ch === 0) { if (c === CC_STAR || c === CC_DASH || c === CC_US) ch = c; else return false; }
    if (c !== ch) return false;
    n++; i++;
  }
  return n >= 3;
}
// Is the line (from pos) a setext heading underline? Returns 1 or 2 or 0.
// The underline is a solid run of = (level 1) or - (level 2), with only
// trailing spaces/tabs after it; spaces BETWEEN the marks disqualify it
// (= = and --- - are not underlines).
function setextLevel(line, pos) {
  let i = pos;
  const ch = line.charCodeAt(i);
  if (ch !== CC_EQ && ch !== CC_DASH) return 0;
  let n = 0;
  while (i < line.length && line.charCodeAt(i) === ch) { n++; i++; }
  while (i < line.length && (line.charCodeAt(i) === CC_SPACE || line.charCodeAt(i) === CC_TAB)) i++;
  if (i !== line.length) return 0;
  return n >= 1 ? (ch === CC_EQ ? 1 : 2) : 0;
}
// HTML block start: returns the block type (1-7) or 0.
function htmlBlockType(line, pos) {
  if (line.charCodeAt(pos) !== CC_LT) return 0;
  const rest = line.slice(pos + 1);
  const lower = rest.toLowerCase();
  if (lower.startsWith('script') || lower.startsWith('pre') || lower.startsWith('style') || lower.startsWith('textarea')) {
    const c = rest.charCodeAt(lower.startsWith('script') ? 6 : lower.startsWith('textarea') ? 8 : lower.startsWith('style') ? 5 : 3);
    if (c === undefined || c === CC_SPACE || c === CC_TAB || c === CC_GT || c === CC_SLASH) return 1;
    if (rest.length === (lower.startsWith('script') ? 6 : lower.startsWith('textarea') ? 8 : lower.startsWith('style') ? 5 : 3)) return 1;
  }
  if (rest.startsWith('!--')) return 2;
  if (rest.startsWith('?')) return 3;
  if (rest.startsWith('!')) {
    const c = rest.charCodeAt(1);
    if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) return 4;
  }
  if (rest.startsWith('![CDATA[')) return 5;
  // Type 6: block-level tag.
  let m = /^<\/?([A-Za-z][A-Za-z0-9-]*)(\s|\/?>|$)/.exec(line.slice(pos));
  if (m && BLOCK_TAGS.has(m[1].toLowerCase())) return 6;
  // Type 7: a single complete tag, whole line. Must be a valid tag
  // (a tag name followed by attributes, not arbitrary punctuation):
  // <http://foo.bar.baz> is an autolink, not an html block.
  const tag = matchHtmlTag(line, pos);
  if (tag && line.slice(pos + tag.length).trim() === '') return 7;
  return 0;
}
// Is the line (from pos) a table delimiter row? Returns alignments or null.
// Alignments: 'l' | 'c' | 'r' | null per cell. Requires at least one |.
function tableDelimiter(line, pos) {
  let s = line.slice(pos).trim();
  if (s.indexOf('|') === -1) return null;
  if (s.charCodeAt(0) === CC_PIPE) s = s.slice(1);
  if (s.charCodeAt(s.length - 1) === CC_PIPE) s = s.slice(0, -1);
  const cells = s.split('|');
  const aligns = [];
  for (let cell of cells) {
    cell = cell.trim();
    if (!/^:?-+:?$/.test(cell)) return null;
    const left = cell.charCodeAt(0) === CC_COLON;
    const right = cell.charCodeAt(cell.length - 1) === CC_COLON;
    aligns.push(left && right ? 'c' : left ? 'l' : right ? 'r' : null);
  }
  return aligns.length ? aligns : null;
}
// Split a table row line into cells (unescaped | splits; \| is literal).
function splitTableRow(line) {
  let s = line.trim();
  if (s.charCodeAt(0) === CC_PIPE) s = s.slice(1);
  if (s.charCodeAt(s.length - 1) === CC_PIPE) s = s.slice(0, -1);
  const cells = [];
  let cur = '', i = 0;
  while (i < s.length) {
    const c = s.charCodeAt(i);
    if (c === CC_BSLASH && s.charCodeAt(i + 1) === CC_PIPE) { cur += '|'; i += 2; continue; }
    if (c === CC_PIPE) { cells.push(cur.trim()); cur = ''; i++; continue; }
    cur += s[i]; i++;
  }
  cells.push(cur.trim());
  return cells;
}

// Parse a link reference definition starting at the beginning of `text`
// (the paragraph's raw content). Returns {label, dest, title, end} or null.
// `end` is the index just past the definition (at a line end).
function parseRefDef(text, start) {
  let i = start;
  // Up to 3 spaces of indentation (handled by caller: text starts at line start).
  if (text.charCodeAt(i) !== CC_LB) return null;
  const label = parseLinkLabel(text, i);
  if (!label) return null;
  i = label.next;
  if (text.charCodeAt(i) !== CC_COLON) return null;
  i++;
  i = skipWsNl(text, i);
  const dest = parseLinkDest(text, i);
  if (!dest) return null;
  i = dest.next;
  // After the destination a title may follow on the same line
  // (separated by spaces/tabs) or on the next line. A malformed title
  // on the same line invalidates the definition; a malformed title on
  // the next line just means there is no title.
  let title = null;
  let end = i;
  let k = i;
  while (k < text.length && (text.charCodeAt(k) === CC_SPACE || text.charCodeAt(k) === CC_TAB)) k++;
  if (k < text.length && text.charCodeAt(k) === 10) {
    // The destination's line ends here. Try a title on the next line.
    let j = k + 1;
    while (j < text.length && (text.charCodeAt(j) === CC_SPACE || text.charCodeAt(j) === CC_TAB)) j++;
    const t = parseLinkTitle(text, j);
    if (t) {
      let m = t.next;
      while (m < text.length && (text.charCodeAt(m) === CC_SPACE || text.charCodeAt(m) === CC_TAB)) m++;
      if (m >= text.length || text.charCodeAt(m) === 10) { title = t.title; end = m; }
      else end = k;
    } else end = k;
  } else if (k < text.length) {
    // Same line: a title must follow, separated by whitespace.
    if (k === i) return null;
    const t = parseLinkTitle(text, k);
    if (!t) return null;
    let m = t.next;
    while (m < text.length && (text.charCodeAt(m) === CC_SPACE || text.charCodeAt(m) === CC_TAB)) m++;
    if (m < text.length && text.charCodeAt(m) !== 10) return null;
    title = t.title; end = m;
  } else {
    end = k;
  }
  return { label: label.label, dest: dest.dest, title, end };
}
function skipWsNl(text, i) {
  while (i < text.length) {
    const c = text.charCodeAt(i);
    if (c === CC_SPACE || c === CC_TAB || c === 10) i++;
    else break;
  }
  return i;
}
// Parse a link label [ ... ] at i (text[i] === '['). Returns {label, next} or null.
// The label is normalized (case-folded, whitespace collapsed) for lookup,
// and kept raw for the lookup key.
// Normalize a link label for lookup: collapse whitespace, trim,
// Unicode case fold (ß and ẞ both fold to ss).
function normLabel(str) {
  return str.replace(/\s+/g, ' ').trim().toLowerCase().replace(/ß/g, 'ss').replace(/ẞ/g, 'ss');
}
function parseLinkLabel(text, i) {
  if (text.charCodeAt(i) !== CC_LB) return null;
  // A label cannot contain an unescaped [ (even a balanced one:
  // [[foo]]: /url is not a reference definition). A backslash is
  // kept literally in the label for matching ([foo\!] does not
  // match the definition [foo!]), but a \] is still an escape for
  // the purpose of finding the label's end (it does not close it).
  let j = i + 1, raw = '';
  while (j < text.length) {
    const c = text.charCodeAt(j);
    if (c === CC_BSLASH && j + 1 < text.length) { raw += text[j] + text[j + 1]; j += 2; continue; }
    if (c === CC_LB) return null;
    if (c === CC_RB) {
      const label = normLabel(raw);
      if (label.length === 0 || label.length > 999) return null;
      return { label, next: j + 1 };
    }
    raw += text[j]; j++;
  }
  return null;
}
// Parse a link destination at i. Returns {dest, next} or null.
function parseLinkDest(text, i) {
  if (text.charCodeAt(i) === CC_LT) {
    let j = i + 1, dest = '';
    while (j < text.length) {
      const c = text.charCodeAt(j);
      if (c === CC_GT) return { dest, next: j + 1 };
      if (c === CC_LT || c === 10) return null;
      if (c === CC_BSLASH && j + 1 < text.length && isPunct(text.charCodeAt(j + 1))) { dest += text[j + 1]; j += 2; continue; }
      dest += text[j]; j++;
    }
    return null;
  }
  let j = i, dest = '', parens = 0;
  while (j < text.length) {
    const c = text.charCodeAt(j);
    if (c === CC_SPACE || c === CC_TAB || c === 10) break;
    if (c === CC_BSLASH && j + 1 < text.length && isPunct(text.charCodeAt(j + 1))) { dest += text[j + 1]; j += 2; continue; }
    if (c === CC_LP) { parens++; dest += text[j]; j++; continue; }
    if (c === CC_RP) {
      if (parens === 0) break;
      parens--; dest += text[j]; j++; continue;
    }
    dest += text[j]; j++;
  }
  if (dest.length === 0) return null;
  return { dest, next: j };
}
// Parse a link title at i. Returns {title, next} or null.
function parseLinkTitle(text, i) {
  const c = text.charCodeAt(i);
  let close = -1, j;
  if (c === CC_QUOT) close = CC_QUOT;
  else if (c === CC_SQ) close = CC_SQ;
  else if (c === CC_LP) close = CC_RP;
  else return null;
  j = i + 1;
  let title = '';
  while (j < text.length) {
    const ch = text.charCodeAt(j);
    if (ch === close) {
      if (close === CC_RP && title.indexOf('(') !== -1 && !title.endsWith('\\(')) {
        // A ( title may not contain an unescaped (.
        return null;
      }
      return { title, next: j + 1 };
    }
    if (ch === CC_BSLASH && j + 1 < text.length && isPunct(text.charCodeAt(j + 1))) { title += text[j + 1]; j += 2; continue; }
    title += text[j]; j++;
  }
  return null;
}

// ---- block structure: the two-phase line walk ----
// Does the line contain the closing tag for a type-1 html block
// (pre/script/style/textarea)? Case-insensitive.
function htmlType1End(line, closeTag) {
  if (!closeTag) return false;
  const lower = line.toLowerCase();
  const needle = '</' + closeTag;
  let at = lower.indexOf(needle);
  while (at !== -1) {
    const c = lower.charCodeAt(at + needle.length);
    if (c === undefined || c === CC_SPACE || c === CC_TAB || c === CC_GT || c === CC_SLASH) return true;
    at = lower.indexOf(needle, at + 1);
  }
  return false;
}
function htmlEndHit(htype, line) {
  if (htype === 2) return line.indexOf('-->') !== -1;
  if (htype === 3) return line.indexOf('?>') !== -1;
  if (htype === 4) return line.indexOf('>') !== -1;
  if (htype === 5) return line.indexOf(']]>') !== -1;
  return false;
}
function endsWithBlank(b) {
  let cur = b;
  while (cur) {
    if (cur.lastBlank) return true;
    if (cur.t === 'list' || cur.t === 'item') cur = cur.c.length ? cur.c[cur.c.length - 1] : null;
    else return false;
  }
  return false;
}
// Parse a list item start in `s` at first-non-space `fns`.
// Returns {ordered, bullet, delim, start, contentIndent, contentPos, empty} or null.
function listStart(s, fns) {
  const c0 = s.charCodeAt(fns);
  let ordered = false, bullet = 0, delim = 0, start = 1, markerLen = 0;
  if (c0 === CC_DASH || c0 === CC_PLUS || c0 === CC_STAR) {
    bullet = c0; markerLen = 1;
  } else if (isDigit(c0)) {
    let j = fns, num = 0, digits = 0;
    while (j < s.length && isDigit(s.charCodeAt(j))) { num = num * 10 + (s.charCodeAt(j) - 48); digits++; j++; }
    if (digits === 0 || digits > 9) return null;
    const d = s.charCodeAt(j);
    if (d !== CC_DOT && d !== CC_RP) return null;
    ordered = true; delim = d; start = num; markerLen = digits + 1;
  } else return null;
  const baseIndent = indentFrom(s, 0, 0);
  const after = fns + markerLen;
  if (after >= s.length) {
    return { ordered, bullet, delim, start, contentIndent: baseIndent + markerLen + 1, contentPos: s.length, empty: true };
  }
  const nc = s.charCodeAt(after);
  if (nc !== CC_SPACE && nc !== CC_TAB) return null;
  let p = after, col = baseIndent + markerLen, spaces = 0;
  while (p < s.length) {
    const ch = s.charCodeAt(p);
    if (ch === CC_SPACE) { spaces++; p++; col++; }
    else if (ch === CC_TAB) { const adv = 4 - (col % 4); spaces += adv; p++; col += adv; }
    else break;
  }
  if (p >= s.length) {
    return { ordered, bullet, delim, start, contentIndent: baseIndent + markerLen + 1, contentPos: s.length, empty: true };
  }
  if (spaces >= 1 && spaces <= 4) {
    return { ordered, bullet, delim, start, contentIndent: baseIndent + markerLen + spaces, contentPos: p, empty: false };
  }
  const adv = advanceCols(s, after, baseIndent + markerLen, 1);
  return { ordered, bullet, delim, start, contentIndent: baseIndent + markerLen + 1, contentPos: adv[1], empty: false, line: adv[0] };
}
function listSameType(list, li) {
  if (list.ordered !== li.ordered) return false;
  return li.ordered ? list.delim === li.delim : list.bullet === li.bullet;
}

function parseBlocks(lines) {
  const doc = blk('doc');
  const refs = new Map();
  let open = [doc];

  function addChild(parent, child) {
    child.parent = parent;
    parent.c.push(child);
    // A blank line seen since the last block in this item (or between
    // items of this list) makes the list loose — but only when a new
    // block actually follows the blank line. A trailing blank line
    // that ends the list never triggers this.
    if (parent.t === 'item') {
      if (parent.pendingBlank) { parent.parent.loose = true; parent.pendingBlank = false; }
      if (parent.parent.pendingBlank) { parent.parent.loose = true; parent.parent.pendingBlank = false; }
    } else if (parent.t === 'list') {
      if (parent.pendingBlank) { parent.loose = true; parent.pendingBlank = false; }
      // A blank line at the end of the previous item (set on that item)
      // also makes the list loose when the next item arrives.
      const prev = parent.c[parent.c.length - 1];
      if (prev && prev.pendingBlank) { parent.loose = true; prev.pendingBlank = false; }
    }
    return child;
  }
  function isLeaf(b) {
    return b.t === 'para' || b.t === 'heading' || b.t === 'code' || b.t === 'fence' || b.t === 'html' || b.t === 'hr' || b.t === 'table';
  }
  function extractRefDefs(b) {
    const text = b.lines.join('\n');
    let pos = 0, anyDef = false;
    b.gone = false;
    while (pos < text.length) {
      let p = pos, col = 0;
      while (p < text.length && (text.charCodeAt(p) === CC_SPACE || text.charCodeAt(p) === CC_TAB)) {
        if (text.charCodeAt(p) === CC_SPACE) col++;
        else col += 4 - (col % 4);
        if (col > 3) break;
        p++;
      }
      if (col > 3) break;
      const def = parseRefDef(text, p);
      if (!def) break;
      anyDef = true;
      if (!refs.has(def.label)) refs.set(def.label, { dest: def.dest, title: def.title });
      pos = def.end;
      if (text.charCodeAt(pos) === 10) pos++;
      else break;
    }
    if (anyDef) {
      const rest = text.slice(pos);
      if (rest.trim() === '') { b.text = ''; b.gone = true; }
      else b.text = rest;
    } else {
      b.text = text;
    }
  }
  function finalize(b) {
    if (b.t === 'para') extractRefDefs(b);
    else if (b.t === 'list') {
      let tight = !b.loose;
      if (tight) {
        outer: for (let i = 0; i < b.c.length; i++) {
          const item = b.c[i];
          // An item ending in a blank line before another item makes
          // the list loose, even when the item itself is empty.
          if (endsWithBlank(item) && i < b.c.length - 1) { tight = false; break; }
          for (let j = 0; j < item.c.length; j++) {
            const child = item.c[j];
            if ((i < b.c.length - 1 || j < item.c.length - 1) && endsWithBlank(child)) { tight = false; break outer; }
          }
        }
      }
      b.tight = tight;
    } else if (b.t === 'code') {
      while (b.lines.length && isBlank(b.lines[b.lines.length - 1])) b.lines.pop();
    } else if (b.t === 'fence') {
      // A fenced code block drops exactly one trailing EMPTY line:
      // two trailing empty lines leave one (cm-318), one leaves none
      // (doc-03). A whitespace-only line with spaces is not empty
      // and is kept (cm-129). (Indented code drops all blank lines.)
      if (b.lines.length && b.lines[b.lines.length - 1] === '') b.lines.pop();
    }
  }
  function closeBlocks(toDepth) {
    while (open.length > toDepth) {
      const b = open.pop();
      b.open = false;
      finalize(b);
      if (b.t === 'para' && b.gone) {
        const p = b.parent, idx = p.c.indexOf(b);
        if (idx !== -1) p.c.splice(idx, 1);
      }
    }
  }
  // Does `s` (from its first non-space) start a block that can interrupt
  // a paragraph? (Fence, HTML types 1-6, thematic break, ATX heading,
  // blockquote, or a list that may interrupt.)
  function canInterrupt(s) {
    const fns = firstNonSpace(s);
    if (indentFrom(s, 0, 0) > 3) return false;
    if (fenceStart(s, fns)) return true;
    const ht = htmlBlockType(s, fns);
    if (ht >= 1 && ht <= 6) return true;
    if (isThematicBreak(s, fns)) return true;
    if (atxHeading(s, fns)) return true;
    if (s.charCodeAt(fns) === CC_GT) return true;
    const li = listStart(s, fns);
    if (li && !li.empty && (!li.ordered || li.start === 1)) return true;
    return false;
  }
  // Does `s` start any block at all (used to defeat lazy continuation)?
  // Any list item counts here, as do fences, HTML types 1-6, thematic
  // breaks, ATX headings and blockquotes; indented code and HTML type 7
  // do not.
  function startsBlock(s) {
    const fns = firstNonSpace(s);
    if (indentFrom(s, 0, 0) > 3) return false;
    if (fenceStart(s, fns)) return true;
    const ht = htmlBlockType(s, fns);
    if (ht >= 1 && ht <= 6) return true;
    if (isThematicBreak(s, fns)) return true;
    if (atxHeading(s, fns)) return true;
    if (s.charCodeAt(fns) === CC_GT) return true;
    if (listStart(s, fns)) return true;
    return false;
  }
  // Start new blocks in `container` for the line remainder `s`.
  // `li` is the index of the line in the document (for html trailing \n).
  function startBlocks(container, s, lineIdx, sCol) {
    let cur = container;
    let content = s;
    let col0 = sCol || 0;
    // Whether the original line remainder was blank. After a marker
    // is consumed the content can become blank (an empty item "-"),
    // but the LINE was not blank, so lastBlank must stay false.
    const sBlank = isBlank(s);
    for (;;) {
      if (isBlank(content)) {
        for (const b of open) b.lastBlank = sBlank;
        return;
      }
      for (const b of open) b.lastBlank = false;
      // A list only accepts a same-type list item; any other block
      // closes the list and is created in its parent. A thematic
      // break is not a list item even when it starts with * (so
      // "* * *" ends the list instead of adding an item).
      if (cur.t === 'list') {
        const fns0 = firstNonSpace(content);
        const ind0 = indentFrom(content, 0, col0);
        if (ind0 <= 3 && isThematicBreak(content, fns0)) {
          const oldList = cur;
          open.pop();
          oldList.open = false;
          finalize(oldList);
          cur = oldList.parent;
          continue;
        }
        const li0 = ind0 <= 3 ? listStart(content, fns0) : null;
        if (!li0 || !listSameType(cur, li0)) {
          const oldList = cur;
          open.pop();
          oldList.open = false;
          finalize(oldList);
          cur = oldList.parent;
          continue;
        }
      }
      const fns = firstNonSpace(content);
      const ind = indentFrom(content, 0, col0);
      if (ind <= 3) {
        const fs = fenceStart(content, fns);
        if (fs) {
          const f = blk('fence');
          f.fence = fs[0]; f.flen = fs[1]; f.info = fs[2]; f.lines = [];
          // Content lines lose up to the opening fence's indentation.
          f.indent = indentFrom(content, 0, col0);
          addChild(cur, f); open.push(f);
          return;
        }
        const ht = htmlBlockType(content, fns);
        if (ht) {
          const h = blk('html');
          h.htype = ht; h.lines = [content]; h.lastIdx = lineIdx;
          // Type 1 (pre/script/style/textarea) ends at its closing tag.
          if (ht === 1) {
            const m = /^<\/?([A-Za-z][A-Za-z0-9-]*)/.exec(content.slice(fns));
            h.closeTag = m ? m[1].toLowerCase() : '';
          }
          addChild(cur, h); open.push(h);
          if (ht === 1) {
            if (htmlType1End(content, h.closeTag)) { open.pop(); h.open = false; finalize(h); }
          } else if (ht >= 2 && ht <= 5 && htmlEndHit(ht, content)) { open.pop(); h.open = false; finalize(h); }
          return;
        }
        if (isThematicBreak(content, fns)) { addChild(cur, blk('hr')); return; }
        const atx = atxHeading(content, fns);
        if (atx) {
          const h = blk('heading'); h.level = atx[0]; h.text = atx[1];
          addChild(cur, h);
          return;
        }
        if (content.charCodeAt(fns) === CC_GT) {
          const q = blk('quote');
          addChild(cur, q); open.push(q);
          let p = fns + 1;
          let srcLine = content;
          // Column of position p (after >).
          let cAtP = col0;
          for (let k = 0; k < p; k++) {
            const ch = content.charCodeAt(k);
            if (ch === CC_TAB) cAtP += 4 - (cAtP % 4);
            else cAtP++;
          }
          if (content.charCodeAt(p) === CC_SPACE) p++;
          else if (content.charCodeAt(p) === CC_TAB) {
            // A tab after > is only partially consumed (1 column);
            // the remainder stays as content.
            const adv = advanceCols(content, p, cAtP, 1);
            srcLine = adv[0]; p = adv[1];
          }
          // Advance col0 past the stripped prefix (tabs expand by column).
          let c = col0;
          for (let k = 0; k < p; k++) {
            const ch = srcLine.charCodeAt(k);
            if (ch === CC_TAB) c += 4 - (c % 4);
            else c++;
          }
          col0 = c;
          content = srcLine.slice(p);
          cur = q;
          continue;
        }
        const li = listStart(content, fns);
        if (li) {
          let list;
          if (cur.t === 'list' && listSameType(cur, li)) {
            list = cur;
          } else {
            const prev = cur.c.length ? cur.c[cur.c.length - 1] : null;
            if (prev && prev.t === 'list' && prev.open && listSameType(prev, li)) list = prev;
            else {
              list = blk('list');
              list.ordered = li.ordered; list.bullet = li.bullet; list.delim = li.delim; list.start = li.start;
              addChild(cur, list); open.push(list);
            }
          }
          const item = blk('item');
          item.indent = li.contentIndent;
          addChild(list, item); open.push(item);
          // Advance col0 past the stripped marker.
          let c = col0;
          // If listStart partially consumed a tab, it returns the
          // modified line; slice that instead of the original.
          const srcLine = li.line || content;
          for (let k = 0; k < li.contentPos; k++) {
            const ch = srcLine.charCodeAt(k);
            if (ch === CC_TAB) c += 4 - (c % 4);
            else c++;
          }
          col0 = c;
          content = srcLine.slice(li.contentPos);
          cur = item;
          continue;
        }
        const p = blk('para');
        p.lines = [content];
        addChild(cur, p); open.push(p);
        return;
      }
      const adv = advanceCols(content, 0, col0, 4);
      const c = blk('code');
      const s0 = adv[0].slice(adv[1]);
      // Inside a container (col0 > 0) a tab in the remaining leading
      // whitespace is expanded; at the top level it is preserved.
      c.lines = [col0 > 0 ? expandLeadingTabs(s0, adv[2]) : s0];
      addChild(cur, c); open.push(c);
      return;
    }
  }

  for (let li = 0; li < lines.length; li++) {
    let line = lines[li];
    // The final empty element of a trailing newline is not a line.
    if (li === lines.length - 1 && line === '') break;
    // Phase 1: match open containers.
    let container = doc;
    let pos = 0, col = 0;
    let allMatched = true;
    let k = 1;
    while (k < open.length) {
      const b = open[k];
      if (isLeaf(b)) break;
      if (b.t === 'quote') {
        let p = pos, c = col;
        while (p < line.length && c - col < 3) {
          const ch = line.charCodeAt(p);
          if (ch === CC_SPACE) { p++; c++; }
          else if (ch === CC_TAB) { const adv = 4 - (c % 4); if (c + adv - col > 3) break; p++; c += adv; }
          else break;
        }
        if (line.charCodeAt(p) === CC_GT) {
          p++; c++;
          if (line.charCodeAt(p) === CC_SPACE) { p++; c++; }
          else if (line.charCodeAt(p) === CC_TAB) {
            // A tab after > is only partially consumed (1 column);
            // the remainder stays as content.
            const adv = advanceCols(line, p, c, 1);
            line = adv[0]; p = adv[1]; c = adv[2];
          }
          pos = p; col = c; container = b; k++;
          continue;
        }
        allMatched = false;
        break;
      }
      if (b.t === 'item') {
        // A line is blank for this item when the remainder after the
        // containers matched so far is blank (e.g. ">>" is blank
        // inside two quotes, even though the full line is not).
        // But an EMPTY item (no content yet) is closed by a blank
        // line: it cannot take content after it (-\n\n  foo leaves
        // foo outside the list).
        if (isBlank(line.slice(pos))) {
          if (b.c.length === 0) { allMatched = false; break; }
          container = b; k++; continue;
        }
        const ind = indentFrom(line, pos, col);
        if (ind >= b.indent) {
          const adv = advanceCols(line, pos, col, b.indent);
          line = adv[0]; pos = adv[1]; col = adv[2];
          container = b; k++;
          continue;
        }
        allMatched = false;
        break;
      }
      if (b.t === 'list') { container = b; k++; continue; }
      break;
    }
    const leaf = (allMatched && k < open.length) ? open[k] : null;
    const rest = line.slice(pos);
    const restBlank = isBlank(rest);
    // Lazy continuation: an unmatched container, but the deepest open
    // block is a paragraph and the line is not blank and does not start
    // a new block at the last matched container's level.
    if (!allMatched) {
      const deepest = open[open.length - 1];
      // A fenced code block keeps its content even when a line does
      // not match the enclosing LIST containers (e.g. a dedented line
      // inside a fence in a list item stays in the fence; marked
      // does not close the fence for it). This does NOT apply inside
      // a blockquote: a line without ">" leaves the quote (and the
      // fence) — cm-237. The closing fence is still recognised when
      // the containers do match (phase 2).
      if (deepest.t === 'fence' && !restBlank) {
        const ci = open.indexOf(container);
        const failed = ci + 1 < open.length ? open[ci + 1] : null;
        if (!failed || failed.t === 'item' || failed.t === 'list') {
          const adv = advanceCols(rest, 0, col, deepest.indent || 0);
          deepest.lines.push(expandCodeTabs(adv[0].slice(adv[1]), adv[2]));
          for (const b of open) b.lastBlank = false;
          continue;
        }
      }
      if (deepest.t === 'para' && !restBlank && !startsBlock(rest)) {
        let text = rest;
        // A lazy line indented 4+ spaces loses a code-block indent
        // (it stays a paragraph continuation, but the 4 spaces go).
        if (indentFrom(rest, 0, col) >= 4) {
          const adv = advanceCols(rest, 0, col, 4);
          text = adv[0].slice(adv[1]);
        }
        // marked's blockquoteSetextReplace: a lazy line that looks like
        // a setext underline, inside a quote, after an earlier lazy
        // line, is indented to 4 spaces, so the inner re-lex does not
        // turn it into a heading. The first lazy line is left alone.
        // (Checked on the original line: a setext underline needs
        // indent <= 3, so the 4-space strip above never applies here.)
        if (deepest.lazy) {
          const fns = firstNonSpace(rest);
          if (indentFrom(rest, 0, col) <= 3 && setextLevel(rest, fns)) {
            let p = deepest.parent;
            while (p && p.t !== 'quote') p = p.parent;
            if (p) text = '    ' + rest.slice(fns);
          }
        }
        deepest.lines.push(text);
        deepest.lazy = (deepest.lazy || 0) + 1;
        for (const b of open) b.lastBlank = false;
        continue;
      }
    }
    // Phase 2: the line is absorbed by an open leaf.
    if (allMatched && leaf) {
      if (leaf.t === 'para') {
        if (!restBlank) {
          const fns = firstNonSpace(rest);
          const ind = indentFrom(rest, 0, col);
          if (ind <= 3) {
            const sl = setextLevel(rest, fns);
            if (sl) {
              // Reference definitions at the start of the paragraph
              // are extracted first (they are not heading text). If
              // nothing is left, === is not a setext underline.
              extractRefDefs(leaf);
              if (leaf.gone) {
                leaf.lines = [rest];
                leaf.text = undefined;
                for (const b of open) b.lastBlank = false;
                continue;
              }
              leaf.t = 'heading'; leaf.level = sl;
              // A setext heading's text is the paragraph text with the
              // leading whitespace of the first line and the trailing
              // whitespace of the last line stripped.
              leaf.text = leaf.text.replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
              open.pop(); leaf.open = false;
              for (const b of open) b.lastBlank = false;
              continue;
            }
            const aligns = tableDelimiter(rest, fns);
            // The delimiter row must have exactly as many cells as
            // the header row, or there is no table at all.
            if (aligns && splitTableRow(leaf.lines[leaf.lines.length - 1]).length === aligns.length) {
              const headerLine = leaf.lines.pop();
              if (leaf.lines.length === 0) {
                const p = leaf.parent, idx = p.c.indexOf(leaf);
                if (idx !== -1) p.c.splice(idx, 1);
                open.pop(); leaf.open = false;
              } else {
                open.pop(); leaf.open = false; finalize(leaf);
                if (leaf.gone) {
                  const p = leaf.parent, idx = p.c.indexOf(leaf);
                  if (idx !== -1) p.c.splice(idx, 1);
                }
              }
              const table = blk('table');
              table.align = aligns;
              table.head = splitTableRow(headerLine);
              table.rows = [];
              addChild(container, table); open.push(table);
              for (const b of open) b.lastBlank = false;
              continue;
            }
            if (canInterrupt(rest)) {
              closeBlocks(open.indexOf(container) + 1);
              startBlocks(container, rest, li, col);
              continue;
            }
            // Marked quirk: inside a list item, an ordered list with
            // any start number interrupts a paragraph (probe: `- foo`
            // then `  505791. bar` starts an <ol>), while at the top
            // level only a list starting with 1 does.
            {
              const li2 = listStart(rest, firstNonSpace(rest));
              if (li2 && li2.ordered && !li2.empty) {
                let p = leaf.parent;
                while (p && p.t !== 'item' && p.t !== 'doc') p = p.parent;
                if (p && p.t === 'item') {
                  closeBlocks(open.indexOf(container) + 1);
                  startBlocks(container, rest, li, col);
                  continue;
                }
              }
            }
          }
          leaf.lines.push(rest);
          for (const b of open) b.lastBlank = false;
          continue;
        }
        // A whitespace-only LAST line inside a quote adds its space to
        // the paragraph (marked re-lexes quote content without a
        // trailing newline, so the final partial line is content, not
        // a blank line). Only when there is actual whitespace left
        // after the marker (">  " has a space; "> " does not).
        if (rest.length > 0) {
          const isLast = li === lines.length - 1 || (li === lines.length - 2 && lines[lines.length - 1] === '');
          if (isLast) {
            let p = container;
            while (p && p.t !== 'quote') p = p.parent;
            if (p) {
              leaf.lines.push(rest);
              for (const b of open) b.lastBlank = false;
              continue;
            }
          }
        }
        // blank line: fall through to close the paragraph.
      } else if (leaf.t === 'fence') {
        // A closing fence may be indented at most 3 spaces; a 4-space
        // indented fence line is content, not a closer.
        if (!restBlank && indentFrom(rest, 0, col) <= 3 && fenceEnd(rest, firstNonSpace(rest), leaf.fence, leaf.flen)) {
          open.pop(); leaf.open = false; finalize(leaf);
          continue;
        }
        const adv = advanceCols(rest, 0, col, leaf.indent || 0);
        leaf.lines.push(expandCodeTabs(adv[0].slice(adv[1]), adv[2]));
        // A blank line inside a fence is code content, not a blank
        // separator, so it must not mark the list loose.
        for (const b of open) b.lastBlank = false;
        continue;
      } else if (leaf.t === 'code') {
        if (restBlank) {
          // A whitespace-only line inside a code block keeps its
          // whitespace minus the 4-column indent (6 spaces -> 2).
          // Inside a container (list/quote, col > 0) a tab in the
          // remaining leading whitespace is expanded; at the top
          // level it is preserved (cm-001/002/003).
          const adv = advanceCols(rest, 0, col, 4);
          const s = adv[0].slice(adv[1]);
          leaf.lines.push(col > 0 ? expandLeadingTabs(s, adv[2]) : s);
          for (const b of open) b.lastBlank = false;
          continue;
        }
        if (indentFrom(rest, 0, col) >= 4) {
          const adv = advanceCols(rest, 0, col, 4);
          const s = adv[0].slice(adv[1]);
          leaf.lines.push(col > 0 ? expandLeadingTabs(s, adv[2]) : s);
          for (const b of open) b.lastBlank = false;
          continue;
        }
        // Not indented enough: close the code block, re-process the line.
      } else if (leaf.t === 'html') {
        if (leaf.htype === 1) {
          // Type 1 runs until its closing tag (blank lines do not end
          // it) or the end of the document.
          leaf.lines.push(rest); leaf.lastIdx = li;
          for (const b of open) b.lastBlank = restBlank;
          if (htmlType1End(rest, leaf.closeTag)) { open.pop(); leaf.open = false; finalize(leaf); }
          continue;
        }
        if (leaf.htype === 6 || leaf.htype === 7) {
          if (!restBlank) { leaf.lines.push(rest); leaf.lastIdx = li; for (const b of open) b.lastBlank = false; continue; }
          // blank line ends it: fall through.
          leaf.endBlank = true;
        } else {
          leaf.lines.push(rest); leaf.lastIdx = li;
          for (const b of open) b.lastBlank = restBlank;
          if (htmlEndHit(leaf.htype, rest)) { open.pop(); leaf.open = false; finalize(leaf); }
          continue;
        }
      } else if (leaf.t === 'table') {
        // A table row is any line that is not blank — but "blank" for
        // a table means empty or spaces-only. A line containing a TAB
        // is a row (its cells come out empty), as is a line with no
        // "|" at all (one cell, padded with empty cells).
        let tableBlank = true;
        for (let q = 0; q < rest.length; q++) {
          if (rest.charCodeAt(q) !== CC_SPACE) { tableBlank = false; break; }
        }
        if (!tableBlank) {
          // A line that starts another block ends the table — but a
          // whitespace-only line (a tab) is a row regardless of its
          // (tab-expanded) indent, never a block start.
          const fns = firstNonSpace(rest);
          const ind = indentFrom(rest, 0, col);
          let ends = false;
          if (fns < rest.length) {
            if (ind <= 3) {
              if (fenceStart(rest, fns) || isThematicBreak(rest, fns) || atxHeading(rest, fns) ||
                rest.charCodeAt(fns) === CC_GT || listStart(rest, fns) || htmlBlockType(rest, fns)) ends = true;
            } else ends = true;
          }
          if (!ends) {
            leaf.rows.push(splitTableRow(rest));
            for (const b of open) b.lastBlank = false;
            continue;
          }
        }
        // blank line or block start: fall through to close the table.
      }
    }
    // Phase 3: close everything below `container`, then start new blocks.
    if (restBlank) {
      // A blank rest sets a pending flag on the innermost open list or
      // item at or below the container. It only makes the list loose
      // if a new block is later added (see addChild); a trailing blank
      // line does not. A ">" line inside a quote sets nothing when no
      // list/item sits below the quote (cm-320 stays tight), while a
      // ">" line between two items of a list inside a quote sets the
      // flag on that list's item (doc-01 goes loose).
      {
        const ci = open.indexOf(container);
        for (let k = open.length - 1; k >= ci; k--) {
          if (open[k].t === 'item' || open[k].t === 'list') { open[k].pendingBlank = true; break; }
        }
      }
      // lastBlank tracks genuine blank lines only: a container line
      // whose rest is empty (">") is not a blank line.
      for (const b of open) b.lastBlank = isBlank(line);
      closeBlocks(open.indexOf(container) + 1);
      continue;
    }
    closeBlocks(open.indexOf(container) + 1);
    for (const b of open) b.lastBlank = false;
    startBlocks(container, rest, li, col);
  }
  closeBlocks(1);
  // HTML blocks: whether their text ends with a trailing \n depends on
  // what follows them. A type 1-5 block ends at its end marker (a
  // closing tag for type 1); it keeps the \n when the very next line
  // is non-blank (its next sibling starts at once). A type 6/7 block
  // ends at a blank line or at EOF, so it never keeps a \n before a
  // sibling. A block with no next sibling keeps the \n only when it
  // is the last block of the document at the top level and the input
  // ends with \n (nested content is re-lexed from lines joined
  // without a trailing \n).
  const endsWithNl = lines.length > 0 && lines[lines.length - 1] === '';
  (function fixHtml(b, isDoc) {
    for (let i = 0; i < b.c.length; i++) {
      const ch = b.c[i];
      if (ch.t === 'html') {
        if (i < b.c.length - 1) {
          const nl = lines[ch.lastIdx + 1];
          ch.trailNl = ch.htype >= 1 && ch.htype <= 5 && nl !== undefined && !isBlank(nl);
        } else {
          ch.trailNl = isDoc && endsWithNl;
        }
      } else if (ch.c) fixHtml(ch, false);
    }
  })(doc, true);
  return { doc, refs };
}

// ---- inline parsing ----
// Node types: 0 text, 1 delim *, 2 delim _, 3 delim ~, 4 code, 5 html,
// 6 br, 7 link, 8 image, 9 autolink, 10 bracket, 11 del, 12 strong, 13 em.
// CommonMark "punctuation" for emphasis flanking is Unicode P or S:
// currency and other symbols ($, £, €) count as punctuation.
const PUNCT_RE = /[\p{P}\p{S}]/u;
const WS_RE = /\s/u;
function isPunctU(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return isPunct(c);
  return PUNCT_RE.test(ch);
}
function isWsU(ch) {
  const c = ch.charCodeAt(0);
  if (c < 128) return c === 32 || c === 9 || c === 10 || c === 13 || c === 11 || c === 12;
  return WS_RE.test(ch);
}
// Flanking of a delimiter run at [i, i+k) in s. The start/end of the
// string count as whitespace.
function flanking(s, i, k) {
  const before = i > 0 ? s[i - 1] : ' ';
  const after = i + k < s.length ? s[i + k] : ' ';
  const bWs = isWsU(before), bPu = isPunctU(before);
  const aWs = isWsU(after), aPu = isPunctU(after);
  const left = !aWs && (!aPu || bWs || bPu);
  const right = !bWs && (!bPu || aWs || aPu);
  return [left, right];
}
// Match an HTML tag starting at i (s[i] === '<'). Returns the tag string or null.
// Update the document-wide anchor state for an inline HTML tag.
// An opening <a> sets it (unless the tag is bare <a/> or <a\n/> —
// no space and no attributes), a closing </a> clears it.
function updateAnchorState(tag) {
  let j = 1;
  const closing = tag.charCodeAt(j) === CC_SLASH;
  if (closing) j++;
  let k = j;
  while (k < tag.length && isAlpha(tag.charCodeAt(k))) k++;
  const name = tag.slice(j, k).toLowerCase();
  if (name !== 'a') return;
  if (closing) { inAnchor = false; return; }
  // Opening <a>: sets the state unless the tag has neither a literal
  // space nor an "=" after the name (bare <a/>, <a\n/>, <a\t/>).
  for (let q = k; q < tag.length; q++) {
    const c = tag.charCodeAt(q);
    if (c === CC_SPACE || c === CC_EQ) { inAnchor = true; return; }
  }
}
function matchHtmlTag(s, i) {
  let j = i + 1;
  const closing = s.charCodeAt(j) === CC_SLASH;
  if (closing) j++;
  if (!isAlpha(s.charCodeAt(j))) {
    // Comment, processing instruction, declaration, CDATA.
    if (s.startsWith('!--', j)) {
      // Abruptly closed comments: <!--> and <!---> are complete.
      if (s.charCodeAt(j + 3) === CC_GT) return s.slice(i, j + 4);
      if (s.charCodeAt(j + 3) === CC_DASH && s.charCodeAt(j + 4) === CC_GT) return s.slice(i, j + 5);
      const end = s.indexOf('-->', j + 3);
      if (end === -1) return null;
      return s.slice(i, end + 3);
    }
    if (s.charCodeAt(j) === 63) { // ?
      const end = s.indexOf('?>', j + 1);
      if (end === -1) return null;
      return s.slice(i, end + 2);
    }
    if (s.charCodeAt(j) === CC_BANG) {
      const c = s.charCodeAt(j + 1);
      if ((c >= 65 && c <= 90) || (c >= 97 && c <= 122)) {
        const end = s.indexOf('>', j + 1);
        if (end === -1) return null;
        return s.slice(i, end + 1);
      }
      if (s.startsWith('[CDATA[', j + 1)) {
        const end = s.indexOf(']]>', j + 8);
        if (end === -1) return null;
        return s.slice(i, end + 3);
      }
    }
    return null;
  }
  // Tag name.
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (isAlnum(c) || c === CC_DASH) j++;
    else break;
  }
  if (closing) {
    // A closing tag takes no attributes: only spaces then >.
    while (j < s.length && (s.charCodeAt(j) === CC_SPACE || s.charCodeAt(j) === CC_TAB || s.charCodeAt(j) === 10)) j++;
    if (s.charCodeAt(j) === CC_GT) return s.slice(i, j + 1);
    return null;
  }
  // Attributes. Each attribute must be preceded by whitespace, and a /
  // must be immediately followed by > (self-closing).
  let needWs = true;
  while (j < s.length) {
    const c = s.charCodeAt(j);
    if (c === CC_SPACE || c === CC_TAB || c === 10) { j++; needWs = false; continue; }
    if (c === CC_GT) return s.slice(i, j + 1);
    if (c === CC_SLASH) {
      if (s.charCodeAt(j + 1) === CC_GT) return s.slice(i, j + 2);
      return null;
    }
    if (needWs) return null;
    if (isAlpha(c) || c === CC_US) {
      // Attribute name: starts with a letter or _, may contain : . - _.
      // A : cannot START an attribute name (http: is a scheme, not a tag).
      while (j < s.length) {
        const d = s.charCodeAt(j);
        if (isAlnum(d) || d === CC_DASH || d === CC_US || d === CC_COLON || d === CC_DOT) j++;
        else break;
      }
      let sawWs = false;
      while (j < s.length && (s.charCodeAt(j) === CC_SPACE || s.charCodeAt(j) === CC_TAB || s.charCodeAt(j) === 10)) { j++; sawWs = true; }
      if (s.charCodeAt(j) === CC_EQ) {
        j++;
        while (j < s.length && (s.charCodeAt(j) === CC_SPACE || s.charCodeAt(j) === CC_TAB || s.charCodeAt(j) === 10)) j++;
        const q = s.charCodeAt(j);
        if (q === CC_QUOT || q === CC_SQ) {
          j++;
          while (j < s.length && s.charCodeAt(j) !== q) j++;
          if (j >= s.length) return null;
          j++;
        } else {
          let any = false;
          while (j < s.length) {
            const d = s.charCodeAt(j);
            if (d === CC_SPACE || d === CC_TAB || d === 10 || d === CC_QUOT || d === CC_SQ || d === CC_EQ || d === CC_LT || d === CC_GT || d === CC_TICK) break;
            any = true; j++;
          }
          if (!any) return null;
        }
        needWs = true;
      } else {
        // Bare attribute: the whitespace after the name (if any) is
        // the separator for the next attribute.
        needWs = !sawWs;
      }
      continue;
    }
    return null;
  }
  return null;
}
// Match an autolink <scheme:...> or <email> at i. Returns {href, text, next} or null.
function matchAutolink(s, i) {
  const end = s.indexOf('>', i + 1);
  if (end === -1) return null;
  const inner = s.slice(i + 1, end);
  if (inner.length === 0 || inner.indexOf(' ') !== -1 || inner.indexOf('\n') !== -1 || inner.indexOf('<') !== -1) return null;
  const colon = inner.indexOf(':');
  if (colon >= 2) {
    const scheme = inner.slice(0, colon);
    if (/^[A-Za-z][A-Za-z0-9+.-]{1,31}$/.test(scheme)) {
      return { href: inner, text: inner, next: end + 1 };
    }
  }
  if (isEmail(inner)) {
    return { href: 'mailto:' + inner, text: inner, next: end + 1 };
  }
  return null;
}
function isEmail(str) {
  const at = str.indexOf('@');
  if (at <= 0) return false;
  const local = str.slice(0, at), domain = str.slice(at + 1);
  if (!/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+$/.test(local)) return false;
  if (domain.indexOf('.') === -1) return false;
  const labels = domain.split('.');
  for (const lab of labels) {
    if (!/^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?$/.test(lab)) return false;
  }
  return true;
}
// Match an extended autolink (GFM) starting at i: www. domain, scheme://
// or an email address. `prev` is the preceding character (or ' ' at the
// start). Returns {href, text, next} or null.
// marked's rules: mailto:/xmpp: + email (xmpp allows one /path segment);
// (http|https|ftp):// or www. + domain + rest; or a bare email. Only
// http/https/ftp take :// (irc:// does not link). The domain needs no
// TLD (www.foo and http://foo link); an email domain needs a dot and
// its last label must end alphanumeric.
const EMAIL_RE = /^[A-Za-z0-9._+-]+@[A-Za-z0-9-_]+(?:\.[A-Za-z0-9-_]*[a-zA-Z0-9])+/;
function matchExtendedAutolink(s, i, prev) {
  if (!(prev === ' ' || prev === '\t' || prev === '\n' || prev === '*' || prev === '_' || prev === '~' || prev === '(' || prev === '<')) return null;
  const rest = s.slice(i);
  // 1. mailto: / xmpp: + email (xmpp allows one /segment path).
  let m = /^(?:mailto|xmpp):/.exec(rest);
  if (m) {
    const scheme = rest.slice(0, m[0].length - 1);
    const em = EMAIL_RE.exec(rest.slice(m[0].length));
    if (!em) return null;
    // A trailing - or alnum means the email continues but would end
    // invalidly, so there is no link at all. A trailing _ is the
    // same, unless it starts an emphasis delimiter run.
    const afterEm = m[0].length + em[0].length;
    if (afterEm < rest.length) {
      const c = rest.charCodeAt(afterEm);
      if (isAlnum(c) || c === CC_DASH) return null;
      // A trailing _ rejects the link — unless it is an emphasis
      // delimiter: __, or a single _ with real content after it
      // (it closes _..._). A lone _ at the very end (or followed
      // only by trailing whitespace) is an invalid email ending.
      if (c === CC_US) {
        const c2 = afterEm + 1 < rest.length ? rest.charCodeAt(afterEm + 1) : 0;
        if (c2 === CC_US) { /* __ delimiter: allow */ }
        else if (c2 === 0) return null;
        else if ((c2 === 32 || c2 === 9 || c2 === 10) && rest.slice(afterEm + 1).trim() === '') return null;
        else if (isAlnum(c2)) return null;
      }
    }
    let url = m[0] + em[0];
    let j = i + url.length;
    if (scheme === 'xmpp') {
      const pm = /^\/[A-Za-z0-9@.]+/.exec(s.slice(j));
      if (pm) { url += pm[0]; j += pm[0].length; }
    }
    return { href: url, text: url, next: j };
  }
  // 2. www. or (http|https|ftp):// + domain + rest of the URL.
  m = /^www\./.exec(rest);
  let kind = -1, domStart = -1;
  if (m) { kind = 0; domStart = i + 4; }
  else {
    m = /^[Hh][Tt][Tt][Pp][Ss]?:\/\/|^[Ff][Tt][Pp]:\/\//.exec(rest);
    if (m) { kind = 1; domStart = i + m[0].length; }
  }
  if (kind >= 0) {
    const dm = /^[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?(\.[A-Za-z0-9]([A-Za-z0-9-]*[A-Za-z0-9])?)*/.exec(s.slice(domStart));
    if (!dm) return null;
    let j = domStart + dm[0].length;
    while (j < s.length) {
      const c = s.charCodeAt(j);
      if (c === CC_SPACE || c === CC_TAB || c === 10 || c === CC_LT) break;
      j++;
    }
    let url = trimAutolinkTail(s.slice(i, j));
    if (!url) return null;
    const href = kind === 0 ? 'http://' + url : url;
    return { href, text: url, next: i + url.length };
  }
  // 3. Bare email.
  m = EMAIL_RE.exec(rest);
  if (!m) return null;
  const after = i + m[0].length;
  if (after < s.length) {
    const c = s.charCodeAt(after);
    // A trailing alnum or - means the email continues but would end
    // invalidly, so there is no link. A trailing _ is the same —
    // unless it is an emphasis delimiter: __, or a single _ with
    // real content after it. A lone _ at the very end (or followed
    // only by trailing whitespace) is an invalid email ending.
    if (isAlnum(c) || c === CC_DASH) return null;
    if (c === CC_US) {
      const c2 = after + 1 < s.length ? s.charCodeAt(after + 1) : 0;
      if (c2 === CC_US) { /* __ delimiter: allow */ }
      else if (c2 === 0) return null;
      else if ((c2 === 32 || c2 === 9 || c2 === 10) && s.slice(after + 1).trim() === '') return null;
      else if (isAlnum(c2)) return null;
    }
  }
  return { href: 'mailto:' + m[0], text: m[0], next: after };
}
// Trim trailing punctuation from an autolink URL: ?, !, ., ,, :, *, _, ~,
// ' and unbalanced ), and a trailing ; unless part of an entity.
function trimAutolinkTail(url) {
  for (;;) {
    if (url.length === 0) return null;
    const last = url.charCodeAt(url.length - 1);
    if (last === 63 || last === 33 || last === CC_DOT || last === 44 || last === CC_COLON || last === CC_STAR || last === CC_US || last === CC_TILDE || last === CC_SQ) {
      url = url.slice(0, -1);
      continue;
    }
    if (last === CC_RP) {
      let open = 0, close = 0;
      for (let k = 0; k < url.length; k++) {
        if (url.charCodeAt(k) === CC_LP) open++;
        else if (url.charCodeAt(k) === CC_RP) close++;
      }
      if (close > open) { url = url.slice(0, -1); continue; }
      break;
    }
    if (last === CC_SEMI) {
      const amp = url.lastIndexOf('&');
      if (amp !== -1 && looksLikeEntity(url, amp)) { url = url.slice(0, amp); continue; }
      url = url.slice(0, -1);
      continue;
    }
    break;
  }
  return url.length ? url : null;
}
// Parse an inline link's (destination title) at i (s[i] === '(').
// Returns {dest, title, next} or null.
function parseInlineLink(s, i) {
  let j = skipWsNl(s, i + 1);
  let dest = '';
  if (s.charCodeAt(j) === CC_RP) return { dest: '', title: null, next: j + 1 };
  const d = parseLinkDest(s, j);
  if (!d) return null;
  dest = d.dest;
  j = skipWsNl(s, d.next);
  let title = null;
  const c = s.charCodeAt(j);
  if (c === CC_QUOT || c === CC_SQ || c === CC_LP) {
    const t = parseLinkTitle(s, j);
    if (!t) return null;
    title = t.title;
    j = skipWsNl(s, t.next);
  }
  if (s.charCodeAt(j) !== CC_RP) return null;
  return { dest, title, next: j + 1 };
}
// Plain-text content of inline nodes (for image alt text).
function altText(nodes) {
  let out = '';
  for (const nd of nodes) {
    if (nd.t === 0) out += nd.s;
    else if (nd.t === 4) out += nd.s;
    else if (nd.t === 1 || nd.t === 2 || nd.t === 3) out += nd.ch.repeat(nd.n);
    else if (nd.t === 5) out += nd.s;
    else if (nd.t === 6) out += '\n';
    else if (nd.t === 9) out += nd.text;
    else if (nd.t === 10) out += nd.img ? '![' : '[';
    else if (nd.t === 7 || nd.t === 8 || nd.t === 11 || nd.t === 12 || nd.t === 13) out += altText(nd.ch);
  }
  return out;
}
function renderNodes(nodes, out) {
  for (const nd of nodes) {
    switch (nd.t) {
      case 0: out.push(esc(nd.s)); break;
      case 1: case 2: case 3: out.push(nd.ch.repeat(nd.n)); break;
      case 4: out.push('<code>', escRaw(nd.s), '</code>'); break;
      case 5: out.push(nd.s); break;
      case 6: out.push('<br>'); break;
      case 7:
        out.push('<a href="', esc(cleanUrl(nd.href)), '"');
        if (nd.title != null) out.push(' title="', esc(nd.title), '"');
        out.push('>');
        renderNodes(nd.ch, out);
        out.push('</a>');
        break;
      case 8:
        out.push('<img src="', esc(cleanUrl(nd.href)), '" alt="', esc(altText(nd.ch)), '"');
        if (nd.title != null) out.push(' title="', esc(nd.title), '"');
        out.push('>');
        break;
      case 9:
        out.push('<a href="', esc(cleanUrl(nd.href)), '">', esc(nd.text), '</a>');
        break;
      case 10: out.push(nd.img ? '![' : '['); break;
      case 11: out.push('<del>'); renderNodes(nd.ch, out); out.push('</del>'); break;
      case 12: out.push('<strong>'); renderNodes(nd.ch, out); out.push('</strong>'); break;
      case 13: out.push('<em>'); renderNodes(nd.ch, out); out.push('</em>'); break;
    }
  }
}
// Emphasis processing over a flat node list (recurses into links).
function processEmphasis(nodes) {
  for (const nd of nodes) {
    if (nd.t === 7 || nd.t === 8) processEmphasis(nd.ch);
  }
  let startIdx = 0;
  for (;;) {
    let closerIdx = -1, closer = null;
    for (let i = startIdx; i < nodes.length; i++) {
      const nd = nodes[i];
      if ((nd.t === 1 || nd.t === 2 || nd.t === 3) && nd.canClose) { closerIdx = i; closer = nd; break; }
    }
    if (!closer) return;
    let openerIdx = -1, opener = null;
    for (let i = closerIdx - 1; i >= 0; i--) {
      const nd = nodes[i];
      if ((nd.t === 1 || nd.t === 2 || nd.t === 3) && nd.ch === closer.ch && nd.canOpen) {
        // Rule of 3: when the opener can also close, or the closer
        // can also open, a match whose combined length is a multiple
        // of 3 is refused unless both lengths are multiples of 3.
        if ((nd.canClose || closer.canOpen) && (nd.n + closer.n) % 3 === 0 &&
            !(nd.n % 3 === 0 && closer.n % 3 === 0)) continue;
        // Marked quirk (verified by probing): an outer opener is
        // refused when an already-matched emphasis/strong node of
        // the SAME delimiter sits between it and the closer with no
        // other delimiter in between, that node's closing delimiter
        // can open (left-flanking), its opening delimiter cannot
        // close, the closer is fully consumed by the match, and the
        // closing delimiter's length plus the opener's length — or
        // plus the closer's length — is a multiple of 3. (e.g. "*a
        // **b**c*" stays literal and "*a **b** c*" matches;
        // "*foo**bar**baz*" matches because its inner opener can
        // close; a "~~" inside "_..._" does not block because the
        // delimiters differ. A "**" between the inner node and the
        // closer, or a strong match, breaks the effect; a lone "*"
        // does not break an emphasis match. A trailing "***" leaves
        // a "*" behind, so the closer is not fully consumed and the
        // outer "**" still matches.)
        let refused = false;
        const use0 = (nd.n >= 2 && closer.n >= 2) ? 2 : 1;
        for (let j = i + 1; j < closerIdx; j++) {
          const mid = nodes[j];
          if ((mid.t === 11 || mid.t === 12 || mid.t === 13) && mid.dc === nd.ch && mid.co && !mid.oc &&
              ((mid.cn + nd.n) % 3 === 0 ||
               (closer.n === use0 && (mid.cn + closer.n) % 3 === 0))) {
            // A delimiter between the inner node and the closer
            // breaks the effect when it is a run of 2+ (a "**"), or
            // when the attempted match is a strong (use 2). A lone
            // "*" does not break an emphasis match.
            let blocked = false;
            for (let k = j + 1; k < closerIdx; k++) {
              const t2 = nodes[k].t;
              if ((t2 === 1 || t2 === 2 || t2 === 3) && (use0 === 2 || nodes[k].n >= 2)) { blocked = true; break; }
            }
            if (!blocked) { refused = true; break; }
          }
        }
        if (refused) continue;
        openerIdx = i; opener = nd; break;
      }
    }
    if (!opener) { startIdx = closerIdx + 1; continue; }
    const use = (opener.n >= 2 && closer.n >= 2) ? 2 : 1;
    const children = nodes.slice(openerIdx + 1, closerIdx);
    const emNode = { t: closer.ch === '~' ? 11 : (use === 2 ? 12 : 13), ch: children, cn: use, co: closer.canOpen, oc: opener.canClose, dc: closer.ch };
    opener.n -= use;
    closer.n -= use;
    const rep = [];
    if (opener.n > 0) rep.push(opener);
    rep.push(emNode);
    if (closer.n > 0) rep.push(closer);
    nodes.splice(openerIdx, closerIdx - openerIdx + 1, ...rep);
    startIdx = openerIdx + (opener.n > 0 ? 1 : 0) + 1;
  }
}

// Parse the inline content of a leaf block into HTML.
function inlineHtml(s, refs) {
  const n = s.length;
  if (n === 0) return '';
  const nodes = [];
  let i = 0, textStart = 0;
  const brackets = [];
  const flush = (end) => {
    if (end > textStart) { nodes.push({ t: 0, s: s.slice(textStart, end) }); textStart = end; }
  };
  while (i < n) {
    const c = s.charCodeAt(i);
    if (c === CC_BSLASH) {
      const nc = s.charCodeAt(i + 1);
      if (nc === 10) {
        flush(i);
        nodes.push({ t: 6 });
        i += 2;
        // After a hard break, leading whitespace of the next line
        // is stripped.
        while (s.charCodeAt(i) === CC_SPACE || s.charCodeAt(i) === CC_TAB) i++;
        textStart = i;
        continue;
      }
      if (nc !== undefined && isPunct(nc)) {
        flush(i);
        nodes.push({ t: 0, s: s[i + 1] });
        i += 2; textStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === CC_SPACE) {
      // Hard break: two or more spaces before a line ending.
      let k = 0;
      while (s.charCodeAt(i + k) === CC_SPACE) k++;
      if (k >= 2 && s.charCodeAt(i + k) === 10) {
        flush(i);
        nodes.push({ t: 6 });
        i += k + 1;
        // After a hard break, leading whitespace of the next line
        // is stripped.
        while (s.charCodeAt(i) === CC_SPACE || s.charCodeAt(i) === CC_TAB) i++;
        textStart = i;
        continue;
      }
      i += k;
      continue;
    }
    if (c === CC_TICK) {
      let k = 0;
      while (s.charCodeAt(i + k) === CC_TICK) k++;
      let j = i + k, found = -1;
      while (j < n) {
        if (s.charCodeAt(j) === CC_TICK) {
          let m = 0;
          while (s.charCodeAt(j + m) === CC_TICK) m++;
          if (m === k) { found = j; break; }
          j += m;
        } else j++;
      }
      if (found !== -1) {
        let content = s.slice(i + k, found).replace(/\n/g, ' ');
        if (content.length >= 2 && content.charCodeAt(0) === CC_SPACE && content.charCodeAt(content.length - 1) === CC_SPACE && content.trim() !== '') {
          content = content.slice(1, -1);
        }
        flush(i);
        nodes.push({ t: 4, s: content });
        i = found + k; textStart = i;
        continue;
      }
      i += k;
      continue;
    }
    if (c === CC_LT) {
      const auto = matchAutolink(s, i);
      if (auto) {
        flush(i);
        nodes.push({ t: 9, href: auto.href, text: auto.text });
        i = auto.next; textStart = i;
        continue;
      }
      const tag = matchHtmlTag(s, i);
      if (tag !== null) {
        flush(i);
        nodes.push({ t: 5, s: tag });
        updateAnchorState(tag);
        i += tag.length; textStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === CC_AMP) {
      const dec = decodeNumeric(s, i);
      if (dec) {
        flush(i);
        nodes.push({ t: 0, s: dec.ch });
        i = dec.next; textStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (c === CC_BANG && s.charCodeAt(i + 1) === CC_LB) {
      flush(i);
      const node = { t: 10, img: true, active: true };
      nodes.push(node);
      brackets.push({ node, active: true, img: true, pos: i + 1 });
      i += 2; textStart = i;
      continue;
    }
    if (c === CC_LB) {
      flush(i);
      const node = { t: 10, img: false, active: true };
      nodes.push(node);
      brackets.push({ node, active: true, img: false, pos: i });
      i++; textStart = i;
      continue;
    }
    if (c === CC_RB) {
      let bi = brackets.length - 1;
      while (bi >= 0 && !brackets[bi].active) bi--;
      if (bi < 0) { i++; continue; }
      const br = brackets[bi];
      let linkInfo = null, next = i + 1;
      if (s.charCodeAt(next) === CC_LP) {
        linkInfo = parseInlineLink(s, next);
        if (!linkInfo) {
          // The inline link failed (bad destination); fall back to
          // a shortcut reference, leaving "(...)" as literal text.
          // The label comes from the raw source (parseLinkLabel),
          // so backslashes are kept literally for matching.
          const lab = parseLinkLabel(s, br.pos);
          const ref = lab ? refs.get(lab.label) : undefined;
          if (ref) linkInfo = { dest: ref.dest, title: ref.title, next: i + 1 };
        }
      } else if (s.charCodeAt(next) === CC_LB) {
        if (s.charCodeAt(next + 1) === CC_RB) {
          // Collapsed reference [foo][]: the label is the link text,
          // read from the raw source so backslashes match literally.
          const lab = parseLinkLabel(s, br.pos);
          const ref = lab ? refs.get(lab.label) : undefined;
          if (ref) linkInfo = { dest: ref.dest, title: ref.title, next: next + 2 };
        } else {
          const lab = parseLinkLabel(s, next);
          if (lab) {
            const ref = refs.get(lab.label);
            if (ref) linkInfo = { dest: ref.dest, title: ref.title, next: lab.next };
          }
        }
      } else {
        // Shortcut reference link: the label is the link text, read
        // from the raw source so backslashes match literally.
        const lab = parseLinkLabel(s, br.pos);
        const ref = lab ? refs.get(lab.label) : undefined;
        if (ref) linkInfo = { dest: ref.dest, title: ref.title, next: i + 1 };
      }
      if (linkInfo) {
        flush(i);
        const bIdx = nodes.indexOf(br.node);
        const children = nodes.slice(bIdx + 1);
        if (!br.img) {
          let hasLink = false;
          for (const ch of children) if (ch.t === 7) { hasLink = true; break; }
          // The ] matched this [ whether or not a link forms: the [
          // is consumed either way, so a later ] tries the next outer [.
          if (hasLink) { br.active = false; i++; continue; }
        }
        const linkNode = { t: br.img ? 8 : 7, href: linkInfo.dest, title: linkInfo.title, ch: children };
        nodes.splice(bIdx, nodes.length - bIdx, linkNode);
        for (let k = bi; k < brackets.length; k++) brackets[k].active = false;
        br.active = false;
        i = linkInfo.next; textStart = i;
        continue;
      }
      // No link forms from this ]: it still consumes the matching [.
      br.active = false;
      i++;
      continue;
    }
    if (c === CC_STAR || c === CC_US) {
      let k = 0;
      while (s.charCodeAt(i + k) === c) k++;
      const [left, right] = flanking(s, i, k);
      let canOpen, canClose;
      if (c === CC_STAR) { canOpen = left; canClose = right; }
      else { canOpen = left && (!right || isPunctU(s[i - 1] || ' ')); canClose = right && (!left || isPunctU(s[i + k] || ' ')); }
      flush(i);
      nodes.push({ t: c === CC_STAR ? 1 : 2, ch: c === CC_STAR ? '*' : '_', n: k, canOpen, canClose });
      i += k; textStart = i;
      continue;
    }
    if (c === CC_TILDE) {
      let k = 0;
      while (s.charCodeAt(i + k) === CC_TILDE) k++;
      // A strikethrough delimiter is a run of exactly 1 or 2
      // tildes; a run of 3+ is literal text (~~~not~~~ does not
      // strike, and ~~hi~~~ has no closer).
      if (k === 1 || k === 2) {
        const [left, right] = flanking(s, i, k);
        flush(i);
        nodes.push({ t: 3, ch: '~', n: k, canOpen: left, canClose: right });
        i += k; textStart = i;
        continue;
      }
      i += k;
      continue;
    }
    // Extended autolinks: only at a word start. A < that did not
    // form an angle autolink is literal text, so a URL right after
    // it is still at a word start (<https://x y> links the x).
    if (i === 0 || isWsU(s[i - 1]) || s[i - 1] === '*' || s[i - 1] === '_' || s[i - 1] === '~' || s[i - 1] === '(' || s[i - 1] === '<') {
      const prev = i === 0 ? ' ' : s[i - 1];
      // Inside an open inline <a>, bare autolinks are suppressed.
      const ext = inAnchor ? null : matchExtendedAutolink(s, i, prev);
      // A link cannot contain another link: an extended autolink
      // inside an open "[" stays plain text.
      let inLink = false;
      if (ext) { for (const b of brackets) if (b.active) { inLink = true; break; } }
      if (ext && !inLink) {
        flush(i);
        nodes.push({ t: 9, href: ext.href, text: ext.text });
        i = ext.next; textStart = i;
        continue;
      }
    }
    i++;
  }
  flush(n);
  processEmphasis(nodes);
  const out = [];
  renderNodes(nodes, out);
  return out.join('');
}

// ---- rendering ----
// A task-list marker at the start of a paragraph's text: "[ ]" or
// "[x]"/"[X]" followed by a space. Returns the checkbox HTML and the
// text with the marker stripped, or null.
function taskMarker(text) {
  if (text.length < 4 || text.charCodeAt(0) !== 91 || text.charCodeAt(2) !== 93 || text.charCodeAt(3) !== CC_SPACE) return null;
  const m = text.charCodeAt(1);
  if (m === CC_SPACE) return ['<input disabled="" type="checkbox">', text.slice(3)];
  if (m === 120 || m === 88) return ['<input checked="" disabled="" type="checkbox">', text.slice(3)];
  return null;
}
function renderItemChildren(item, tight, refs, out) {
  for (let k = 0; k < item.c.length; k++) {
    const ch = item.c[k];
    // In a tight list every paragraph is rendered bare (no <p>
    // tags, no trailing newline); the first one abuts the <li>,
    // later ones abut the previous block's trailing newline.
    if (ch.t === 'para' && tight) {
      const tm = k === 0 ? taskMarker(ch.text) : null;
      if (tm) out.push(tm[0], inlineHtml(tm[1], refs));
      else out.push(inlineHtml(ch.text, refs));
    } else if (ch.t === 'para' && k === 0) {
      // A loose list's first paragraph also takes a task marker.
      const tm = taskMarker(ch.text);
      if (tm) { out.push('<p>', tm[0], inlineHtml(tm[1], refs), '</p>\n'); continue; }
      renderBlock(ch, refs, out);
    } else {
      renderBlock(ch, refs, out);
    }
  }
}
function renderBlock(b, refs, out) {
  switch (b.t) {
    case 'doc':
      for (const ch of b.c) renderBlock(ch, refs, out);
      break;
    case 'para':
      out.push('<p>', inlineHtml(b.text, refs), '</p>\n');
      break;
    case 'heading':
      out.push('<h', b.level, '>', inlineHtml(b.text, refs), '</h', b.level, '>\n');
      break;
    case 'code':
      out.push('<pre><code>', escRaw(b.lines.join('\n') + (b.lines.length ? '\n' : '')), '</code></pre>\n');
      break;
    case 'fence': {
      out.push('<pre><code');
      if (b.info) {
        // The info string's first word is the language; backslash
        // escapes in it are resolved (foo\+bar -> foo+bar).
        const lang = b.info.split(/\s+/)[0].replace(/\\([!"#$%&'()*+,\-.\/:;<=>?@\[\\\]^_`{|}~])/g, '$1');
        out.push(' class="language-', esc(lang), '"');
      }
      out.push('>', escRaw(b.lines.join('\n') + (b.lines.length ? '\n' : '')), '</code></pre>\n');
      break;
    }
    case 'html':
      out.push(b.lines.join('\n'));
      if (b.trailNl) out.push('\n');
      break;
    case 'hr':
      out.push('<hr>\n');
      break;
    case 'quote':
      out.push('<blockquote>\n');
      for (const ch of b.c) renderBlock(ch, refs, out);
      out.push('</blockquote>\n');
      break;
    case 'list': {
      out.push(b.ordered ? '<ol' : '<ul');
      if (b.ordered && b.start !== 1) out.push(' start="', String(b.start), '"');
      out.push('>\n');
      for (const ch of b.c) renderBlock(ch, refs, out);
      out.push(b.ordered ? '</ol>\n' : '</ul>\n');
      break;
    }
    case 'item':
      out.push('<li>');
      renderItemChildren(b, b.parent.tight, refs, out);
      out.push('</li>\n');
      break;
    case 'table': {
      out.push('<table>\n<thead>\n<tr>\n');
      for (let i = 0; i < b.head.length; i++) {
        const a = b.align[i];
        out.push('<th');
        if (a) out.push(' align="', a === 'l' ? 'left' : a === 'c' ? 'center' : 'right', '"');
        out.push('>', inlineHtml(b.head[i], refs), '</th>\n');
      }
      out.push('</tr>\n</thead>\n');
      if (b.rows.length) {
        out.push('<tbody>');
        for (const row of b.rows) {
          out.push('<tr>\n');
          for (let i = 0; i < b.head.length; i++) {
            const a = b.align[i];
            const cell = i < row.length ? row[i] : '';
            out.push('<td');
            if (a) out.push(' align="', a === 'l' ? 'left' : a === 'c' ? 'center' : 'right', '"');
            out.push('>', inlineHtml(cell, refs), '</td>\n');
          }
          out.push('</tr>\n');
        }
        out.push('</tbody>');
      }
      out.push('</table>\n');
      break;
    }
  }
}

// ---- entry point ----
export function parse(markdown) {
  inAnchor = false;
  const src = markdown.replace(/\r\n?/g, '\n');
  const lines = src.split('\n');
  const { doc, refs } = parseBlocks(lines);
  const out = [];
  renderBlock(doc, refs, out);
  return out.join('');
}



