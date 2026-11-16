// Fast Markdown renderer: byte-exact vs marked 18.1.3 (default options: gfm on,
// breaks off, pedantic off, async off). Written from scratch; no dependency.
// Architecture: line-based block lexer producing compact tokens, then a renderer
// that calls a char-dispatch inline parser (no regex-per-rule, no inline token
// objects). Deterministic: no wall clock, no randomness, no caching across calls.

const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
// Text/attribute escaping: an & starting a valid entity reference is left alone
// (marked's escapeReplaceNoEncode). Code contexts use escCode (escapes every &).
const ESC_RE = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
function esc(s) { return s.replace(ESC_RE, c => ESC_MAP[c]); }
const ESC_CODE_RE = /[&<>"']/g;
function escCode(s) { return s.replace(ESC_CODE_RE, c => ESC_MAP[c]); }
// Inline text escaping: every & is literal here (real entities are pushed to
// `out` verbatim by the inline parser, never through here).
const ESC_TEXT_RE = /[&<>"']/g;
function escText(s) { return s.replace(ESC_TEXT_RE, c => ESC_MAP[c]); }

// Entity reference pattern (marked's limits: decimal 1-7 digits, hex 1-6).
// Named references are preserved verbatim in output; numeric ones are decoded.
const ENTITY_RE = /&(#(?:\d{1,7}|[Xx][A-Fa-f0-9]{1,6})|\w+);/g;

// Named entities that marked decodes (practice set + common HTML5 set).
const ENT = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00A0',
  copy: '\u00A9', reg: '\u00AE', trade: '\u2122', mdash: '\u2014', ndash: '\u2013',
  hellip: '\u2026', lsquo: '\u2018', rsquo: '\u2019', ldquo: '\u201C', rdquo: '\u201D',
  laquo: '\u00AB', raquo: '\u00BB', deg: '\u00B0', plusmn: '\u00B1', middot: '\u00B7',
  bull: '\u2022', sect: '\u00A7', para: '\u00B6', micro: '\u00B5', times: '\u00D7',
  divide: '\u00F7', minus: '\u2212', lowast: '\u2217', ouml: '\u00F6', auml: '\u00E4',
  uuml: '\u00FC', euml: '\u00EB', iuml: '\u00EF', yuml: '\u00FF', szlig: '\u00DF',
  eacute: '\u00E9', egrave: '\u00E8', ecirc: '\u00EA', agrave: '\u00E0', aacute: '\u00E1',
  acirc: '\u00E2', atilde: '\u00E3', aelig: '\u00E6', AElig: '\u00C6', aring: '\u00E5',
  Aring: '\u00C5', ccedil: '\u00E7', Ccedil: '\u00C7', ntilde: '\u00F1', Ntilde: '\u00D1',
  iacute: '\u00ED', igrave: '\u00EC', icirc: '\u00EE', oacute: '\u00F3', ograve: '\u00F2',
  ocirc: '\u00F4', otilde: '\u00F5', oslash: '\u00F8', Oslash: '\u00D8', uacute: '\u00FA',
  ugrave: '\u00F9', ucirc: '\u00FB', yacute: '\u00FD', iexcl: '\u00A1', iquest: '\u00BF',
  frac34: '\u00BE', frac14: '\u00BC', frac12: '\u00BD', Dcaron: '\u010E', dcaron: '\u010F',
  HilbertSpace: '\u210B', DifferentialD: '\u2146', ClockwiseContourIntegral: '\u2232',
  ngE: '\u2267\u0338', Alpha: '\u0391', Beta: '\u0392', Gamma: '\u0393', Delta: '\u0394',
  Pi: '\u03A0', Sigma: '\u03A3', Omega: '\u03A9', alpha: '\u03B1', beta: '\u03B2',
  gamma: '\u03B3', delta: '\u03B4', pi: '\u03C0', sigma: '\u03C3', omega: '\u03C9',
  infin: '\u221E', ne: '\u2260', le: '\u2264', ge: '\u2265', part: '\u2202',
  sum: '\u2211', prod: '\u220F', radic: '\u221A', empty: '\u2205', cap: '\u2229',
  cup: '\u222A', sub: '\u2282', sup: '\u2283', nsub: '\u2284', isin: '\u2208',
  notin: '\u2209', ni: '\u220B', and: '\u2227', or: '\u2228', forall: '\u2200',
  exist: '\u2203', larr: '\u2190', rarr: '\u2192', uarr: '\u2191', darr: '\u2193',
  harr: '\u2194', crarr: '\u21B5', lArr: '\u21D0', rArr: '\u21D2', hArr: '\u21D4',
  spades: '\u2660', clubs: '\u2663', hearts: '\u2665', diams: '\u2666', permil: '\u2030',
  prime: '\u2032', Prime: '\u2033', oline: '\u203E', frasl: '\u2044', euro: '\u20AC',
  pound: '\u00A3', yen: '\u00A5', cent: '\u00A2', curren: '\u00A4', brvbar: '\u00A6',
  uml: '\u00A8', ordf: '\u00AA', ordm: '\u00BA', sup1: '\u00B9', sup2: '\u00B2',
  sup3: '\u00B3', acute: '\u00B4', cedil: '\u00B8', macr: '\u00AF', shy: '\u00AD',
  thorn: '\u00FE', THORN: '\u00DE', eth: '\u00F0', ETH: '\u00D0'
};

// Decode a numeric character reference body ("#123" or "#x1F600") to a string.
// Invalid code points (0, surrogates, > 0x10FFFF) become U+FFFD.
function numRef(body) {
  let cp;
  if (body[1] === 'x' || body[1] === 'X') {
    cp = parseInt(body.slice(2), 16);
    if (!/^[0-9A-Fa-f]+$/.test(body.slice(2))) return null;
  } else {
    if (!/^[0-9]+$/.test(body.slice(1))) return null;
    cp = parseInt(body.slice(1), 10);
  }
  if (!cp || cp > 0x10FFFF || (cp >= 0xD800 && cp <= 0xDFFF)) return '\uFFFD';
  return String.fromCodePoint(cp);
}

// Unescape backslash escapes only (used for link destinations and titles).
// Entities are NOT decoded here: marked preserves them verbatim in URLs/titles
// (esc's no-encode lookahead leaves valid references alone).
const BACKSLASH_RE = /\\([!"#$%&'()*+,\-.\/:;<=>?@\[\\\]^_`{|}~])/g;
function unescape(s) {
  if (!s) return s;
  return s.indexOf('\\') >= 0 ? s.replace(BACKSLASH_RE, '$1') : s;
}

// Clean a URL for use in href/src: encode, strip dangerous schemes.
const BAD_SCHEME = /^(?:javascript|vbscript|data):/i;
function cleanUrl(href) {
  if (href == null) return null;
  let h = href;
  try { h = encodeURI(h).replace(/%25/g, '%'); } catch { h = href; }
  h = h.replace(/%25/g, '%');
  if (BAD_SCHEME.test(h.replace(/[\x00-\x20]+/g, ''))) return null;
  return h;
}

function normLabel(s) {
  // Unicode case folding: ẞ/ß fold to 'ss' (full case folding, not just
  // toLowerCase which maps ẞ to ß)
  return s.replace(/[ \t\r\n]+/g, ' ').trim().toLowerCase().replace(/ß/g, 'ss').replace(/ẞ/g, 'ss');
}

// Unicode whitespace (for emphasis flanking): ASCII space/tab/newline/CR
// plus NBSP and the other Unicode space separators.
function isSpace(c) {
  const code = c.charCodeAt(0);
  if (code === 32 || code === 9 || code === 10 || code === 13 || code === 11 || code === 12) return true;
  if (code < 128) return false;
  return code === 0xA0 || code === 0x1680 || (code >= 0x2000 && code <= 0x200A) || code === 0x202F || code === 0x205F || code === 0x3000 || code === 0xFEFF;
}
function isPunctCode(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) || (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}
// Punctuation for emphasis flanking (CommonMark: Unicode P or S categories).
const UNICODE_PUNCT_RE = /[\p{P}\p{S}]/u;
function isFlankPunctCode(c) {
  if (isPunctCode(c)) return true;
  if (c < 128) return false;
  return UNICODE_PUNCT_RE.test(String.fromCodePoint(c));
}
function isAlnumCode(c) {
  return (c >= 48 && c <= 57) || (c >= 65 && c <= 90) || (c >= 97 && c <= 122) || c >= 128;
}

// ================= INLINE PARSER =================
// Scans text once, dispatching on the character. Emphasis uses a delimiter
// stack resolved during the scan (CommonMark algorithm with the rule of 3).
// Links use a '[' opener stack. Output is built as atoms (strings or small
// records) and rendered at the end, so emphasis/link resolution can fix up
// earlier output in place.

const NEXT_SPECIAL = /[*_`[\\\]<>!&~\n]/g;

// Is `ch` (a single char) a valid scheme char for autolink URLs?
function isSchemeChar(c) {
  const k = c.charCodeAt(0);
  return (k >= 65 && k <= 90) || (k >= 97 && k <= 122) || (k >= 48 && k <= 57) || c === '+' || c === '-' || c === '.';
}

// Parse an inline HTML tag / comment / PI / declaration / CDATA starting at i.
// Returns {end, raw} or null.
function scanHtmlTag(s, i) {
  const n = s.length;
  if (s[i] !== '<') return null;
  const j = i + 1;
  if (j >= n) return null;
  const c = s[j];
  if (c === '!') {
    // comment, CDATA, declaration — j points at '!', so patterns here
    // omit the leading '<'
    if (s.startsWith('!--', j)) {
      // comment: '<!--' ... '-->' (also '<!-->' empty and '<!--->')
      if (s.startsWith('<!-->', j - 1)) return { end: i + 5, raw: s.slice(i, i + 5) };
      if (s.startsWith('<!--->', j - 1)) return { end: i + 6, raw: s.slice(i, i + 6) };
      const e = s.indexOf('-->', j + 3);
      if (e === -1) return { end: n, raw: s.slice(i) };
      return { end: e + 3, raw: s.slice(i, e + 3) };
    }
    if (s.startsWith('![CDATA[', j)) {
      const e = s.indexOf(']]>', j + 8);
      if (e === -1) return { end: n, raw: s.slice(i) };
      return { end: e + 3, raw: s.slice(i, e + 3) };
    }
    if (/^![A-Za-z]/.test(s.slice(j, j + 2))) {
      const e = s.indexOf('>', j);
      if (e === -1) return null;
      return { end: e + 1, raw: s.slice(i, e + 1) };
    }
    return null;
  }
  if (c === '?') {
    const e = s.indexOf('?>', j + 1);
    if (e === -1) return { end: n, raw: s.slice(i) };
    return { end: e + 2, raw: s.slice(i, e + 2) };
  }
  // open or close tag
  let k = j;
  let closing = false;
  if (s[k] === '/') { closing = true; k++; }
  if (k >= n || !/[A-Za-z]/.test(s[k])) return null;
  while (k < n && /[A-Za-z0-9-]/.test(s[k])) k++;
  // after the tag name there must be whitespace, '/', or '>' — a ':' or
  // other char directly after the name is not a valid tag (<m:abc>)
  if (k < n && s[k] !== ' ' && s[k] !== '\t' && s[k] !== '\n' && s[k] !== '\r' && s[k] !== '/' && s[k] !== '>') return null;
  if (closing) {
    // close tag: optional whitespace, then '>'
    while (k < n && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n' || s[k] === '\r')) k++;
    if (k < n && s[k] === '>') return { end: k + 1, raw: s.slice(i, k + 1), closing };
    return null;
  }
  // open tag: (whitespace + attribute)*, optional whitespace, optional '/', '>'
  // attribute = name, optional (whitespace* '=' whitespace* value)
  // value = '...' | "..." | unquoted (no space, ", ', =, <, >, `)
  // an attribute name must be preceded by whitespace (since the tag name
  // or the previous attribute); whitespace skipped while looking for '='
  // after a valueless attribute also counts as the separator
  let seenWS = false; // whitespace seen since the tag name / last attribute
  for (;;) {
    while (k < n && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n' || s[k] === '\r')) { k++; seenWS = true; }
    if (k >= n) return null;
    if (s[k] === '>') return { end: k + 1, raw: s.slice(i, k + 1), closing };
    if (s[k] === '/') {
      if (k + 1 < n && s[k + 1] === '>') return { end: k + 2, raw: s.slice(i, k + 2), closing };
      return null;
    }
    if (!seenWS) return null; // attribute must follow whitespace
    // attribute name
    const am = /^[A-Za-z_:][A-Za-z0-9_.:-]*/.exec(s.slice(k));
    if (!am) return null;
    k += am[0].length;
    seenWS = false;
    while (k < n && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n' || s[k] === '\r')) { k++; seenWS = true; }
    if (k < n && s[k] === '=') {
      k++;
      while (k < n && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n' || s[k] === '\r')) k++;
      if (k >= n) return null;
      if (s[k] === '"' || s[k] === "'") {
        const q = s[k];
        k++;
        while (k < n && s[k] !== q) k++;
        if (k >= n) return null;
        k++;
      } else {
        // unquoted value: no space, ", ', =, <, >, `
        let vlen = 0;
        while (k < n && !/[ \t\n\r"'=<>`]/.test(s[k])) { k++; vlen++; }
        if (vlen === 0) return null;
      }
      seenWS = false;
    }
  }
}

// Try to parse a GFM extended autolink (bare www./scheme URL or email)
// starting at i (i points at 'www.', a scheme letter, or '@' for email
// where the local part is scanned backwards). `end` bounds the scan.
// Returns {end, href, display} or null.
function tryGfmAutolink(s, i, end) {
  const n = Math.min(end, s.length);
  // --- email (i points at '@'): scan back for the local part ---
  if (s[i] === '@') {
    let ls = i;
    while (ls > 0 && /[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~_-]/.test(s[ls - 1])) ls--;
    if (ls === i) return null; // empty local part
    // local part must not start/end with '.' and must not contain '..',
    // and must contain at least one alphanumeric (a lone '+' is not an email)
    const local = s.slice(ls, i);
    if (local[0] === '.' || local[local.length - 1] === '.' || local.indexOf('..') !== -1) return null;
    if (!/[A-Za-z0-9]/.test(local)) return null;
    // domain after '@'
    const dm = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+/.exec(s.slice(i + 1, n));
    if (!dm) return null;
    const domain = dm[0];
    // TLD must contain a letter (a 1-char TLD like 'b' is fine)
    const tld = domain.slice(domain.lastIndexOf('.') + 1);
    if (!/[A-Za-z]/.test(tld)) return null;
    const emailEnd = i + 1 + domain.length;
    // the char after the domain must not be a word char or '-' (that would
    // extend/invalidate the domain: a.b- and a.b_ are not emails)
    if (emailEnd < n && /[A-Za-z0-9_-]/.test(s[emailEnd])) return null;
    // the char before the local part must not be a letter/digit (word boundary)
    if (ls > 0 && /[A-Za-z0-9]/.test(s[ls - 1])) return null;
    // a scheme prefix (mailto:, xmpp:, ...) is part of the autolink
    let start = ls;
    let display = local + '@' + domain;
    let href = 'mailto:' + display;
    if (ls > 0 && s[ls - 1] === ':') {
      let ss = ls - 2;
      while (ss >= 0 && /[A-Za-z0-9+.-]/.test(s[ss])) ss--;
      const scheme = s.slice(ss + 1, ls - 1);
      if (/^[A-Za-z][A-Za-z0-9+.-]{1,31}$/.test(scheme) && (ss < 0 || !/[A-Za-z0-9]/.test(s[ss]))) {
        start = ss + 1;
        display = scheme + ':' + display;
        href = display;
      }
    }
    return { end: emailEnd, start, href, display };
  }
  // --- www. or scheme:// URL ---
  let schemeEnd = -1; // index just past '://' or 0 for www.
  let urlStart = i;
  if (s.startsWith('www.', i)) {
    // must be at a word boundary (not preceded by a letter/digit or '.')
    if (i > 0 && /[A-Za-z0-9.]/.test(s[i - 1])) return null;
    schemeEnd = i;
    urlStart = i;
  } else {
    const sm = /^([A-Za-z][A-Za-z0-9+.-]{1,31}):\/\//.exec(s.slice(i, n));
    if (!sm) return null;
    // must be at a word boundary
    if (i > 0 && /[A-Za-z0-9]/.test(s[i - 1])) return null;
    schemeEnd = i + sm[0].length;
    urlStart = i;
  }
  // domain: labels separated by '.', must contain at least one '.'
  let p = schemeEnd;
  if (s.startsWith('www.', i)) p = i + 4;
  const dm = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+/.exec(s.slice(p, n));
  if (!dm) return null;
  let domain = dm[0];
  p += domain.length;
  // path/query/fragment: run of non-space, non-'<' chars. Scan in the FULL
  // text (not just to the run end) so a '&' in a query string does not
  // truncate the URL — the '&' ends the text run for entity parsing, but
  // it is a valid URL character.
  let q = p;
  const fullN = s.length;
  while (q < fullN && !/[ \t\n\r<>]/.test(s[q])) q++;
  let urlEnd = q;
  // trim trailing punctuation that cannot end a URL
  while (urlEnd > p && /[?!.,:*_~'"]/.test(s[urlEnd - 1])) urlEnd--;
  // trailing ')' : keep only while parens balance — drop each excess ')'
  while (urlEnd > p && s[urlEnd - 1] === ')') {
    const urlSoFar = s.slice(urlStart, urlEnd);
    let open = 0, close = 0;
    for (let c = 0; c < urlSoFar.length; c++) {
      if (urlSoFar[c] === '(') open++;
      else if (urlSoFar[c] === ')') close++;
    }
    if (close > open) urlEnd--;
    else break;
  }
  // trailing ';' : if it closes an entity reference (&name;), the whole
  // entity is not part of the URL — drop back to the '&'
  if (urlEnd > p && s[urlEnd - 1] === ';') {
    const amp = s.lastIndexOf('&', urlEnd - 1);
    if (amp >= urlStart && /^[A-Za-z0-9#]+$/.test(s.slice(amp + 1, urlEnd - 1))) urlEnd = amp;
  }
  if (urlEnd <= urlStart) return null;
  const display = s.slice(urlStart, urlEnd);
  const href = s.startsWith('www.', i) ? 'http://' + display : display;
  return { end: urlEnd, start: urlStart, href, display };
}

// Try to parse an autolink <...> starting at i. Returns {end, href, text} or null.
function scanAutolink(s, i) {
  const n = s.length;
  const gt = s.indexOf('>', i + 1);
  if (gt === -1 || gt - i > 100) return null;
  const inner = s.slice(i + 1, gt);
  if (inner.indexOf('\n') !== -1 || inner.indexOf(' ') !== -1) return null;
  if (inner.indexOf('<') !== -1) return null;
  // scheme:...
  const m = /^([A-Za-z][A-Za-z0-9+.-]{1,31}):([^\s<>]*)$/.exec(inner);
  if (m) {
    const href = inner;
    return { end: gt + 1, href, text: inner };
  }
  // email
  if (/^[A-Za-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)+$/.test(inner)) {
    return { end: gt + 1, href: 'mailto:' + inner, text: inner };
  }
  return null;
}

// Parse a link destination starting at i (after '(' or after '[label]').
// Handles <...> and bare destinations. Returns {end, href} or null.
function scanDest(s, i) {
  const n = s.length;
  let j = i;
  while (j < n && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n')) {
    // allow newlines inside ( ) only if followed by non-blank handling is done by caller
    j++;
  }
  if (j >= n) return null;
  if (s[j] === '<') {
    // scan for the closing '>' — a '>' preceded by a backslash escape does
    // not close the destination
    let e = j + 1;
    while (e < n) {
      const ch = s[e];
      if (ch === '\\' && e + 1 < n && isPunctCode(s.charCodeAt(e + 1))) { e += 2; continue; }
      if (ch === '>') break;
      e++;
    }
    if (e >= n) return null;
    const inner = s.slice(j + 1, e);
    if (inner.indexOf('\n') !== -1 || inner.indexOf('<') !== -1) return null;
    return { end: e + 1, href: inner };
  }
  // bare destination: no spaces, balanced parens
  let depth = 0;
  let k = j;
  while (k < n) {
    const ch = s[k];
    if (ch === ' ' || ch === '\t' || ch === '\n') break;
    if (ch === '\\' && k + 1 < n && isPunctCode(s.charCodeAt(k + 1))) { k += 2; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') {
      if (depth === 0) break;
      depth--;
    }
    k++;
  }
  if (k === j) return null;
  return { end: k, href: s.slice(j, k) };
}

// Parse a link title starting at i (after destination). Returns {end, title} or null.
function scanTitle(s, i) {
  const n = s.length;
  let j = i;
  while (j < n && (s[j] === ' ' || s[j] === '\t')) j++;
  if (j >= n) return null;
  const q = s[j];
  if (q === '"' || q === "'") {
    let k = j + 1;
    while (k < n) {
      if (s[k] === '\\' && k + 1 < n) { k += 2; continue; }
      if (s[k] === q) return { end: k + 1, title: s.slice(j + 1, k) };
      if (s[k] === '\n') return null;
      k++;
    }
    return null;
  }
  if (q === '(') {
    let k = j + 1;
    while (k < n) {
      if (s[k] === '\\' && k + 1 < n) { k += 2; continue; }
      if (s[k] === ')') return { end: k + 1, title: s.slice(j + 1, k) };
      if (s[k] === '\n' || s[k] === '(') return null;
      k++;
    }
    return null;
  }
  return null;
}

// Parse an inline link "(dest "title")" starting at s[j] === '('.
// Returns {href, title, end} or null. Newlines are allowed between parts but
// a blank line breaks it.
function parseInlineLink(s, j, n) {
  let k = j + 1;
  let nl = 0;
  while (k < n && (s[k] === ' ' || s[k] === '\t' || s[k] === '\n')) {
    if (s[k] === '\n') { nl++; if (nl >= 2) return null; }
    k++;
  }
  if (k < n && s[k] === ')') return { href: '', title: null, end: k + 1 };
  const d = scanDest(s, k);
  if (!d) return null;
  let k2 = d.end;
  while (k2 < n && (s[k2] === ' ' || s[k2] === '\t' || s[k2] === '\n')) {
    if (s[k2] === '\n') { nl++; if (nl >= 2) return null; }
    k2++;
  }
  let title = null;
  if (k2 < n && (s[k2] === '"' || s[k2] === "'" || s[k2] === '(')) {
    const tt = scanTitle(s, k2);
    if (!tt) return null;
    title = tt.title;
    k2 = tt.end;
  }
  while (k2 < n && (s[k2] === ' ' || s[k2] === '\t' || s[k2] === '\n')) {
    if (s[k2] === '\n') { nl++; if (nl >= 2) return null; }
    k2++;
  }
  if (k2 < n && s[k2] === ')') return { href: d.href, title, end: k2 + 1 };
  return null;
}

// Resolve emphasis for delimiter list `delims` (array of records). Called
// whenever a closer is encountered; `closer` is the delimiter record just added.
// `spans` records [openerOutIdx, closerOutIdx] of emphasis already formed;
// an opener inside such a span may not match a closer outside it (emphasis
// spans may nest, never cross). `links` is the '[' opener stack: an opener
// before the innermost open '[' may not match a closer inside that link.
function resolveEmphasis(out, delims, closer, spans, links) {
  // Walk the delimiter list backwards from the closer, looking for an opener.
  // We keep resolving while the closer has delimiters left.
  while (closer.left > 0) {
    let oi = -1;
    for (let k = delims.length - 1; k >= 0; k--) {
      const d = delims[k];
      if (d === closer) continue;
      if (!d.open || d.ch !== closer.ch || d.left <= 0) continue;
      // rule of 3: if the sum of the two runs is a multiple of 3 and one
      // of them can both open and close, the match is disallowed — unless
      // both runs are themselves multiples of 3
      if ((d.left + closer.left) % 3 === 0 && (d.close || closer.open) &&
          !((d.left % 3 === 0) && (closer.left % 3 === 0))) continue;
      // no crossing: an opener inside an already-formed emphasis span may
      // not match a closer outside that span
      let inside = false;
      for (let s = 0; s < spans.length; s++) {
        if (d.outIdx > spans[s][0] && d.outIdx < spans[s][1]) { inside = true; break; }
      }
      if (inside) continue;
      oi = k;
      break;
    }
    if (oi === -1) return;
    const opener = delims[oi];
    const use = (opener.left >= 2 && closer.left >= 2) ? 2 : 1;
    const openTag = use === 2 ? '<strong>' : '<em>';
    const closeTag = use === 2 ? '</strong>' : '</em>';
    // opener: prepend open tag (outermost first), consume from the end of its run
    opener.openTags = openTag + opener.openTags;
    opener.left -= use;
    // closer: append close tag, consume from the start of its run
    closer.closeTags = closer.closeTags + closeTag;
    closer.left -= use;
    spans.push([opener.outIdx, closer.outIdx, use]);
    if (opener.left === 0) {
      // remove opener from the delimiter list
      delims.splice(oi, 1);
    }
  }
}

// Render the atom list to an HTML string. Atoms are strings or records:
//  {d: delim} emphasis delimiter, {l: linkOpener} '[' (literal if unmatched),
//  {img: ...} handled by replacement. Records render via their fields.
function renderAtoms(out) {
  let html = '';
  for (let a = 0; a < out.length; a++) {
    const x = out[a];
    if (typeof x === 'string') { html += x; continue; }
    if (x.d) {
      const d = x.d;
      html += d.closeTags + (d.left > 0 ? d.ch.repeat(d.left) : '') + d.openTags;
      continue;
    }
    if (x.l) { html += x.l.img ? '![' : '['; continue; }
    if (x.raw) { html += x.raw; continue; }
  }
  return html;
}

// Main inline parser. Returns HTML for `text` (a single block's inline content).
function inline(text, refs) {
  const n = text.length;
  const out = [];
  const delims = [];   // emphasis delimiter records, in order
  const links = [];    // '[' opener records, in order
  const emphSpans = []; // [openerOutIdx, closerOutIdx] of formed emphasis
  let i = 0;
  let buf = '';
  const flush = () => { if (buf) { out.push(escText(buf)); buf = ''; } };

  // Find next special char from position p using the precompiled regex.
  NEXT_SPECIAL.lastIndex = 0;
  let nextM = null;
  const advanceTo = (p) => {
    NEXT_SPECIAL.lastIndex = p;
    nextM = NEXT_SPECIAL.exec(text);
    return nextM ? nextM.index : n;
  };
  let next = advanceTo(0);

  while (i < n) {
    if (i < next) {
      // plain text run up to the next special char — but scan it for GFM
      // bare autolinks (www./scheme URLs, emails) first
      const end = Math.min(next, n);
      let p = i;
      // fast path: no autolink trigger in this run
      const runStr = text.slice(p, end);
      if (runStr.indexOf('www.') === -1 && runStr.indexOf('://') === -1 && runStr.indexOf('@') === -1) {
        buf += runStr;
        i = end;
        continue;
      }
      while (p < end) {
        // find the next autolink candidate in this run
        let cand = -1, kind = 0; // 0=www, 1=scheme, 2=@
        const w = text.indexOf('www.', p);
        const sc = text.indexOf('://', p);
        const at = text.indexOf('@', p);
        if (w !== -1 && w < end && (cand === -1 || w < cand)) { cand = w; kind = 0; }
        if (sc !== -1 && sc < end && (cand === -1 || sc - 1 < cand)) {
          // scheme starts before '://' — back up to the scheme start
          let ss = sc - 1;
          while (ss > p && /[A-Za-z0-9+.-]/.test(text[ss - 1])) ss--;
          // the scheme start must be at or after p (else already processed)
          if (ss >= p && /[A-Za-z]/.test(text[ss]) && (cand === -1 || ss < cand)) { cand = ss; kind = 1; }
        }
        if (at !== -1 && at < end && (cand === -1 || at < cand)) { cand = at; kind = 2; }
        if (cand === -1 || cand >= end) { buf += text.slice(p, end); break; }
        const res = tryGfmAutolink(text, cand, end);
        if (res) {
          const aStart = res.start !== undefined ? res.start : cand;
          buf += text.slice(p, aStart);
          flush();
          out.push('<a href="' + esc(res.href) + '">' + escText(res.display) + '</a>');
          p = res.end;
        } else {
          // not a valid autolink — emit up to just past the trigger and retry;
          // always advance p so this cannot loop
          const adv = Math.max(cand + 1, p + 1);
          buf += text.slice(p, adv);
          p = adv;
        }
      }
      // a URL may extend past this run's end (a '&' in a query string) —
      // advance i to the furthest position consumed
      i = Math.max(end, p);
      next = advanceTo(i);
      continue;
    }
    if (i >= n) break;
    const c = text[i];
    // --- dispatch on the special char ---
    if (c === '*' || c === '_') {
      // emphasis delimiter run
      let j = i;
      while (j < n && text[j] === c) j++;
      const run = j - i;
      const prev = i > 0 ? text.charCodeAt(i - 1) : 32;
      const nxt = j < n ? text.charCodeAt(j) : 32;
      const prevWS = isSpace(String.fromCharCode(prev)) || i === 0;
      const nextWS = isSpace(String.fromCharCode(nxt)) || j === n;
      const prevPunct = isFlankPunctCode(prev);
      const nextPunct = isFlankPunctCode(nxt);
      const leftFlank = !nextWS && (!nextPunct || prevWS || prevPunct);
      const rightFlank = !prevWS && (!prevPunct || nextWS || nextPunct);
      let canOpen, canClose;
      if (c === '*') { canOpen = leftFlank; canClose = rightFlank; }
      else { canOpen = leftFlank && (!rightFlank || prevPunct); canClose = rightFlank && (!leftFlank || nextPunct); }
      flush();
      const rec = { ch: c, left: run, open: canOpen, close: canClose, openTags: '', closeTags: '', outIdx: out.length };
      out.push({ d: rec });
      if (canOpen || canClose) {
        delims.push(rec);
        if (canClose) resolveEmphasis(out, delims, rec, emphSpans, links);
        // if fully consumed as a closer and it cannot open, drop from list
        if (rec.left === 0 && !canOpen) {
          const di = delims.indexOf(rec);
          if (di >= 0) delims.splice(di, 1);
        }
      }
      i = j;
      next = advanceTo(i);
      continue;
    }
    if (c === '~') {
      // strikethrough: ~...~ or ~~...~~ both form <del> (like emphasis,
      // 1 tilde = <del>, 2 tildes = <del>); the rule of 3 applies, so
      // ~~~...~~~ does NOT form a <del>. A run of 3+ tildes is not a
      // strikethrough delimiter at all — it is literal text.
      let j = i;
      while (j < n && text[j] === '~') j++;
      const run = j - i;
      if (run >= 3) { buf += text.slice(i, j); i = j; next = advanceTo(i); continue; }
      const prev = i > 0 ? text.charCodeAt(i - 1) : 32;
      const nxt = j < n ? text.charCodeAt(j) : 32;
      const prevWS = isSpace(String.fromCharCode(prev)) || i === 0;
      const nextWS = isSpace(String.fromCharCode(nxt)) || j === n;
      const prevPunct = isFlankPunctCode(prev);
      const nextPunct = isFlankPunctCode(nxt);
      const leftFlank = !nextWS && (!nextPunct || prevWS || prevPunct);
      const rightFlank = !prevWS && (!prevPunct || nextWS || nextPunct);
      flush();
      const rec = { ch: '~', left: run, open: leftFlank, close: rightFlank, openTags: '', closeTags: '', outIdx: out.length };
      out.push({ d: rec });
      if (leftFlank || rightFlank) {
        delims.push(rec);
        if (rightFlank) {
          while (rec.left > 0) {
            let oi = -1;
            for (let k = delims.length - 1; k >= 0; k--) {
              const d = delims[k];
              if (d === rec) continue;
              if (d.ch !== '~' || !d.open || d.left <= 0) continue;
              // rule of 3 (same as emphasis): sum multiple of 3 and one
              // side can both open and close disallows the match, unless
              // both runs are themselves multiples of 3
              if ((d.left + rec.left) % 3 === 0 && (d.close || rec.open) &&
                  !((d.left % 3 === 0) && (rec.left % 3 === 0))) continue;
              // no crossing an already-formed emphasis span
              let inside = false;
              for (let s = 0; s < emphSpans.length; s++) {
                if (d.outIdx > emphSpans[s][0] && d.outIdx < emphSpans[s][1]) { inside = true; break; }
              }
              if (inside) continue;
              oi = k; break;
            }
            if (oi === -1) break;
            const opener = delims[oi];
            const use = (opener.left >= 2 && rec.left >= 2) ? 2 : 1;
            opener.openTags = '<del>' + opener.openTags;
            opener.left -= use;
            rec.closeTags = rec.closeTags + '</del>';
            rec.left -= use;
            emphSpans.push([opener.outIdx, rec.outIdx, use, 'del']);
            if (opener.left === 0) delims.splice(oi, 1);
          }
        }
        if (rec.left === 0 && !leftFlank) {
          const di = delims.indexOf(rec);
          if (di >= 0) delims.splice(di, 1);
        }
      }
      i = j;
      next = advanceTo(i);
      continue;
    }
    if (c === '`') {
      // code span
      let j = i;
      while (j < n && text[j] === '`') j++;
      const run = j - i;
      // find a closing run of exactly `run` backticks
      let k = j;
      let close = -1;
      while (k < n) {
        if (text[k] === '`') {
          let e = k;
          while (e < n && text[e] === '`') e++;
          if (e - k === run) { close = k; break; }
          k = e;
        } else k++;
      }
      flush();
      if (close === -1) {
        out.push(esc('`'.repeat(run)));
        i = j;
      } else {
        let code = text.slice(j, close);
        code = code.replace(/\n/g, ' ');
        if (code.length >= 2 && code[0] === ' ' && code[code.length - 1] === ' ' && !/^ +$/.test(code)) {
          code = code.slice(1, -1);
        }
        out.push('<code>' + escCode(code) + '</code>');
        i = close + run;
      }
      next = advanceTo(i);
      continue;
    }
    if (c === '\\') {
      // backslash escape or hard break
      const nx = text[i + 1];
      if (nx === '\n') {
        flush();
        out.push('<br>');
        i += 2;
        // after a hard break, leading whitespace on the next line is stripped
        while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
        next = advanceTo(i);
        continue;
      }
      if (nx !== undefined && isPunctCode(nx.charCodeAt(0))) {
        buf += nx;
        i += 2;
        next = advanceTo(i);
        continue;
      }
      buf += '\\'; i++;
      next = advanceTo(i);
      continue;
    }
    if (c === '&') {
      // entity: numeric ones decode into buf, named ones go verbatim to `out`
      const m = /^&(#(?:\d{1,7}|[Xx][A-Fa-f0-9]{1,6})|\w+);/.exec(text.slice(i, i + 40));
      if (m) {
        const body = m[1];
        if (body[0] === '#') {
          const r = numRef(body);
          if (r !== null) { buf += r; i += m[0].length; next = advanceTo(i); continue; }
        } else {
          flush();
          out.push(m[0]);
          i += m[0].length; next = advanceTo(i); continue;
        }
      }
      buf += '&'; i++;
      next = advanceTo(i);
      continue;
    }
    if (c === '<') {
      // autolink or inline HTML
      const al = scanAutolink(text, i);
      if (al) {
        flush();
        const href = cleanUrl(al.href);
        if (href !== null) {
          out.push('<a href="' + esc(href) + '">' + esc(al.text) + '</a>');
        } else {
          out.push(esc(al.text));
        }
        i = al.end;
        next = advanceTo(i);
        continue;
      }
      const tag = scanHtmlTag(text, i);
      if (tag) {
        flush();
        out.push(tag.raw);
        i = tag.end;
        next = advanceTo(i);
        continue;
      }
      buf += '<'; i++;
      next = advanceTo(i);
      continue;
    }
    if (c === '!') {
      // image: ![ ... ] — mark the '[' that follows
      if (text[i + 1] === '[') {
        flush();
        // push a marker: the '!' is consumed; the '[' opener is flagged img
        const rec = { img: true, active: true, aidx: out.length, src: i + 1 };
        out.push({ l: rec });
        links.push(rec);
        i += 2;
        next = advanceTo(i);
        continue;
      }
      buf += '!'; i++;
      next = advanceTo(i);
      continue;
    }
    if (c === '[') {
      flush();
      const rec = { img: false, active: true, aidx: out.length, src: i };
      out.push({ l: rec });
      links.push(rec);
      i++;
      next = advanceTo(i);
      continue;
    }
    if (c === ']') {
      // try to form a link from the nearest active '[' opener
      let li = -1;
      for (let k = links.length - 1; k >= 0; k--) {
        if (links[k].active) { li = k; break; }
      }
      if (li === -1) { buf += ']'; i++; next = advanceTo(i); continue; }
      const opener = links[li];
      const oidx = opener.aidx;
      // the link text may still be in buf — flush it so plainFromAtoms/renderAtoms see it
      flush();
      let j = i + 1;
      let href = null, title = null, consumed = 0;
      let ok = false;
      let labelAttempted = false;
      if (text[j] === '(') {
        const res = parseInlineLink(text, j, n);
        if (res) { href = res.href; title = res.title; ok = true; consumed = res.end - i; }
      } else if (text[j] === '[') {
        labelAttempted = true;
        const e = text.indexOf(']', j + 1);
        if (e !== -1) {
          const labelRaw = text.slice(j + 1, e);
          let key;
          if (labelRaw === '') {
            // collapsed reference: label = raw source text of the link text
            key = normLabel(text.slice(opener.src + 1, i));
          } else {
            key = normLabel(labelRaw);
          }
          const r = refs.get(key);
          if (r) { href = r.href; title = r.title; ok = true; consumed = e + 1 - i; }
        }
      }
      if (!ok) {
        // shortcut reference: label = raw source text of the link text
        // (backslashes preserved — foo\! does not match foo!)
        // BUT: if a '[' followed this ']' (a full/collapsed reference was
        // attempted and failed), do NOT fall back to a shortcut — the
        // '[foo][bar]' form is literal and '[bar]' is parsed on its own.
        if (!labelAttempted) {
          const label = text.slice(opener.src + 1, i);
          const r = refs.get(normLabel(label));
          if (r) { href = r.href; title = r.title; ok = true; consumed = 1; }
        }
      }
      if (!ok) {
        opener.active = false;
        links.splice(li, 1);
        buf += ']'; i++;
        next = advanceTo(i);
        continue;
      }
      // form the link (or image): compute inner HTML and alt text BEFORE truncating
      flush();
      // UNDO any emphasis span that crosses this link's boundary: an
      // opener before the '[' matching a closer inside the link text (or
      // vice versa) must not stand — the delimiter on the outside keeps
      // its literal char, the one inside keeps its literal char too.
      for (let s = emphSpans.length - 1; s >= 0; s--) {
        const sp = emphSpans[s];
        const oOut = sp[0], cOut = sp[1], use = sp[2] || 1;
        const crosses = (oOut < oidx && cOut > oidx) || (oOut > oidx && cOut < oidx);
        if (!crosses) continue;
        const isDel = sp[3] === 'del';
        const openTag = isDel ? '<del>' : (use === 2 ? '<strong>' : '<em>');
        const closeTag = isDel ? '</del>' : (use === 2 ? '</strong>' : '</em>');
        // opener side: strip the open tag (most recent = first in openTags)
        const oAtom = out[oOut];
        if (oAtom && oAtom.d) {
          const idx = oAtom.d.openTags.indexOf(openTag);
          if (idx >= 0) {
            oAtom.d.openTags = oAtom.d.openTags.slice(0, idx) + oAtom.d.openTags.slice(idx + openTag.length);
            oAtom.d.left += use;
          }
        }
        // closer side: strip the close tag (most recent = last in closeTags)
        const cAtom = out[cOut];
        if (cAtom && cAtom.d) {
          const idx = cAtom.d.closeTags.lastIndexOf(closeTag);
          if (idx >= 0) {
            cAtom.d.closeTags = cAtom.d.closeTags.slice(0, idx) + cAtom.d.closeTags.slice(idx + closeTag.length);
            cAtom.d.left += use;
          }
        }
        emphSpans.splice(s, 1);
      }
      // delimiters inside the link text must not match closers outside it:
      // drop them from the delimiter list (their atoms are truncated below)
      for (let d = delims.length - 1; d >= 0; d--) {
        if (delims[d].outIdx > oidx) delims.splice(d, 1);
      }
      const innerHtml = renderAtoms(out.slice(oidx + 1));
      const altText = plainFromAtoms(out, oidx + 1);
      out.length = oidx;
      const clean = cleanUrl(unescape(href));
      if (opener.img) {
        const srcAttr = clean === null ? '' : ' src="' + esc(clean) + '"';
        const titleAttr = title ? ' title="' + esc(unescape(title)) + '"' : '';
        out.push('<img' + srcAttr + ' alt="' + esc(altText) + '"' + titleAttr + '>');
      } else {
        if (clean === null) {
          out.push(innerHtml);
        } else {
          const titleAttr = title ? ' title="' + esc(unescape(title)) + '"' : '';
          out.push('<a href="' + esc(clean) + '"' + titleAttr + '>' + innerHtml + '</a>');
        }
      }
      // remove the matched opener and any openers inside the link text
      links.splice(li, 1);
      for (let k = links.length - 1; k >= 0; k--) {
        if (links[k].aidx > oidx) links.splice(k, 1);
      }
      // a link may not contain another link: deactivate outer LINK openers
      // (but an image inside a link is fine, so only for links, not images;
      // and an image may contain a link — its text becomes the alt text —
      // so a link must not deactivate an outer IMAGE opener either)
      if (!opener.img) {
        for (let k = 0; k < links.length; k++) {
          if (!links[k].img) links[k].active = false;
        }
      }
      i += consumed;
      next = advanceTo(i);
      continue;
    }
    if (c === '\n') {
      // soft break, or hard break if preceded by 2+ spaces or backslash (backslash handled above)
      // check trailing spaces in buf
      let sp = 0;
      while (sp < buf.length && buf[buf.length - 1 - sp] === ' ') sp++;
      if (sp >= 2) {
        buf = buf.slice(0, buf.length - sp);
        flush();
        out.push('<br>');
        i++; // past '\n'
        // after a hard break, leading whitespace on the next line is stripped
        while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
        next = advanceTo(i);
        continue;
      } else {
        buf += '\n';
      }
      i++;
      next = advanceTo(i);
      continue;
    }
    // fallback: treat as plain char
    buf += c;
    i++;
    next = advanceTo(i);
  }
  flush();
  return renderAtoms(out);
}

// Plain-text content of atoms from index `from` to end of `out` (for link
// labels and image alt text). Strips tags; delimiter atoms contribute their
// leftover text only.
function plainFromAtoms(out, from) {
  let s = '';
  for (let a = from; a < out.length; a++) {
    const x = out[a];
    if (typeof x === 'string') {
      // images contribute their alt text; other tags are stripped
      s += x.replace(/<img[^>]*alt="([^"]*)"[^>]*>/g, (m, alt) => alt).replace(/<[^>]*>/g, '');
    } else if (x.d) {
      s += x.d.left > 0 ? x.d.ch.repeat(x.d.left) : '';
    } else if (x.l) {
      s += '[';
    } else if (x.raw) {
      s += x.raw.replace(/<[^>]*>/g, '');
    }
  }
  // unescape HTML entities in the plain text (they were escaped in strings)
  return s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
}

// ================= BLOCK LEXER =================
// Line-based. Tokens are small objects {t, ...}. Link reference definitions
// are collected into `refs` (a Map) and produce no token.

const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h1|h2|h3|h4|h5|h6|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';
const HTML_BLOCK_RE = new RegExp('^ {0,3}(?:</?(?:' + BLOCK_TAGS + ')(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)', 'i');
// Type 7: the whole line is exactly one complete open or closing tag.
// (Unlike types 1-6, type 7 does NOT interrupt a paragraph.)
const HTML_BLOCK7_RE = /^ {0,3}<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^>]*)?\/?>[ \t]*$/;
const ATX_RE = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const HR_RE = /^ {0,3}(?:-[ \t]*){3,}$|^ {0,3}(?:_[ \t]*){3,}$|^ {0,3}(?:\*[ \t]*){3,}$/;
const FENCE_RE = /^ {0,3}(`{3,}|~{3,})([^\n]*)$/;
const BQ_RE = /^ {0,3}>[ \t]?/;
const LIST_RE = /^ {0,3}([*+-]|\d{1,9}[.)])(?:[ \t]+|$)/;
const TABLE_DELIM_RE = /^ {0,3}\|?(?: *:?-+:? *)(?:\|(?: *:?-+:? *)*)*\|?[ \t]*$/;
const TABLE_DELIM_CELL = /:?-+:?/;

function blankLine(s) { return /^[ \t]*$/.test(s); }

function indentCols(line) {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === ' ') col++;
    else if (ch === '\t') col += 4 - (col % 4);
    else break;
  }
  return col;
}

// Expand the leading whitespace (spaces/tabs) of `s` to spaces, assuming `s`
// starts at column `startCol`. The rest of the string is untouched.
function expandLead(s, startCol) {
  let col = startCol, idx = 0, out = '';
  while (idx < s.length && (s[idx] === ' ' || s[idx] === '\t')) {
    if (s[idx] === ' ') { col++; idx++; out += ' '; }
    else {
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w; idx++;
    }
  }
  return out + s.slice(idx);
}

// Remove the first `n` columns of `line` (columns from the line start, tabs
// expanding to tab stops). A tab straddling the boundary becomes spaces, and
// any leading tabs in the remainder are expanded so column positions hold.
function dropCols(line, n) {
  if (n <= 0) return line;
  let col = 0, i = 0;
  while (i < line.length && col < n) {
    const ch = line[i];
    if (ch === '\t') {
      const w = 4 - (col % 4);
      if (col + w <= n) { col += w; i++; }
      else return ' '.repeat(col + w - n) + expandLead(line.slice(i + 1), col + w);
    } else { col++; i++; }
  }
  return expandLead(line.slice(i), col);
}

// Remove `n` columns of leading indent from `line`. A tab that straddles the
// strip boundary is replaced by spaces; the remaining leading whitespace is
// likewise rendered as spaces so later tabs keep their visual column.
function stripCols(line, n) {
  if (n <= 0) return line;
  let col = 0, i = 0;
  while (i < line.length) {
    const ch = line[i];
    if (ch === ' ') { col++; i++; }
    else if (ch === '\t') { col += 4 - (col % 4); i++; }
    else break;
  }
  if (col <= n) return line.slice(i);
  return ' '.repeat(col - n) + line.slice(i);
}

// Like stripCols, but a tab starting at or after the strip boundary is
// preserved as a tab (for indented code content, which is literal).
function stripColsCode(line, n) {
  if (n <= 0) return line;
  let col = 0, i = 0;
  while (i < line.length && col < n) {
    const ch = line[i];
    if (ch === ' ') { col++; i++; }
    else if (ch === '\t') {
      const w = 4 - (col % 4);
      if (col + w <= n) { col += w; i++; }
      else return ' '.repeat(col + w - n) + line.slice(i + 1);
    }
    else break;
  }
  return line.slice(i);
}

// The content of a line after removing up to 3 leading spaces (for block starts).
function after3(line) {
  let i = 0;
  while (i < line.length && i < 3 && line[i] === ' ') i++;
  return line.slice(i);
}

// Try to parse a link reference definition starting at lines[ln].
// Returns {ref, nextLn} or null. May span lines.
function parseDef(lines, ln, end) {
  const line = lines[ln];
  let m = /^ {0,3}\[((?:\\[^\n]|[^\\\]\n])+)\]:[ \t]*(.*)$/.exec(line);
  let label, rest, cur;
  if (m) {
    label = m[1];
    // label must not contain an unescaped '[' and must be non-empty after trim
    if (label.trim() === '' || /(^|[^\\])\[/.test(m[1])) return null;
    rest = m[2];
    cur = ln;
  } else {
    // multi-line label: '[' on this line, the closing ']:' on a later line
    const open = /^ {0,3}\[/.exec(line);
    if (!open) return null;
    let acc = line.slice(open[0].length);
    let j = ln, found = -1, foundEnd = -1;
    // scan the accumulated text for the first unescaped ']' followed by ':'
    const scanClose = (s) => {
      for (let k = 0; k < s.length; k++) {
        if (s[k] === '\\' && k + 1 < s.length) { k++; continue; }
        if (s[k] === ']' && s[k + 1] === ':') return k;
      }
      return -1;
    };
    while (j < end) {
      const p = scanClose(acc);
      if (p >= 0) { found = p; foundEnd = j; break; }
      if (j + 1 >= end) return null;
      // a label may not span a blank line
      if (blankLine(lines[j + 1])) return null;
      j++;
      acc += '\n' + lines[j];
    }
    if (found < 0) return null;
    const rawLabel = acc.slice(0, found);
    label = rawLabel;
    if (label.trim() === '' || /(^|[^\\])\[/.test(rawLabel)) return null;
    rest = acc.slice(found + 2).replace(/^[ \t]*/, '');
    // rest may contain a newline if ']:' was mid-line and more followed;
    // only the part after ':' on the closing line counts here — the
    // destination/title scan below works on `rest` as a single string, so
    // if the closing line had more lines after it they are handled by the
    // existing next-line logic via `cur`
    cur = foundEnd;
    // if rest still contains a newline (label closed mid-accumulation with
    // extra text), treat only up to the newline as the rest
    const nlIdx = rest.indexOf('\n');
    if (nlIdx >= 0) {
      // the definition's destination must be on the closing line or the
      // next line; extra lines after are not part of it — but a newline in
      // rest here means the ']:' line itself continued, which is fine: the
      // destination scan uses the full rest string
    }
  }
  // destination (may be on the next line if rest is blank)
  let dest = null, title = null;
  const takeDest = (s) => {
    s = s.replace(/^[ \t]+/, '');
    if (!s) return null;
    if (s[0] === '<') {
      const e = s.indexOf('>');
      if (e === -1) return null;
      const inner = s.slice(1, e);
      if (inner.indexOf('\n') !== -1 || inner.indexOf('<') !== -1) return null;
      return { href: inner, rest: s.slice(e + 1) };
    }
    let k = 0;
    while (k < s.length && s[k] !== ' ' && s[k] !== '\t') {
      if (s[k] === '\\' && k + 1 < s.length) { k += 2; continue; }
      k++;
    }
    if (k === 0) return null;
    return { href: s.slice(0, k), rest: s.slice(k) };
  };
  let d = takeDest(rest);
  if (!d && cur + 1 < end) {
    const nl = lines[cur + 1];
    if (/^[ \t]*$/.test(nl) === false && /^[ \t]*\S/.test(nl)) {
      d = takeDest(nl);
      if (d) cur++;
    }
  }
  if (!d) return null;
  dest = d.href;
  let r2 = d.rest;
  // Title after a destination. Returns {title, rest} on a valid title (rest
  // is only whitespace), 'none' when no title delimiter follows, 'bad'
  // when a title delimiter is found but the title is malformed (nested '('
  // in a paren title, or junk after the close), or 'unterminated' when the
  // closing quote was not found on this string (it may continue on a
  // following line).
  const takeTitle = (s) => {
    s = s.replace(/^[ \t]+/, '');
    if (!s) return 'none';
    const q = s[0];
    if (q !== '"' && q !== "'" && q !== '(') return 'none';
    const close = q === '(' ? ')' : q;
    let k = 1, title = '';
    while (k < s.length) {
      const c = s[k];
      // backslash escape only before ASCII punctuation; otherwise literal
      if (c === '\\' && k + 1 < s.length) {
        const n = s[k + 1];
        if (/[!\"#$%&'()*+,\-./:;<=>?@\[\\\]^_`{|}~]/.test(n)) { title += n; k += 2; continue; }
        title += '\\'; k++; continue;
      }
      if (c === close) {
        const rest = s.slice(k + 1);
        if (/^[ \t]*$/.test(rest)) return { title, rest };
        return 'bad';
      }
      if (q === '(' && c === '(') return 'bad';
      title += c; k++;
    }
    return 'unterminated';
  };
  // Scan a title that may span lines: start with `s` (from line `fromLn`),
  // extending with following lines while the title is unterminated. A title
  // may not span a blank line.
  // Returns {title, rest, endLn} or 'none'/'bad'.
  const scanTitleLines = (s, fromLn) => {
    let curStr = s, endLn = fromLn;
    for (;;) {
      const r = takeTitle(curStr);
      if (r !== 'unterminated') {
        if (r && r !== 'none' && r !== 'bad') return { title: r.title, rest: r.rest, endLn };
        return r;
      }
      if (endLn + 1 >= end) return 'bad';
      if (blankLine(lines[endLn + 1])) return 'bad';
      endLn++;
      curStr += '\n' + lines[endLn];
    }
  };
  // Same-line title: r2 must be empty, or whitespace + a valid title.
  // Any other non-whitespace rest invalidates the definition.
  let t = null;
  if (/^[ \t]*$/.test(r2)) {
    // no title on this line; try the next line (it may span lines)
    if (cur + 1 < end) {
      const nl = lines[cur + 1];
      if (!/^[ \t]*$/.test(nl)) {
        const t2 = scanTitleLines(nl, cur + 1);
        if (t2 && t2 !== 'none' && t2 !== 'bad') { t = t2; cur = t2.endLn; }
        // a bad or absent next-line title just means no title
      }
    }
  } else if (r2[0] === ' ' || r2[0] === '\t') {
    const t2 = scanTitleLines(r2, cur);
    if (t2 === 'none' || t2 === 'bad') return null;
    t = t2; cur = t2.endLn;
  } else {
    // destination directly followed by non-space content: no title, junk
    return null;
  }
  if (t) { title = t.title; r2 = t.rest; }
  // after title, only spaces allowed, then end of line/block
  if (!/^[ \t]*$/.test(r2)) return null;
  // the definition ends at the line `cur`; the next line must be blank or a new block
  return { ref: { label: normLabel(label), href: dest, title }, nextLn: cur + 1 };
}

// Split a table row line into cells (handling escaped pipes and leading/trailing pipes).
function splitRow(line) {
  let s = line;
  // strip leading/trailing pipe (with optional spaces)
  s = s.replace(/^[ \t]*\|/, '').replace(/\|[ \t]*$/, '');
  const cells = [];
  let cur = '', i = 0;
  while (i < s.length) {
    const ch = s[i];
    // an escaped pipe \| is a literal pipe in the cell (unescape it here,
    // before inline parsing, so `\|` inside a code span becomes `|`)
    if (ch === '\\' && i + 1 < s.length && s[i + 1] === '|') { cur += '|'; i += 2; continue; }
    if (ch === '|') { cells.push(cur); cur = ''; i++; continue; }
    cur += ch; i++;
  }
  cells.push(cur);
  return cells.map(c => c.trim());
}

function tableAlign(delimLine) {
  const parts = splitRow(delimLine);
  const align = [];
  for (const p of parts) {
    const t = p.trim();
    if (/^:-+:$/.test(t)) align.push('center');
    else if (/^-+:$/.test(t)) align.push('right');
    else if (/^:-+$/.test(t)) align.push('left');
    else align.push(null);
  }
  return align;
}

// Does `line` look like a table delimiter row?
function isTableDelim(line) {
  if (!TABLE_DELIM_RE.test(line)) return false;
  const parts = splitRow(line);
  if (parts.length === 0) return false;
  for (const p of parts) {
    if (!TABLE_DELIM_CELL.test(p.trim())) return false;
  }
  return true;
}

// Can `line` start a block that interrupts a paragraph? `next` is the following line.
function interruptsPara(line, next, lines, ln, end) {
  const a = after3(line);
  if (a === '') return false;
  if (/^#{1,6}(?:[ \t]|$)/.test(a)) return true;
  if (/^(`{3,}|~{3,})/.test(a)) return true;
  if (a[0] === '>') return true;
  if (HR_RE.test(line)) return true;
  if (HTML_BLOCK_RE.test(line)) return true;
  const lm = LIST_RE.exec(line);
  if (lm) {
    // an empty list item (marker only, no content) cannot interrupt a paragraph
    if (line.slice(lm[0].length).trim() === '') return false;
    const marker = lm[1];
    if (marker === '*' || marker === '+' || marker === '-') return true;
    // ordered: only interrupts if it starts with 1
    if (/^1[.)]$/.test(marker)) return true;
    return false;
  }
  // table: this line is a header and the next is a delimiter row
  if (next !== undefined && isTableDelim(next) && a.indexOf('|') !== -1) return true;
  return false;
}

// Collect the lines of a blockquote starting at lines[ln].
// Returns {content, nextLn} where content is the inner lines (with '>' stripped).
function collectBQ(lines, ln, end) {
  const content = [];
  let i = ln;
  // a lazy (unmarked) line may only continue a paragraph, never a fenced
  // or indented code block; track whether the content ends in a paragraph
  // and whether we are inside a fence
  let inPara = false, inFence = null;
  const startsBlock = (l) => {
    if (/^ {0,3}(`{3,}|~{3,})/.test(l)) return true;
    if (/^ {0,3}#{1,6}(?:[ \t]+|$)/.test(l)) return true;
    if (/^ {0,3}((?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/.test(l)) return true;
    if (/^ {0,3}([*+-]|\d{1,9}[.)])([ \t]+|$)/.test(l)) return true;
    if (indentCols(l) >= 4) return true;
    if (/^ {0,3}<\/?[A-Za-z][^>\n]*>/.test(l)) return true;
    return false;
  };
  while (i < end) {
    const line = lines[i];
    const m = BQ_RE.exec(line);
    if (m) {
      // column-aware strip: the marker is up to 3 spaces + '>' + one optional
      // space (or one column of a tab); dropCols expands a straddling tab
      const m0 = m[0];
      let p = 0, markerCols = 0;
      while (p < m0.length && m0[p] === ' ') { markerCols++; p++; }
      markerCols++; p++; // the '>'
      if (p < m0.length) markerCols++; // one column of the following space/tab
      const stripped = dropCols(line, markerCols);
      content.push(stripped);
      // update paragraph/fence state from the stripped line
      if (inFence) {
        if (/^ {0,3}`{3,}[ \t]*$/.test(stripped) && stripped.trim()[0] === inFence[0] && stripped.trim().length >= inFence.length) inFence = null;
        inPara = false;
      } else if (/^ {0,3}(`{3,}|~{3,})/.test(stripped)) {
        const f = stripped.trim().match(/^(?:`{3,}|~{3,})/)[0];
        inFence = f;
        inPara = false;
      } else if (stripped === '') {
        inPara = false;
      } else if (startsBlock(stripped)) {
        inPara = false;
      } else {
        inPara = true;
      }
      i++;
      continue;
    }
    // lazy continuation: a paragraph line inside the blockquote
    if (blankLine(line)) {
      // a truly blank line (no '>' marker) ends the blockquote; a new '>'
      // line after it starts a fresh blockquote
      break;
    }
    // lazy line: a paragraph continuation of the blockquote — but not a line
    // that starts a block (HR, heading, fence, ...), which ends the quote,
    // and only when the content ends in a paragraph (never after a code
    // block or fence). A trailing list/blockquote container may itself end
    // in a paragraph (lazy lines propagate through it), so it also allows
    // a lazy continuation. A lazy setext-`=` underline is NOT a heading: it
    // joins the paragraph as literal text, indented 4 spaces so it cannot
    // act as an underline.
    const lastContent = content.length > 0 ? content[content.length - 1] : '';
    const endsContainer = LIST_RE.test(lastContent) || BQ_RE.test(lastContent);
    if ((inPara || endsContainer) && content.length > 0 && !blankLine(content[content.length - 1]) &&
        !interruptsPara(line, lines[i + 1], lines, i, end)) {
      if (/^ {0,3}=+[ \t]*$/.test(line)) {
        content.push('    ' + line.replace(/^[ \t]+/, ''));
      } else {
        content.push(line);
      }
      i++;
      continue;
    }
    break;
  }
  return { content, nextLn: i };
}

// Collect the lines of a list item. `firstContent` is the first line's content
// (marker + following spaces already removed). `contentIndent` is the indent
// (columns) of the item's content. Returns {content, nextLn}.
function collectItem(lines, start, end, contentIndent, firstContent) {
  const content = [];
  let i = start;
  content.push(firstContent);
  i++;
  while (i < end) {
    const line = lines[i];
    if (blankLine(line)) {
      // an empty item (no content yet) ends at the first blank line
      if (content.every(c => c === '')) break;
      // blank: peek ahead; if a later line belongs to this item or a sibling
      // item, the blank is part of the list; else it ends the item
      let j = i + 1;
      while (j < end && blankLine(lines[j])) j++;
      if (j >= end) { i = j; break; }
      const nl = lines[j];
      const ind = indentCols(nl);
      if (ind >= contentIndent || LIST_RE.test(nl) || BQ_RE.test(nl)) {
        // blank lines belong to the item (they make it loose)
        for (let k = i; k < j; k++) content.push('');
        i = j;
        continue;
      }
      break;
    }
    const ind = indentCols(line);
    if (ind >= contentIndent) {
      content.push(stripCols(line, contentIndent));
      i++;
      continue;
    }
    // a new list item at the same or outer level ends this item
    if (LIST_RE.test(line)) break;
    // lazy continuation: a paragraph line of this item — but not a line that
    // starts a block (HR, heading, fence, ...), which ends the item instead
    if (content.length > 0 && !blankLine(content[content.length - 1]) &&
        !interruptsPara(line, lines[i + 1], lines, i, end)) {
      content.push(line);
      i++;
      continue;
    }
    break;
  }
  return { content, nextLn: i };
}

// Parse a list starting at lines[ln]. Returns {token, nextLn} or null.
function parseList(lines, ln, end, refs, trailingNL = false) {
  const first = LIST_RE.exec(lines[ln]);
  if (!first) return null;
  const marker = first[1];
  const ordered = /^\d/.test(marker);
  const bullet = ordered ? null : marker;
  let start = 1;
  if (ordered) start = parseInt(marker, 10);
  const items = [];
  let i = ln;
  let loose = false;
  let lastBlank = false;
  while (i < end) {
    const line = lines[i];
    // a line that is a thematic break is an HR, not a list item — it ends the list
    if (HR_RE.test(line)) break;
    const m = LIST_RE.exec(line);
    if (!m) break;
    const mk = m[1];
    if (ordered) {
      if (!/^\d/.test(mk) || (mk.endsWith('.') !== marker.endsWith('.'))) break;
    } else {
      if (mk !== bullet) break;
    }
    // content indent: leading spaces + marker width + spaces after it (tab expands)
    const afterMarker = line.slice(m[0].length);
    const leadSpaces = m[0].indexOf(m[1]);
    const trailWs = m[0].slice(leadSpaces + m[1].length);
    let contentIndent;
    if (afterMarker.trim() === '') {
      // empty item: content indent is marker width + 1 (or next line's indent)
      contentIndent = leadSpaces + m[1].length + 1;
      if (i + 1 < end && !blankLine(lines[i + 1])) {
        const ni = indentCols(lines[i + 1]);
        // use the next line's indent only if it is not a code-block indent
        // (4+ columns beyond the default); otherwise the line is code
        if (ni > contentIndent && ni - contentIndent < 4) contentIndent = ni;
      }
    } else {
      let col = leadSpaces + m[1].length;
      for (let k = 0; k < trailWs.length; k++) {
        if (trailWs[k] === ' ') col++;
        else col += 4 - (col % 4);
      }
      contentIndent = col;
      // if the spaces after the marker would indent the content by 5+,
      // the marker is treated as followed by a single space
      if (contentIndent - (leadSpaces + m[1].length) > 4) contentIndent = leadSpaces + m[1].length + 1;
    }
    const { content, nextLn } = collectItem(lines, i, end, contentIndent,
      dropCols(line, contentIndent));
    // task list item?
    let task = false, checked = false;
    if (content.length > 0) {
      const tm = /^\[([ xX])\][ \t]+/.exec(content[0]);
      if (tm) { task = true; checked = tm[1] !== ' '; content[0] = content[0].replace(/^\[[ xX]\][ \t]+/, ''); }
    }
    const sub = lexBlocks(content, 0, content.length, refs, (nextLn < end) || trailingNL);
    items.push({ tokens: sub, task, checked });
    // looseness: a blank line between items, or an item ending with a blank line
    if (lastBlank) loose = true;
    // an interior blank line between two top-level blocks of this item
    // (blanks inside a fence, code block or nested list do not count)
    if (sub.hasInteriorBlank) loose = true;
    let lastNB = -1;
    for (let k = 0; k < content.length; k++) {
      if (content[k] !== '') lastNB = k;
    }
    if (content.length > 0 && content[content.length - 1] === '' && lastNB >= 0) loose = true;
    lastBlank = false;
    // was there a blank line before the next item?
    if (nextLn < end) {
      let j = nextLn;
      // count blank lines the collector skipped (they are inside content already)
      // instead: if the next item is preceded by a blank line in the source
      if (blankLine(lines[nextLn - 1]) && nextLn < end) lastBlank = true;
    }
    i = nextLn;
    // skip blank lines between items (they belong to the list if another item follows)
    let j = i;
    while (j < end && blankLine(lines[j])) j++;
    if (j < end && LIST_RE.test(lines[j])) {
      if (j > i) loose = true;
      i = j;
      continue;
    }
    break;
  }
  if (items.length === 0) return null;
  return { token: { t: 'list', ordered, start, items, loose }, nextLn: i };
}

// Main block lexer over lines[start..end). Returns tokens.
function lexBlocks(lines, start, end, refs, trailingNL = false, topLevel = false) {
  const tokens = [];
  let hasInteriorBlank = false;
  let ln = start;
  while (ln < end) {
    const line = lines[ln];
    if (blankLine(line)) {
      // a blank line at the top level, after a token and before another
      // block, is an interior blank (blanks inside a fence, code block or
      // nested list are consumed by those parsers, not here)
      if (tokens.length > 0) {
        let j = ln + 1;
        while (j < end && blankLine(lines[j])) j++;
        if (j < end) hasInteriorBlank = true;
      }
      ln++; continue;
    }
    const ind = indentCols(line);
    const a = after3(line);

    // indented code (4+ spaces, not a list item, cannot interrupt a paragraph
    // — at block start it is a code block)
    if (ind >= 4 && !LIST_RE.test(line)) {
      const buf = [];
      let i = ln;
      while (i < end) {
        const l = lines[i];
        if (blankLine(l)) {
          // blank: look ahead for another indented line; keep every blank
          // line (stripped of the 4-column code indent)
          let j = i + 1;
          while (j < end && blankLine(lines[j])) j++;
          if (j < end && indentCols(lines[j]) >= 4 && !LIST_RE.test(lines[j])) {
            for (let k = i; k < j; k++) buf.push(stripColsCode(lines[k], 4));
            i = j;
            continue;
          }
          break;
        }
        if (indentCols(l) >= 4 && !LIST_RE.test(l)) {
          buf.push(stripColsCode(l, 4));
          i++;
          continue;
        }
        break;
      }
      // trim trailing blank lines
      while (buf.length && buf[buf.length - 1] === '') buf.pop();
      // each source line contributes its trailing newline
      const addNL = i < end || trailingNL;
      tokens.push({ t: 'code', text: buf.length ? buf.join('\n') + (addNL ? '\n' : '') : '' });
      ln = i;
      continue;
    }

    // fenced code
    const fm = FENCE_RE.exec(line);
    if (fm && ind <= 3) {
      const fence = fm[1];
      const info = fm[2].trim();
      if (!(fence[0] === '`' && info.indexOf('`') !== -1)) {
        const buf = [];
        let i = ln + 1;
        let closed = false;
        const closeRe = new RegExp('^ {0,3}' + (fence[0] === '`' ? '`' : '~') + '{' + fence.length + ',}[ \t]*$');
        while (i < end) {
          if (closeRe.test(lines[i])) { i++; closed = true; break; }
          // body lines are dedented by the opening fence's indent
          buf.push(ind > 0 ? stripCols(lines[i], ind) : lines[i]);
          i++;
        }
        const addNL = (closed || trailingNL) && buf.length > 0 && buf[buf.length - 1] !== '';
        tokens.push({ t: 'fence', text: buf.length ? buf.join('\n') + (addNL ? '\n' : '') : '', lang: info });
        ln = i;
        continue;
      }
    }

    // ATX heading
    const hm = ATX_RE.exec(line);
    if (hm && ind <= 3) {
      let text = hm[2] === undefined ? '' : hm[2];
      // strip closing sequence: trailing #'s preceded by a space, or the
      // whole text being #'s (a closing sequence on its own)
      text = text.replace(/[ \t]+#+[ \t]*$/, '');
      if (/^#+$/.test(text)) text = '';
      text = text.replace(/[ \t]+$/, '');
      tokens.push({ t: 'h', level: hm[1].length, text });
      ln++;
      continue;
    }

    // HR
    if (HR_RE.test(line) && ind <= 3) {
      tokens.push({ t: 'hr' });
      ln++;
      continue;
    }

    // blockquote
    if (BQ_RE.test(line) && ind <= 3) {
      const { content, nextLn } = collectBQ(lines, ln, end);
      const sub = lexBlocks(content, 0, content.length, refs, (nextLn < end) || trailingNL);
      tokens.push({ t: 'bq', tokens: sub });
      ln = nextLn;
      continue;
    }

    // list
    if (LIST_RE.test(line) && ind <= 3) {
      const res = parseList(lines, ln, end, refs, trailingNL);
      if (res) {
        tokens.push(res.token);
        ln = res.nextLn;
        continue;
      }
    }

    // HTML block (types 1-6, plus type 7: whole line is one complete tag)
    if ((HTML_BLOCK_RE.test(line) || HTML_BLOCK7_RE.test(line)) && ind <= 3) {
      const buf = [];
      let i = ln;
      const first = lines[i];
      // determine the type by the opening
      let type = 7;
      if (/^ {0,3}<(script|pre|style|textarea)(?:[\s>]|$)/i.test(first)) type = 1;
      else if (/^ {0,3}<!--/.test(first)) type = 2;
      else if (/^ {0,3}<\?/.test(first)) type = 3;
      else if (/^ {0,3}<![A-Za-z]/.test(first)) type = 4;
      else if (/^ {0,3}<!\[CDATA\[/.test(first)) type = 5;
      else if (/^ {0,3}<\/?(address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul)(?:[ \t]+|\n|\/?>)/i.test(first)) type = 6;
      // a type 6/7 block whose opening tag is complete on this line must be
      // a VALID tag — an invalid tag (<a h*#ref="hi">, </a href="foo">) is
      // a paragraph, not an HTML block
      if ((type === 6 || type === 7) && first.indexOf('>') !== -1) {
        const stripped = first.replace(/^ {0,3}/, '');
        if (!scanHtmlTag(stripped, 0)) {
          // not a valid tag — fall through to paragraph parsing
          // (do not consume this line as an HTML block)
          // -- fall through by skipping the HTML block branch entirely
          // We achieve this by NOT entering the block: set a flag and jump.
          // Simplest: treat as not-an-HTML-block via a goto-like: push nothing
          // and continue to the next check below (parseDef/paragraph).
          // To do that we wrap: if invalid, skip to after this if-block.
          // (Implemented by setting type=-1 and checking below.)
          type = -1;
        }
      }
      if (type === -1) {
        // invalid tag — not an HTML block; fall through to link-def/paragraph
      } else {
      const endRe = type === 1 ? /<\/(script|pre|style|textarea)>/i
        : type === 2 ? /-->/ : type === 3 ? /\?>/ : type === 4 ? />/ : type === 5 ? /\]\]>/ : null;
      // types 1-5 run to the closing tag (or end), blank lines included;
      // types 6-7 end at the first blank line
      let endedAtBlank = false;
      let closed = false;
      while (i < end) {
        const l = lines[i];
        if (type >= 6 && blankLine(l)) { endedAtBlank = true; break; }
        buf.push(l);
        if (endRe && endRe.test(l)) { i++; closed = true; break; }
        i++;
      }
      // trailing newline: at the top level, the block keeps the newline after
      // its last line unless the next line is blank (nested HTML blocks
      // never get a trailing newline)
      let addNL = false;
      if (topLevel) {
        if (i >= end) addNL = trailingNL;
        else addNL = !blankLine(lines[i]);
      }
      tokens.push({ t: 'html', text: buf.length ? buf.join('\n') + (addNL ? '\n' : '') : '' });
      ln = i;
      continue;
      } // end else (valid HTML block)
    }

    // link reference definition
    const def = parseDef(lines, ln, end);
    if (def && ind <= 3) {
      const key = def.ref.label;
      if (!refs.has(key)) refs.set(key, { href: def.ref.href, title: def.ref.title });
      ln = def.nextLn;
      continue;
    }

    // table: header line + delimiter row (delimiter must have the same
    // number of columns as the header, else it is not a table)
    if (ln + 1 < end && a.indexOf('|') !== -1 && isTableDelim(lines[ln + 1])) {
      const head = splitRow(line);
      const align = tableAlign(lines[ln + 1]);
      if (align.length !== head.length) {
        // column count mismatch — not a table; fall through to paragraph
      } else {
      const rows = [];
      let i = ln + 2;
      while (i < end) {
        const l = lines[i];
        if (blankLine(l)) break;
        // a line starting a new block (blockquote, heading, list, fence,
        // HR, HTML) ends the table — it is not a row
        if (/^ {0,3}>/.test(l) || /^ {0,3}#{1,6}(?:[ \t]|$)/.test(l) ||
            /^ {0,3}(`{3,}|~{3,})/.test(l) || HR_RE.test(l) ||
            /^ {0,3}([*+-]|\d{1,9}[.)])([ \t]+|$)/.test(l) || HTML_BLOCK_RE.test(l)) break;
        // a row need not contain a pipe — a line with no pipe is a
        // single-cell row; the table runs until a blank line or a block
        rows.push(splitRow(l));
        i++;
      }
      tokens.push({ t: 'table', head, align, rows });
      ln = i;
      continue;
      }
    }

    // setext heading: this line + next line (=== or ---)
    if (ln + 1 < end) {
      const nx = lines[ln + 1];
      if (/^ {0,3}=+[ \t]*$/.test(nx)) {
        tokens.push({ t: 'h', level: 1, text: line.trim() });
        ln += 2;
        continue;
      }
      if (/^ {0,3}-+[ \t]*$/.test(nx)) {
        tokens.push({ t: 'h', level: 2, text: line.trim() });
        ln += 2;
        continue;
      }
    }

    // paragraph: consume lines until blank or an interrupting block
    {
      const buf = [line];
      let i = ln + 1;
      let done = false;
      while (i < end) {
        const l = lines[i];
        if (blankLine(l)) {
          // in nested content a whitespace-only (non-empty) line is a
          // paragraph continuation (it came from a '>' marker line);
          // only a truly empty line ends the paragraph
          if (!topLevel && l !== '') { buf.push(l); i++; continue; }
          break;
        }
        // setext underline converts the paragraph to a heading
        if (/^ {0,3}=+[ \t]*$/.test(l)) {
          tokens.push({ t: 'h', level: 1, text: buf.join('\n').trim() });
          ln = i + 1;
          done = true;
          break;
        }
        if (/^ {0,3}-+[ \t]*$/.test(l)) {
          tokens.push({ t: 'h', level: 2, text: buf.join('\n').trim() });
          ln = i + 1;
          done = true;
          break;
        }
        if (interruptsPara(l, lines[i + 1], lines, i, end)) break;
        // in a container, a continuation line indented 4+ columns is a
        // paragraph continuation, not code: strip the 4-column code indent
        // — unless stripping would turn it into a setext underline (a line
        // deliberately indented to stay literal text keeps its indent)
        if (!topLevel && indentCols(l) >= 4) {
          const stripped = dropCols(l, 4);
          if (/^=+[ \t]*$/.test(stripped) || /^-+[ \t]*$/.test(stripped)) buf.push(l);
          else buf.push(stripped);
        } else buf.push(l);
        i++;
      }
      if (!done) {
        tokens.push({ t: 'p', text: buf.join('\n') });
        ln = i;
      }
      continue;
    }
  }
  tokens.hasInteriorBlank = hasInteriorBlank;
  return tokens;
}

// ================= RENDERER =================
function render(tokens, refs) {
  let html = '';
  for (const tok of tokens) {
    switch (tok.t) {
      case 'p':
        html += '<p>' + inline(tok.text, refs) + '</p>\n';
        break;
      case 'h': {
        // heading text: inline parse, but strip leading/trailing spaces already done
        html += '<h' + tok.level + '>' + inline(tok.text, refs) + '</h' + tok.level + '>\n';
        break;
      }
      case 'code':
        html += '<pre><code>' + escCode(tok.text) + '</code></pre>\n';
        break;
      case 'fence': {
        const lang = tok.lang ? ' class="language-' + esc(unescape(tok.lang.split(/[ \t]/)[0])) + '"' : '';
        html += '<pre><code' + lang + '>' + escCode(tok.text) + '</code></pre>\n';
        break;
      }
      case 'hr':
        html += '<hr>\n';
        break;
      case 'bq': {
        const inner = render(tok.tokens, refs);
        html += '<blockquote>\n' + inner + '</blockquote>\n';
        break;
      }
      case 'list': {
        const tag = tok.ordered ? 'ol' : 'ul';
        const startAttr = tok.ordered && tok.start !== 1 ? ' start="' + tok.start + '"' : '';
        html += '<' + tag + startAttr + '>\n';
        for (const it of tok.items) {
          let inner;
          if (!tok.loose) {
            // tight list: strip <p> wrappers only from paragraphs that are
            // DIRECT children of the item; paragraphs nested inside a
            // blockquote or sublist keep their wrappers
            inner = '';
            for (const t of it.tokens) {
              if (t.t === 'p') inner += inline(t.text, refs);
              else inner += render([t], refs);
            }
          } else {
            inner = render(it.tokens, refs);
          }
          let li = '<li>';
          if (it.task) {
            const inputHtml = '<input' + (it.checked ? ' checked=""' : '') + ' disabled="" type="checkbox"> ';
            // in a loose list the item content is wrapped in <p> — the
            // checkbox goes inside the paragraph, not before it
            if (inner.startsWith('<p>')) {
              html += li + '<p>' + inputHtml + inner.slice(3) + '</li>\n';
            } else {
              html += li + inputHtml + inner + '</li>\n';
            }
          } else {
            html += li + inner + '</li>\n';
          }
        }
        html += '</' + tag + '>\n';
        break;
      }
      case 'html':
        html += tok.text;
        break;
      case 'table': {
        html += '<table>\n<thead>\n<tr>\n';
        for (let c = 0; c < tok.head.length; c++) {
          const al = tok.align[c] ? ' align="' + tok.align[c] + '"' : '';
          html += '<th' + al + '>' + inline(tok.head[c], refs) + '</th>\n';
        }
        html += '</tr>\n</thead>\n';
        if (tok.rows.length) {
          html += '<tbody>';
          for (const row of tok.rows) {
            html += '<tr>\n';
            for (let c = 0; c < tok.head.length; c++) {
              const al = tok.align[c] ? ' align="' + tok.align[c] + '"' : '';
              const cell = c < row.length ? row[c] : '';
              html += '<td' + al + '>' + inline(cell, refs) + '</td>\n';
            }
            html += '</tr>\n';
          }
          html += '</tbody>';
        }
        html += '</table>\n';
        break;
      }
    }
  }
  return html;
}

// ================= ENTRY =================
export function parse(markdown) {
  const src = markdown.replace(/\r\n|\r/g, '\n');
  const refs = new Map();
  const lines = src.split('\n');
  // A trailing '' is only the artifact of a final newline, not a real line;
  // drop it so fenced code does not swallow it as content. (The newline
  // itself is still reported via trailingNL.)
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  const tokens = lexBlocks(lines, 0, lines.length, refs, src.endsWith('\n'), true);
  return render(tokens, refs);
}
