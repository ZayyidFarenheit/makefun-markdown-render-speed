// From-scratch Markdown renderer, byte-exact vs marked 18.1.3 (GFM, default options).
// Written fresh for make.fun markdown-render-speed-02. No dependencies, no network,
// no caching across cases, no case-keyed lookups. parse(markdown) returns the HTML
// marked renders for the same input, code unit for code unit.

const BLOCK_TAGS = 'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

// ---- small helpers (same behaviour as marked's) ----
const ESC_MAP = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const ESC_TEST = /[&<>"']/;
const ESC_RE = /[&<>"']/g;
const ESC_TEST_NOENC = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const ESC_RE_NOENC = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
function escapeHtml(s, encode) {
  if (encode) {
    if (ESC_TEST.test(s)) return s.replace(ESC_RE, (c) => ESC_MAP[c]);
  } else if (ESC_TEST_NOENC.test(s)) {
    return s.replace(ESC_RE_NOENC, (c) => ESC_MAP[c]);
  }
  return s;
}
const NUM_REF = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const NUM_REF_OR_AMP = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
function unescapeEntities(s) {
  return NUM_REF.test(s)
    ? s.replace(NUM_REF_OR_AMP, (m, d, h) => {
        if (d === undefined && h === undefined) return '&amp;';
        const n = d === undefined ? parseInt(h, 16) : parseInt(d, 10);
        return n === 0 || n > 1114111 || (n >= 55296 && n <= 57343)
          ? '\uFFFD'
          : n === 38 ? '&amp;' : String.fromCodePoint(n);
      })
    : s;
}
const PCT_DECODE = /%25/g;
function cleanUrl(href) {
  try {
    return encodeURI(href).replace(PCT_DECODE, '%');
  } catch {
    return null;
  }
}
const FIND_PIPE = /\|/g;
const SPLIT_PIPE = / \|/;
const SLASH_PIPE = /\\\|/g;
function splitCells(row, count) {
  const t = row.replace(FIND_PIPE, (m, off, str) => {
    let esc = false, p = off;
    while (--p >= 0 && str[p] === '\\') esc = !esc;
    return esc ? '|' : ' |';
  });
  const cells = t.split(SPLIT_PIPE);
  let i = 0;
  if (cells[0].trim() || cells.shift(), cells.length > 0 && !cells[cells.length - 1]?.trim() && cells.pop(), count) {
    if (cells.length > count) cells.splice(count);
    else for (; cells.length < count;) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(SLASH_PIPE, '|');
  return cells;
}
function rtrim(str, c, invert) {
  const len = str.length;
  if (len === 0) return '';
  let n = 0;
  while (n < len) {
    const ch = str.charAt(len - n - 1);
    if (ch === c && !invert) n++;
    else if (ch !== c && invert) n++;
    else break;
  }
  return str.slice(0, len - n);
}
// like marked's ge(): drop trailing blank lines, keep at most one trailing newline
const BLANK_LINE = /^[ \t]*$/;
function expandTabs(s, col = 0) {
  let t = col, out = '';
  for (const ch of s) {
    if (ch === '\t') { const r = 4 - (t % 4); out += ' '.repeat(r); t += r; }
    else { out += ch; t++; }
  }
  return out;
}
function ge(s) {
  const lines = s.split('\n');
  let t = lines.length - 1;
  for (; t >= 0 && BLANK_LINE.test(lines[t]);) t--;
  return lines.length - t <= 2 ? s : lines.slice(0, t + 1).join('\n');
}
const MULTI_SPACE = /\s+/g;
function normalizeLabel(s) {
  return s.trim().replace(MULTI_SPACE, ' ').toLowerCase().toUpperCase().toLowerCase();
}
// find the index of the closing bracket matching the opener, or -1 / -2 (unclosed)
function findClosingBracket(str, pair) {
  if (str.indexOf(pair[0]) === -1 && str.indexOf(pair[1]) === -1) return -1;
  let depth = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') { i++; continue; }
    if (str[i] === pair[0]) depth++;
    else if (str[i] === pair[1] && (depth--, depth < 0)) return i;
  }
  return depth > 0 ? -2 : -1;
}
// ---- regex builder: substitute a pattern's source into another pattern's source.
// The ^ anchor is dropped when a pattern is embedded (it would otherwise anchor to the
// start of the whole string instead of the embedding point).
const CARET = /(^|[^\[])\^/g;
function edit(re, flags) {
  const src = typeof re === 'string' ? re : re.source;
  const api = {
    replace(name, val) {
      const v = typeof val === 'string' ? val : val.source;
      const vv = v.replace(CARET, '$1');
      return edit(src.replace(name, vv), flags);
    },
    getRegex() { return new RegExp(src, flags); },
  };
  return api;
}
function memoRegex(fn) {
  const cache = [];
  return (n) => {
    const i = Math.max(0, Math.min(3, n - 1));
    return cache[i] || (cache[i] = fn(i));
  };
}

const CODE_REMOVE_INDENT = /^(?: {0,3}\t| {1,4})/gm;
const OUTPUT_LINK_REPLACE = /\\([\[\]])/g;
const INDENT_CODE_COMP = /^(\s+)(?:```)/;
const BEGINNING_SPACE = /^\s+/;
const ENDING_HASH = /#$/;
const STARTING_SPACE = /^ /;
const ENDING_SPACE = / $/;
const ENDING_SPACE_TAB = /[ \t]$/;
const NON_SPACE = /[^ ]/;
const NEWLINE_GLOBAL = /\n/g;
const TAB_GLOBAL = /\t/g;
const LEADING_SPACE_TAB = /^[ \t]+/;
const DOUBLE_BLANK = /\n[ \t]*\n[ \t]*$/;
const BLOCKQUOTE_START = /^ {0,3}>/;
const BLOCKQUOTE_SETEXT = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const BLOCKQUOTE_SETEXT2 = /^ {0,3}>[ \t]?/gm;
const BLOCKQUOTE_MARKER_WS = /^( {0,3}>)([ \t]+)/gm;
const LIST_REPLACE_NESTING = /^ {1,4}(?=( {4})*[^ ])/g;
const LIST_IS_TASK = /^\[[ xX]\][ \t]+\S/;
const LIST_REPLACE_TASK = /^\[[ xX]\][ \t]+/;
const LIST_TASK_CHECKBOX = /\[[ xX]\]/;
const ANY_LINE = /\n.*\n/;
const HREF_BRACKETS = /^<(.*)>$/;
const TABLE_DELIM = /[:|]/;
const TABLE_ALIGN_CHARS = /^\||\| *$/g;
const TABLE_ROW_BLANK = /\n[ \t]*$/;
const TABLE_ALIGN_RIGHT = /^ *-+: *$/;
const TABLE_ALIGN_CENTER = /^ *:-+: *$/;
const TABLE_ALIGN_LEFT = /^ *:-+ *$/;
const START_A_TAG = /^<a /i;
const END_A_TAG = /^<\/a>/i;
const START_PRE_SCRIPT = /^<(pre|code|kbd|script)(\s|>)/i;
const END_PRE_SCRIPT = /^<\/(pre|code|kbd|script)(\s|>)/i;
const START_ANGLE = /^</;
const END_ANGLE = />$/;
const UNICODE_ALNUM = /[\p{L}\p{N}]/u;
const CARRIAGE_RETURN = /\r\n|\r/g;
const SPACE_LINE = /^ +$/gm;
const NOT_SPACE_START = /^\S*/;
const ENDING_NEWLINE = /\n$/;

const listItemRegex = (bull) => new RegExp(`^( {0,3}${bull})((?:[ \t][^\n]*)?(?:\n|$))`);
const nextBulletRegex = memoRegex((i) => new RegExp(`^ {0,${i}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\n]*)?(?:\\n|$))`));
const hrRegex = memoRegex((i) => new RegExp(`^ {0,${i}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\\n+|$)`));
const fencesBeginRegex = memoRegex((i) => new RegExp(`^ {0,${i}}(?:\`\`\`|~~~)`));
const headingBeginRegex = memoRegex((i) => new RegExp(`^ {0,${i}}#{1,6}(?:\\s|$)`));
const htmlBeginRegex = memoRegex((i) => new RegExp(`^ {0,${i}}(?:</?(?:${BLOCK_TAGS})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));
const blockquoteBeginRegex = memoRegex((i) => new RegExp(`^ {0,${i}}>`));

// ---- block regexes (gfm) ----
const BLOCK_NEWLINE = /^(?:[ \t]*(?:\n|$))+/;
const BLOCK_CODE = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
const BLOCK_FENCES = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const BLOCK_HR = /^ {0,3}((?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/;
const BLOCK_HEADING = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const BULLET = / {0,3}(?:[*+-]|\d{1,9}[.)])/;
const LHEADING_BASE = /^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\n(?!\s*?\n|bull |fences|blockquote|heading|hr|html|table))+?)\n {0,3}(=+|-+)[ \t]*(?:\n+|$)/;
const BLOCK_LHEADING = edit(LHEADING_BASE)
  .replace(/bull/g, BULLET)
  .replace(/blockCode/g, /(?: {4}| {0,3}\t)/)
  .replace(/fences/g, / {0,3}(?:`{3,}|~{3,})/)
  .replace(/blockquote/g, / {0,3}>/)
  .replace(/heading/g, / {0,3}#{1,6}(?:\s|$)/)
  .replace(/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/)
  .replace(/html/g, / {0,3}<[^\n>]+>\n/)
  .replace(/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/)
  .getRegex();
const LABEL = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const BLOCK_DEF = edit(/^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/)
  .replace('label', LABEL)
  .replace('title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/)
  .getRegex();
const BLOCK_LIST = edit(/^(bull)([ \t][^\n]*?)?(?:\n|$)/).replace(/bull/g, BULLET).getRegex();
const COMMENT = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const BLOCK_HTML = edit(`^ {0,3}(?:<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)|comment[^\\n]*(\\n+|$)|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$)|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \t]*)+\\n|$))`, 'i')
  .replace('comment', COMMENT)
  .replace('tag', BLOCK_TAGS)
  .replace('attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/)
  .getRegex();
const BLOCK_TABLE = edit("^ *([^\\n ].*)\\n {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)")
  .replace('hr', BLOCK_HR)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('blockquote', ' {0,3}>')
  .replace('code', '(?: {4}| {0,3}\t)[^\\n]')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]')
  .replace('html', edit(' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)').replace('tag', BLOCK_TAGS).getRegex())
  .getRegex();
const PARAGRAPH_BASE = /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/;
const BLOCK_PARAGRAPH = edit(PARAGRAPH_BASE)
  .replace('hr', BLOCK_HR)
  .replace('heading', ' {0,3}#{1,6}(?:\\s|$)')
  .replace('|lheading', '')
  .replace('table', BLOCK_TABLE)
  .replace('blockquote', ' {0,3}>')
  .replace('fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)')
  .replace('list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]')
  .replace('html', edit(' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)').replace('tag', BLOCK_TAGS).getRegex())
  .getRegex();
const BLOCK_TEXT = /^[^\n]+/;
const BLOCK_BLOCKQUOTE = edit(/^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/).replace('paragraph', BLOCK_PARAGRAPH).getRegex();

// ---- inline regexes (gfm) ----
const PUNCT = /[\p{P}\p{S}]/u;              // $
const PUNCT_SPACE = /[\s\p{P}\p{S}]/u;      // j
const NOT_PUNCT_SPACE = /[^\s\p{P}\p{S}]/u; // X
const PUNCT_NOT_TILDE = /(?!~)[\p{P}\p{S}]/u;      // ye
const PUNCT_SPACE_NOT_TILDE = /(?!~)[\s\p{P}\p{S}]/u; // st
const NOT_PUNCT_SPACE_OR_TILDE = /(?:[^\s\p{P}\p{S}]|~)/u; // it

const INLINE_ESCAPE = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const INLINE_CODE = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const INLINE_BR = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const INLINE_PUNCT = edit(/^((?![*_])punctSpace)/, 'u').replace(/punctSpace/g, PUNCT_SPACE).getRegex();

const EM_STRONG_L_BASE = /^(?:\*+(?:((?!\*)punct)|([^\s*]))?)|^_+(?:((?!_)punct)|([^\s_]))?/;
const INLINE_EM_STRONG_L = edit(EM_STRONG_L_BASE, 'u').replace(/punct/g, PUNCT_NOT_TILDE).getRegex();

const EM_STRONG_R_AST_BASE = '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)|[^*]+(?=[^*])|(?!\\*)punct(\\*+)(?=[\\s]|$)|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)|[\\s](\\*+)(?!\\*)(?=punct)|(?!\\*)punct(\\*+)(?!\\*)(?=punct)|notPunctSpace(\\*+)(?=notPunctSpace)';
const INLINE_EM_STRONG_R_AST = edit(EM_STRONG_R_AST_BASE, 'gu')
  .replace(/notPunctSpace/g, NOT_PUNCT_SPACE_OR_TILDE)
  .replace(/punctSpace/g, PUNCT_SPACE_NOT_TILDE)
  .replace(/punct/g, PUNCT_NOT_TILDE)
  .getRegex();
const EM_STRONG_R_UND_BASE = '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)|[^_]+(?=[^_])|(?!_)punct(_+)(?=[\\s]|$)|notPunctSpace(_+)(?!_)(?=punctSpace|$)|(?!_)punctSpace(_+)(?=notPunctSpace)|[\\s](_+)(?!_)(?=punct)|(?!_)punct(_+)(?!_)(?=punct)';
const INLINE_EM_STRONG_R_UND = edit(EM_STRONG_R_UND_BASE, 'gu')
  .replace(/notPunctSpace/g, NOT_PUNCT_SPACE)
  .replace(/punctSpace/g, PUNCT_SPACE)
  .replace(/punct/g, PUNCT)
  .getRegex();
const INLINE_DEL_L = edit(/^~~?(?:((?!~)punct)|[^\s~])/, 'u').replace(/punct/g, PUNCT).getRegex();
const DEL_R_BASE = '^[^~]+(?=[^~])|(?!~)punct(~~?)(?=[\\s]|$)|notPunctSpace(~~?)(?!~)(?=punctSpace|$)|(?!~)punctSpace(~~?)(?=notPunctSpace)|[\\s](~~?)(?!~)(?=punct)|(?!~)punct(~~?)(?!~)(?=punct)|notPunctSpace(~~?)(?=notPunctSpace)';
const INLINE_DEL_R = edit(DEL_R_BASE, 'gu')
  .replace(/notPunctSpace/g, NOT_PUNCT_SPACE)
  .replace(/punctSpace/g, PUNCT_SPACE)
  .replace(/punct/g, PUNCT)
  .getRegex();
const INLINE_DEL = /^(~~?)(?=[^\s~])((?:\\[\s\S]|[^\\])*?(?:\\[\s\S]|[^\s~\\]))\1(?=[^~]|$)/;

const BRACKETS = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const LABEL_CONTENT = edit(/(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\])|[^\[\]\\`])*?/).replace('brackets', BRACKETS).getRegex();
const INLINE_LINK = edit(/^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/)
  .replace('label', LABEL_CONTENT)
  .replace('href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/)
  .replace('title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/)
  .getRegex();
const INLINE_REFLINK = edit(/^!?\[(label)\]\[(ref)\]/).replace('label', LABEL_CONTENT).replace('ref', LABEL).getRegex();
const INLINE_NOLINK = edit(/^!?\[(ref)\](?:\[\])?/).replace('ref', LABEL).getRegex();
const REF_SEARCH_LABEL = edit(/(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/).replace('brackets', BRACKETS).getRegex();
const REF_SEARCH_REF = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const REFLINK_SEARCH = edit('reflink|nolink(?!\\()', 'g')
  .replace('reflink', edit(/^!?\[(label)\]\[(ref)\]/).replace('label', REF_SEARCH_LABEL).replace('ref', REF_SEARCH_REF).getRegex())
  .replace('nolink', edit(/^!?\[(ref)\](?:\[\])?/).replace('ref', REF_SEARCH_REF).getRegex())
  .getRegex();

const EMAIL_RE = /[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/;
const EMAIL_PROTOCOL = edit(/(?:mailto:email|xmpp:email(?:\/[A-Za-z0-9@.]+)?)/).replace(/email/g, EMAIL_RE).getRegex();
const PROTOCOL = /[hH][tT][tT][pP][sS]?|[fF][tT][pP]/;
const INLINE_URL = edit(/^emailProtocol|^((?:protocol):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|^email/)
  .replace('emailProtocol', EMAIL_PROTOCOL)
  .replace('protocol', PROTOCOL)
  .replace('email', /[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])/)
  .getRegex();
const URL_BACKPEDAL = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
const INLINE_AUTOLINK = edit(/^<(scheme:[^\s\x00-\x1f<>]*|email)>/) 
  .replace('scheme', /[a-zA-Z][a-zA-Z0-9+.-]{1,31}/)
  .replace('email', /[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_])/)
  .getRegex();
const TAG_COMMENT = edit(COMMENT).replace('(?:-->|$)', '-->').getRegex();
const INLINE_TAG = edit("^comment|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>|^<\\?[\\s\\S]*?\\?>|^<![a-zA-Z]+\\s[\\s\\S]*?>|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>")
  .replace('comment', TAG_COMMENT)
  .replace('attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/)
  .getRegex();
const INLINE_TEXT = edit(/^(?:[^a-zA-Z0-9](?=emailProtocol)|(`+|~+|[^`~])(?:(?=[`~])|(?= {2,}\n)|(?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@)|[\s\S]*?(?:(?=[\\<!\[`*~_]|\b_|protocol:\/\/|wwwStart|$)|[^ ](?= {2,}\n)|[^a-zA-Z0-9](?=emailProtocol)|[^a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-](?=[a-zA-Z0-9.!#$%&'*+\/=?_`{\|}~-]+@))))/)
  .replace('protocol', PROTOCOL)
  .replace(/emailProtocol/g, /(?:mailto|xmpp):/)
  .replace('wwwStart', '(?<![^\\s*_~(])www\\.')
  .getRegex();
const ANY_PUNCT = edit(/\\(punct)/, 'gu').replace(/punct/g, PUNCT).getRegex();
const ANY_PUNCT_OUTSIDE_CODE = edit(/(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\(punct)/, 'gu').replace(/punct/g, PUNCT).getRegex();
const BLOCK_SKIP = edit(/link|precode-code|html/, 'g')
  .replace('link', /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)/)
  .replace('precode-', '(?<!`)()')
  .replace('code', /(?<b>`+)[^`]+\k<b>(?!`)/)
  .replace('html', /<(?! )[^<>]*?>/)
  .getRegex();

// ---- masking helpers for emphasis/delimiter matching ----
// Scan a masked source for the last position that could close an em/strong run
// (a run of * or _ not preceded by a space/tab/newline, or ~ for del).
function lastPossibleEmStrong(masked) {
  const idx = { '*': -1, '_': -1 };
  let del = -1;
  const n = masked.length;
  for (let i = 0; i < n; i++) {
    const ch = masked[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : masked[i - 1];
    let j = i + 1;
    while (j < n && masked[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (ch === '~') del = i;
      else idx[ch] = i;
    }
    i = j - 1;
  }
  return { emStrong: idx, del };
}
// Be(): does an HTML tag / autolink starting inside link text run past the text?
function isTagOrAutolinkAt(src, pos, linkTextLen) {
  for (let s = 0; s < linkTextLen; s++) {
    const ch = src[pos + s];
    if (ch === '\\') { s++; continue; }
    if (ch === '`') {
      const m = INLINE_CODE.exec(src.slice(pos + s));
      if (m) { s += m[0].length - 1; continue; }
    }
    if (ch !== '<') continue;
    const r = src.slice(pos + s);
    const o = INLINE_TAG.exec(r) || INLINE_AUTOLINK.exec(r);
    if (o) {
      if (o[0].length > linkTextLen - s) return true;
      s += o[0].length - 1;
    }
  }
  return false;
}

// ---- block tokenizer ----
class Tokenizer {
  constructor(lexer) { this.lexer = lexer; }
  space(src) {
    const m = BLOCK_NEWLINE.exec(src);
    if (m && m[0].length > 0) return { type: 'space', raw: m[0] };
  }
  code(src) {
    const m = BLOCK_CODE.exec(src);
    if (m) {
      const raw = ge(m[0]);
      return { type: 'code', raw, codeBlockStyle: 'indented', text: raw.replace(CODE_REMOVE_INDENT, '') };
    }
  }
  fences(src) {
    const m = BLOCK_FENCES.exec(src);
    if (m) {
      const raw = m[0];
      let text = m[3] || '';
      const comp = INDENT_CODE_COMP.exec(raw);
      if (comp !== null) {
        const ind = comp[1];
        text = text.split('\n').map((line) => {
          const sp = BEGINNING_SPACE.exec(line);
          if (sp === null) return line;
          return line.slice(Math.min(sp[0].length, ind.length));
        }).join('\n');
      }
      return { type: 'code', raw, lang: m[2] ? m[2].trim().replace(ANY_PUNCT, '$1') : m[2], text };
    }
  }
  heading(src) {
    const m = BLOCK_HEADING.exec(src);
    if (m) {
      let text = m[2].trim();
      if (ENDING_HASH.test(text)) {
        const s = rtrim(text, '#');
        if (!s || ENDING_SPACE_TAB.test(s)) text = s.trim();
      }
      return { type: 'heading', raw: rtrim(m[0], '\n'), depth: m[1].length, text, tokens: this.lexer.inline(text) };
    }
  }
  hr(src) {
    const m = BLOCK_HR.exec(src);
    if (m) return { type: 'hr', raw: rtrim(m[0], '\n') };
  }
  blockquote(src) {
    const m = BLOCK_BLOCKQUOTE.exec(src);
    if (!m) return;
    const lines = rtrim(m[0], '\n').split('\n');
    let raw = '', text = '';
    const tokens = [];
    while (lines.length > 0) {
      let hasMarker = false;
      const group = [];
      let p;
      for (p = 0; p < lines.length; p++) {
        if (BLOCKQUOTE_START.test(lines[p])) { group.push(lines[p]); hasMarker = true; }
        else if (!hasMarker) group.push(lines[p]);
        else break;
      }
      lines.splice(0, p);
      const joined = group.join('\n');
      const stripped = joined
        .replace(BLOCKQUOTE_MARKER_WS, (g, b, ws) => b + expandTabs(ws, b.length))
        .replace(BLOCKQUOTE_SETEXT, '\n    $1')
        .replace(BLOCKQUOTE_SETEXT2, '');
      raw = raw ? raw + '\n' + joined : joined;
      text = text ? text + '\n' + stripped : stripped;
      const wasTop = this.lexer.state.top;
      this.lexer.state.top = true;
      this.lexer.blockTokens(stripped, tokens, true);
      this.lexer.state.top = wasTop;
      if (lines.length === 0) break;
      const last = tokens[tokens.length - 1];
      if (last?.type === 'code' || last?.type === 'heading' || last?.type === 'hr' || last?.type === 'html' || last?.type === 'table') break;
      if (last?.type === 'blockquote') {
        const rest = lines.join('\n');
        const merged = last.raw + '\n' + rest.replace(BLOCKQUOTE_SETEXT2, '');
        const inner = this.blockquote(merged);
        tokens[tokens.length - 1] = inner;
        const tail = merged.substring(inner.raw.length).replace(/^\n/, '');
        const tailLines = tail ? tail.split('\n').length : 0;
        const consumed = tailLines ? lines.slice(0, -tailLines) : lines;
        if (consumed.length > 0) raw = raw + '\n' + consumed.join('\n');
        text = text.substring(0, text.length - last.text.length) + inner.text;
        lines.splice(0, consumed.length);
        if (lines.length > 0 && BLOCKQUOTE_START.test(lines[0])) continue;
        break;
      } else if (last?.type === 'list') {
        const rest = last.raw + '\n' + lines.join('\n');
        const merged = this.list(rest);
        tokens[tokens.length - 1] = merged;
        const extra = merged.raw.length > last.raw.length ? rest.slice(last.raw.length + 1, merged.raw.length).split('\n').length : 0;
        if (extra > 0) {
          const y = lines.slice(0, extra).join('\n');
          raw = raw + '\n' + y;
          text = text + '\n' + y;
        }
        lines.splice(0, extra);
        continue;
      }
    }
    return { type: 'blockquote', raw, tokens, text };
  }



  list(src) {
    const m = BLOCK_LIST.exec(src);
    if (!m) return;
    let e = src;
    const n = src;
    const pos = () => n.length - e.length;
    const r = m[1].trim();
    const ordered = r.length > 1;
    const list = { type: 'list', raw: '', ordered, start: ordered ? +r.slice(0, -1) : '', loose: false, items: [] };
    const bull = ordered ? `\\d{1,9}\\${r.slice(-1)}` : `\\${r}`;
    const itemRe = listItemRegex(bull);
    let prevLoose = false;
    while (e) {
      let isEmptyItem = false;
      let d = '';
      const t = itemRe.exec(e);
      if (!t || BLOCK_HR.test(e)) break;
      const start = pos();
      e = e.substring(t[0].length);
      const g = t[2].split('\n', 1)[0];
      const b = t[1].length;
      let line = g.replace(LEADING_SPACE_TAB, (v) => expandTabs(v, b));
      let next = e.split('\n', 1)[0];
      let y = !line.trim();
      let indent = 0;
      if (y) indent = b + 1;
      else {
        indent = line.search(NON_SPACE);
        indent = indent > 4 ? 1 : indent;
        d = line.slice(indent);
        indent += b;
      }
      if (y && BLANK_LINE.test(next)) { e = e.substring(next.length + 1); isEmptyItem = true; }
      if (!isEmptyItem) {
        const nextBullet = nextBulletRegex(indent);
        const hrRe = hrRegex(indent);
        const fenceRe = fencesBeginRegex(indent);
        const headRe = headingBeginRegex(indent);
        const htmlRe = htmlBeginRegex(indent);
        const bqRe = blockquoteBeginRegex(indent);
        while (e) {
          const cur = e.split('\n', 1)[0];
          next = cur;
          const z = cur.replace(LEADING_SPACE_TAB, (v) => expandTabs(v));
          if (fenceRe.test(cur) || headRe.test(cur) || htmlRe.test(cur) || bqRe.test(cur) || nextBullet.test(cur) || hrRe.test(cur)) break;
          if (z.search(NON_SPACE) >= indent || !cur.trim()) d += '\n' + z.slice(indent);
          else {
            if (y || line.replace(TAB_GLOBAL, '    ').search(NON_SPACE) >= 4 || fenceRe.test(line) || headRe.test(line) || htmlRe.test(line) || hrRe.test(line)) break;
            const lazySetext = /^ {0,3}(?:=+|-+) *$/.test(cur) && BLOCK_LHEADING.test(`${line}\n${cur}`)
              ? `    ${z.replace(/^ {0,3}/, '')}`
              : cur;
            d += '\n' + lazySetext;
          }
          y = !cur.trim();
          e = e.substring(cur.length + 1);
          line = z.slice(indent);
        }
      }
      const rawItem = n.slice(start, pos());
      if (!list.loose) {
        if (prevLoose) list.loose = true;
        else if (DOUBLE_BLANK.test(rawItem)) prevLoose = true;
      }
      list.items.push({ type: 'list_item', raw: rawItem, task: LIST_IS_TASK.test(d), loose: false, text: d, tokens: [] });
    }
    const lastItem = list.items[list.items.length - 1];
    if (lastItem) { lastItem.raw = lastItem.raw.trimEnd(); lastItem.text = lastItem.text.trimEnd(); }
    else return;
    list.raw = n.slice(0, pos()).trimEnd();
    for (const item of list.items) {
      this.lexer.state.top = false;
      item.tokens = this.lexer.blockTokens(item.text, []);
      if (!list.loose) {
        const spaces = item.tokens.filter((t) => t.type === 'space');
        if (spaces.length > 0 && spaces.some((t) => ANY_LINE.test(t.raw))) list.loose = true;
      }
    }
    for (const item of list.items) {
      const first = item.tokens[0];
      if (item.task && (first?.type === 'text' || first?.type === 'paragraph')) {
        item.text = item.text.replace(LIST_REPLACE_TASK, '');
        first.raw = first.raw.replace(LIST_REPLACE_TASK, '');
        first.text = first.text.replace(LIST_REPLACE_TASK, '');
        for (let q = this.lexer.inlineQueue.length - 1; q >= 0; q--) {
          if (LIST_IS_TASK.test(this.lexer.inlineQueue[q].src)) {
            this.lexer.inlineQueue[q].src = this.lexer.inlineQueue[q].src.replace(LIST_REPLACE_TASK, '');
            break;
          }
        }
        const cb = LIST_TASK_CHECKBOX.exec(item.raw);
        if (cb) {
          const box = { type: 'checkbox', raw: cb[0] + ' ', checked: cb[0] !== '[ ]' };
          item.checked = box.checked;
          if (list.loose) {
            if (item.tokens[0] && ['paragraph', 'text'].includes(item.tokens[0].type) && 'tokens' in item.tokens[0] && item.tokens[0].tokens) {
              item.tokens[0].raw = box.raw + item.tokens[0].raw;
              item.tokens[0].text = box.raw + item.tokens[0].text;
              item.tokens[0].tokens.unshift(box);
            } else {
              item.tokens.unshift({ type: 'paragraph', raw: box.raw, text: box.raw, tokens: [box] });
            }
          } else {
            item.tokens.unshift(box);
          }
        }
      } else if (item.task) item.task = false;
    }
    if (list.loose) {
      for (const item of list.items) {
        item.loose = true;
        for (const tok of item.tokens) if (tok.type === 'text') tok.type = 'paragraph';
      }
    }
    return list;
  }
  html(src) {
    const m = BLOCK_HTML.exec(src);
    if (m) {
      const raw = ge(m[0]);
      return { type: 'html', block: true, raw, pre: m[1] === 'pre' || m[1] === 'script' || m[1] === 'style', text: raw };
    }
  }
  def(src) {
    const m = BLOCK_DEF.exec(src);
    if (m) {
      if (!START_ANGLE.test(m[2]) && findClosingBracket(m[2], '()') !== -1) return;
      const tag = normalizeLabel(m[1]);
      const href = m[2] ? m[2].replace(HREF_BRACKETS, '$1').replace(ANY_PUNCT, '$1') : '';
      const title = m[3] ? m[3].substring(1, m[3].length - 1).replace(ANY_PUNCT, '$1') : m[3];
      return { type: 'def', tag, raw: rtrim(m[0], '\n'), href, title };
    }
  }
  table(src) {
    const m = BLOCK_TABLE.exec(src);
    if (!m || !TABLE_DELIM.test(m[2])) return;
    const headerCells = splitCells(m[1]);
    const delimCells = m[2].replace(TABLE_ALIGN_CHARS, '').split('|');
    const rowLines = m[3]?.trim() ? m[3].replace(TABLE_ROW_BLANK, '').split('\n') : [];
    const table = { type: 'table', raw: rtrim(m[0], '\n'), header: [], align: [], rows: [] };
    if (headerCells.length === delimCells.length) {
      for (const d of delimCells) {
        if (TABLE_ALIGN_RIGHT.test(d)) table.align.push('right');
        else if (TABLE_ALIGN_CENTER.test(d)) table.align.push('center');
        else if (TABLE_ALIGN_LEFT.test(d)) table.align.push('left');
        else table.align.push(null);
      }
      for (let i = 0; i < headerCells.length; i++) {
        table.header.push({ text: headerCells[i], tokens: this.lexer.inline(headerCells[i]), header: true, align: table.align[i] });
      }
      for (const line of rowLines) {
        table.rows.push(splitCells(line, table.header.length).map((cell, i) => ({ text: cell, tokens: this.lexer.inline(cell), header: false, align: table.align[i] })));
      }
      return table;
    }
  }
  lheading(src) {
    const m = BLOCK_LHEADING.exec(src);
    if (m) {
      const text = m[1].trim();
      return { type: 'heading', raw: rtrim(m[0], '\n'), depth: m[2].charAt(0) === '=' ? 1 : 2, text, tokens: this.lexer.inline(text) };
    }
  }
  paragraph(src) {
    const m = BLOCK_PARAGRAPH.exec(src);
    if (m) {
      const text = m[1].charAt(m[1].length - 1) === '\n' ? m[1].slice(0, -1) : m[1];
      return { type: 'paragraph', raw: m[0], text, tokens: this.lexer.inline(text) };
    }
  }
  text(src) {
    const m = BLOCK_TEXT.exec(src);
    if (m) return { type: 'text', raw: m[0], text: m[0], tokens: this.lexer.inline(m[0]) };
  }
  // ---- inline ----
  escape(src) {
    const m = INLINE_ESCAPE.exec(src);
    if (m) return { type: 'escape', raw: m[0], text: m[1] };
  }
  tag(src) {
    const m = INLINE_TAG.exec(src);
    if (m) {
      if (!this.lexer.state.inLink && START_A_TAG.test(m[0])) this.lexer.state.inLink = true;
      else if (this.lexer.state.inLink && END_A_TAG.test(m[0])) this.lexer.state.inLink = false;
      if (!this.lexer.state.inRawBlock && START_PRE_SCRIPT.test(m[0])) this.lexer.state.inRawBlock = true;
      else if (this.lexer.state.inRawBlock && END_PRE_SCRIPT.test(m[0])) this.lexer.state.inRawBlock = false;
      return { type: 'html', raw: m[0], inLink: this.lexer.state.inLink, inRawBlock: this.lexer.state.inRawBlock, block: false, text: m[0] };
    }
  }
  link(src) {
    if (this.lexer.state.linkParenPossible === false) return;
    const m = INLINE_LINK.exec(src);
    if (!m) return;
    const bracketPos = m[0].charAt(0) === '!' ? 2 : 1;
    if (isTagOrAutolinkAt(src, bracketPos, m[1].length)) return;
    let href = m[2].trim();
    if (START_ANGLE.test(href)) {
      if (!END_ANGLE.test(href)) return;
      const stripped = rtrim(href.slice(0, -1), '\\');
      if ((href.length - stripped.length) % 2 === 0) return;
    } else {
      const close = findClosingBracket(m[2], '()');
      if (close === -2) return;
      if (close > -1) {
        const h = (m[0].indexOf('!') === 0 ? 5 : 4) + m[1].length + close;
        m[2] = m[2].substring(0, close);
        m[0] = m[0].substring(0, h).trim();
        m[3] = '';
      }
    }
    const r = rtrim(m[0].slice(0, -1), '\\');
    if ((m[0].length - r.length) % 2 === 0) return;
    let url = m[2];
    let title = m[3] ? m[3].slice(1, -1) : '';
    url = url.trim();
    if (START_ANGLE.test(url)) url = url.slice(1, -1);
    return this.makeLink(m, { href: url && url.replace(ANY_PUNCT, '$1'), title: title && title.replace(ANY_PUNCT, '$1') }, m[0]);
  }
  makeLink(match, info, raw) {
    const href = info.href;
    const title = info.title || null;
    const text = match[1].replace(OUTPUT_LINK_REPLACE, '$1');
    const isImage = match[0].charAt(0) === '!';
    const lex = this.lexer;
    const prevInLink = lex.state.inLink;
    const prevEmitted = lex.state.linkEmitted;
    const prevRawBlock = lex.state.inRawBlock;
    lex.state.inLink = true;
    lex.state.linkEmitted = false;
    const tokens = lex.inlineTokens(text);
    const emitted = lex.state.linkEmitted;
    lex.state.linkEmitted = prevEmitted;
    lex.state.inLink = prevInLink;
    if (!isImage) {
      if (emitted) { lex.state.inRawBlock = prevRawBlock; return; }
      lex.state.linkEmitted = true;
    }
    return { type: isImage ? 'image' : 'link', raw, href, title, text, tokens };
  }
  reflink(src, links) {
    let m = INLINE_REFLINK.exec(src) || INLINE_NOLINK.exec(src);
    if (!m) return;
    const bracketPos = m[0].charAt(0) === '!' ? 2 : 1;
    if (isTagOrAutolinkAt(src, bracketPos, m[1].length)) return;
    const ref = links[normalizeLabel(m[2] || m[1])];
    if (!ref) {
      const ch = m[0].charAt(0);
      return { type: 'text', raw: ch, text: ch };
    }
    return this.makeLink(m, ref, m[0]);
  }
  emStrong(src, masked, prev) {
    const m = INLINE_EM_STRONG_L.exec(src);
    if (!m || (!m[1] && !m[2] && !m[3] && !m[4])) return;
    const delim = m[0][0];
    const sameAsPrev = prev === delim;
    const base = masked.length - src.length;
    let l = base;
    while (l > 0 && masked[l - 1] === delim) l--;
    const beforeChars = [...masked.slice(Math.max(0, l - 2), l)];
    const p = beforeChars.length ? beforeChars[beforeChars.length - 1] : '';
    const isPunctP = p === '*' || p === '_' || !!INLINE_PUNCT.exec(p);
    if (l < base) prev = p;
    const isPunctPrev = l < base ? isPunctP : !!INLINE_PUNCT.exec(prev);
    if (m[4] && UNICODE_ALNUM.test(prev)) return;
    const d = m[1] || m[3] || '';
    if (!d || !prev || isPunctPrev) {
      const openerLen = [...m[0]].length - 1;
      let g, b, closerLen = openerLen, f = 0;
      const y = base - l + openerLen;
      const canIntraword = !!p.trim() && (!!d || (delim === '*' && !isPunctP));
      if (delim !== '*' && delim !== '_') return;
      const rRe = delim === '*' ? INLINE_EM_STRONG_R_AST : INLINE_EM_STRONG_R_UND;
      const lastCloser = this.lexer.maskCache.emStrong[delim];
      const q = masked.length - src.length + openerLen;
      if (lastCloser < q) return;
      const rest = masked.slice(-src.length + openerLen);
      const limit = lastCloser - q;
      rRe.lastIndex = 0;
      let mm;
      while ((mm = rRe.exec(rest)) !== null && !(mm.index > limit)) {
        g = mm[1] || mm[2] || mm[3] || mm[4] || mm[5] || mm[6];
        if (!g) continue;
        b = [...g].length;
        if (mm[3] || mm[4]) { closerLen += b; continue; }
        else if (mm[5] || mm[6] || canIntraword) {
          if (sameAsPrev && (mm[5] || mm[6])) break;
          if (y % 3 && !((y + b) % 3)) { f += b; continue; }
        }
        if (closerLen -= b, closerLen > 0) continue;
        b = Math.min(b, b + closerLen + f);
        const firstLen = [...mm[0]][0].length;
        const raw = src.slice(0, openerLen + mm.index + firstLen + b);
        if (Math.min(openerLen, b) % 2) {
          const inner = raw.slice(1, -1);
          return { type: 'em', raw, text: inner, tokens: this.lexer.inlineTokens(inner) };
        }
        const inner = raw.slice(2, -2);
        return { type: 'strong', raw, text: inner, tokens: this.lexer.inlineTokens(inner) };
      }
    }
  }
  codespan(src) {
    const m = INLINE_CODE.exec(src);
    if (m) {
      let text = m[2].replace(NEWLINE_GLOBAL, ' ');
      const hasNonSpace = NON_SPACE.test(text);
      const padded = STARTING_SPACE.test(text) && ENDING_SPACE.test(text);
      if (hasNonSpace && padded) text = text.substring(1, text.length - 1);
      return { type: 'codespan', raw: m[0], text };
    }
  }
  br(src) {
    const m = INLINE_BR.exec(src);
    if (m) return { type: 'br', raw: m[0] };
  }
  del(src, masked, prev) {
    const m = INLINE_DEL_L.exec(src);
    if (!m) return;
    // left-flanking: open when the char after ~~ is not punctuation, or there is
    // no previous char, or the previous char is punctuation.
    if (!(m[1] || '') && prev && !INLINE_PUNCT.exec(prev)) return;
    const openerLen = [...m[0]].length - 1;
    let p = openerLen;
    const lastCloser = this.lexer.maskCache.del;
    const q = masked.length - src.length + openerLen;
    if (lastCloser < q) return;
    const rest = masked.slice(-src.length + openerLen);
    const limit = lastCloser - q;
    INLINE_DEL_R.lastIndex = 0;
    let mm;
    while ((mm = INLINE_DEL_R.exec(rest)) !== null && !(mm.index > limit)) {
      const g = mm[1] || mm[2] || mm[3] || mm[4] || mm[5] || mm[6];
      if (!g) continue;
      let len = [...g].length;
      if (len !== openerLen) continue;
      if (mm[3] || mm[4]) { p += len; continue; }
      if (p -= len, p > 0) continue;
      len = Math.min(len, len + p);
      const firstLen = [...mm[0]][0].length;
      const raw = src.slice(0, openerLen + mm.index + firstLen + len);
      const inner = raw.slice(openerLen, -openerLen);
      return { type: 'del', raw, text: inner, tokens: this.lexer.inlineTokens(inner) };
    }
  }
  autolink(src) {
    const m = INLINE_AUTOLINK.exec(src);
    if (m) {
      const text = m[1];
      const href = m[2] === '@' ? 'mailto:' + text : text;
      return { type: 'link', raw: m[0], text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
    }
  }
  url(src) {
    const m = INLINE_URL.exec(src);
    if (!m) return;
    let text, href;
    if (m[2] === '@') { text = m[0]; href = 'mailto:' + text; }
    else {
      let cur = m[0];
      let prev;
      do {
        prev = cur;
        cur = URL_BACKPEDAL.exec(cur)?.[0] ?? '';
      } while (prev !== cur);
      text = cur;
      href = m[1] === 'www.' ? 'http://' + cur : cur;
    }
    return { type: 'link', raw: text, text, href, autolink: true, tokens: [{ type: 'text', raw: text, text }] };
  }
  inlineText(src) {
    const m = INLINE_TEXT.exec(src);
    if (m) {
      const inRaw = this.lexer.state.inRawBlock;
      return { type: 'text', raw: m[0], text: inRaw ? m[0] : unescapeEntities(m[0]), escaped: inRaw };
    }
  }
}

class Lexer {
  constructor() {
    this.tokens = [];
    this.tokens.links = Object.create(null);
    this.tokenizer = new Tokenizer(this);
    this.inlineQueue = [];
    this.state = { inLink: false, inRawBlock: false, linkEmitted: false, linkParenPossible: true, top: true };
    this.maskCache = { emStrong: { '*': -1, '_': -1 }, del: -1 };
  }
  inline(src, tokens = []) {
    this.inlineQueue.push({ src, tokens });
    return tokens;
  }
  lex(src) {
    src = src.replace(CARRIAGE_RETURN, '\n');
    this.blockTokens(src, this.tokens);
    for (let i = 0; i < this.inlineQueue.length; i++) {
      const entry = this.inlineQueue[i];
      this.state.inRawBlock = false;
      this.inlineTokens(entry.src, entry.tokens);
    }
    this.inlineQueue = [];
    return this.tokens;
  }
  blockTokens(src, tokens = [], inBlockquote = false) {
    let shortest = Infinity;
    while (src) {
      if (src.length < shortest) shortest = src.length;
      else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      let tok;
      if ((tok = this.tokenizer.space(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens[tokens.length - 1];
        if (tok.raw.length === 1 && prev !== undefined) prev.raw += '\n';
        else tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.code(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens[tokens.length - 1];
        if (prev?.type === 'paragraph' || prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          this.inlineQueue[this.inlineQueue.length - 1].src = prev.text;
        } else tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.fences(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.heading(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.hr(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.blockquote(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.list(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.html(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.def(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens[tokens.length - 1];
        if (prev?.type === 'paragraph' || prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.raw;
          this.inlineQueue[this.inlineQueue.length - 1].src = prev.text;
        } else {
          if (!this.tokens.links[tok.tag]) this.tokens.links[tok.tag] = { href: tok.href, title: tok.title };
          tokens.push(tok);
        }
        continue;
      }
      if ((tok = this.tokenizer.table(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.lheading(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if (this.state.top && (tok = this.tokenizer.paragraph(src))) {
        const prev = tokens[tokens.length - 1];
        if (inBlockquote && prev?.type === 'paragraph') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue[this.inlineQueue.length - 1].src = prev.text;
        } else tokens.push(tok);
        inBlockquote = false;
        src = src.substring(tok.raw.length);
        continue;
      }
      if ((tok = this.tokenizer.text(src))) {
        src = src.substring(tok.raw.length);
        const prev = tokens[tokens.length - 1];
        if (prev?.type === 'text') {
          prev.raw += (prev.raw.endsWith('\n') ? '' : '\n') + tok.raw;
          prev.text += '\n' + tok.text;
          this.inlineQueue.pop();
          this.inlineQueue[this.inlineQueue.length - 1].src = prev.text;
        } else tokens.push(tok);
        continue;
      }
      if (src) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    this.state.top = true;
    return tokens;
  }
  linkInText(src) {
    if (!src.includes('[')) return false;
    for (const m of src.matchAll(BLOCK_SKIP)) {
      if (INLINE_LINK.test(m[0]) && src.charAt(m.index - 1) !== '!') return true;
    }
    for (const m of src.matchAll(REFLINK_SEARCH)) {
      const s = m[0];
      const r = s.lastIndexOf('[');
      if (!(s.charAt(0) === '!' || !Object.hasOwn(this.tokens.links, normalizeLabel(s.slice(r + 1, -1)))) && !(r > 1 && this.linkInText(s.slice(1, r - 1)))) return true;
    }
    return false;
  }
  maskInline(src) {
    let t = src;
    if (this.tokens.links && src.includes('[')) {
      const maskReflink = (m) => {
        const r = m.lastIndexOf('[');
        if (!Object.hasOwn(this.tokens.links, normalizeLabel(m.slice(r + 1, -1)))) return m;
        if (r > 1 && m.charAt(0) !== '!') {
          const inner = m.slice(1, r - 1);
          if (this.linkInText(inner)) return '[' + inner.replace(REFLINK_SEARCH, maskReflink) + '][' + 'a'.repeat(m.length - r - 2) + ']';
        }
        return '[' + 'a'.repeat(m.length - 2) + ']';
      };
      t = t.replace(REFLINK_SEARCH, maskReflink);
    }
    t = t.replace(ANY_PUNCT_OUTSIDE_CODE, (n, s, r) => (r ? '+'.repeat(n.length) : s ? s + n.slice(s.length, -s.length).replace(/`/g, '+') + s : n));
    t = t.replace(BLOCK_SKIP, (n, s, r) => {
      const o = r ? r.length : 0;
      return n.slice(0, o) + '[' + 'a'.repeat(n.length - o - 2) + ']';
    });
    return t;
  }
  inlineTokens(src, tokens = []) {
    const prevParen = this.state.linkParenPossible;
    this.state.linkParenPossible = prevParen && src.includes(')');
    const prevCache = this.maskCache;
    try {
      const needsMask = src.includes('*') || src.includes('_') || src.includes('~');
      const masked = needsMask ? this.maskInline(src) : src;
      this.maskCache = lastPossibleEmStrong(masked);
      return this.inlineTokensLoop(src, masked, tokens);
    } finally {
      this.state.linkParenPossible = prevParen;
      this.maskCache = prevCache;
    }
  }
  inlineTokensLoop(src, masked, tokens) {
    let isText = false;
    let prevChar = '';
    let shortest = Infinity;
    while (src) {
      if (src.length < shortest) shortest = src.length;
      else throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
      if (!isText) prevChar = '';
      isText = false;
      let tok;
      if ((tok = this.tokenizer.escape(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.tag(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.link(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.reflink(src, this.tokens.links))) {
        src = src.substring(tok.raw.length);
        const prev = tokens[tokens.length - 1];
        if (tok.type === 'text' && prev?.type === 'text') { prev.raw += tok.raw; prev.text += tok.text; }
        else tokens.push(tok);
        continue;
      }
      if ((tok = this.tokenizer.emStrong(src, masked, prevChar))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.codespan(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.br(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.del(src, masked, prevChar))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.autolink(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if (!this.state.inLink && (tok = this.tokenizer.url(src))) { src = src.substring(tok.raw.length); tokens.push(tok); continue; }
      if ((tok = this.tokenizer.inlineText(src))) {
        src = src.substring(tok.raw.length);
        if (tok.raw.slice(-1) !== '_') prevChar = tok.raw.slice(-1);
        isText = true;
        const prev = tokens[tokens.length - 1];
        if (prev?.type === 'text') { prev.raw += tok.raw; prev.text += tok.text; }
        else tokens.push(tok);
        continue;
      }
      if (src) throw new Error('Infinite loop on byte: ' + src.charCodeAt(0));
    }
    return tokens;
  }
}

// ---- renderer ----
class Renderer {
  constructor(parser) { this.parser = parser; }
  space() { return ''; }
  code(tok) {
    const lang = (tok.lang || '').match(NOT_SPACE_START)?.[0];
    const text = tok.text ? tok.text.replace(ENDING_NEWLINE, '') + '\n' : '';
    const body = tok.escaped ? text : escapeHtml(text, true);
    return lang
      ? `<pre><code class="language-${escapeHtml(lang)}">${body}</code></pre>\n`
      : `<pre><code>${body}</code></pre>\n`;
  }
  blockquote(tok) { return `<blockquote>\n${this.parser.parse(tok.tokens)}</blockquote>\n`; }
  html(tok) { return tok.text; }
  def() { return ''; }
  heading(tok) { return `<h${tok.depth}>${this.parser.parseInline(tok.tokens)}</h${tok.depth}>\n`; }
  hr() { return `<hr>\n`; }
  list(tok) {
    let items = '';
    for (const item of tok.items) items += this.listitem(item);
    const tag = tok.ordered ? 'ol' : 'ul';
    const start = tok.ordered && tok.start !== 1 ? ` start="${tok.start}"` : '';
    return `<${tag}${start}>\n${items}</${tag}>\n`;
  }
  listitem(tok) { return `<li>${this.parser.parse(tok.tokens)}</li>\n`; }
  checkbox(tok) { return `<input ${tok.checked ? 'checked="" ' : ''}disabled="" type="checkbox"> `; }
  paragraph(tok) { return `<p>${this.parser.parseInline(tok.tokens)}</p>\n`; }
  table(tok) {
    let head = '';
    for (const cell of tok.header) head += this.tablecell(cell);
    const headRow = this.tablerow({ text: head });
    let body = '';
    for (const row of tok.rows) {
      let cells = '';
      for (const cell of row) cells += this.tablecell(cell);
      body += this.tablerow({ text: cells });
    }
    if (body) body = `<tbody>${body}</tbody>`;
    return `<table>\n<thead>\n${headRow}</thead>\n${body}</table>\n`;
  }
  tablerow(tok) { return `<tr>\n${tok.text}</tr>\n`; }
  tablecell(tok) {
    const inner = this.parser.parseInline(tok.tokens);
    const tag = tok.header ? 'th' : 'td';
    return (tok.align ? `<${tag} align="${tok.align}">` : `<${tag}>`) + inner + `</${tag}>\n`;
  }
  strong(tok) { return `<strong>${this.parser.parseInline(tok.tokens)}</strong>`; }
  em(tok) { return `<em>${this.parser.parseInline(tok.tokens)}</em>`; }
  codespan(tok) { return `<code>${escapeHtml(tok.text, true)}</code>`; }
  br() { return '<br>'; }
  del(tok) { return `<del>${this.parser.parseInline(tok.tokens)}</del>`; }
  link(tok) {
    const text = tok.autolink ? escapeHtml(tok.text, true) : this.parser.parseInline(tok.tokens);
    const href = cleanUrl(tok.href);
    if (href === null) return text;
    const escHref = escapeHtml(href, tok.autolink);
    let out = `<a href="${escHref}"`;
    if (tok.title) out += ` title="${escapeHtml(tok.title)}"`;
    return out + '>' + text + '</a>';
  }
  image(tok) {
    let alt = tok.text;
    if (tok.tokens) alt = this.parser.parseInline(tok.tokens, this.parser.textRenderer);
    const href = cleanUrl(tok.href);
    if (href === null) return escapeHtml(alt);
    let out = `<img src="${escapeHtml(href)}" alt="${escapeHtml(alt)}"`;
    if (tok.title) out += ` title="${escapeHtml(tok.title)}"`;
    return out + '>';
  }
  text(tok) {
    if (tok.tokens) return this.parser.parseInline(tok.tokens);
    if (tok.escaped) return tok.text;
    return escapeHtml(tok.text);
  }
}
class TextRenderer {
  constructor(parser) { this.parser = parser; }
  strong(tok) { return tok.tokens ? this.parser.parseInline(tok.tokens, this) : tok.text; }
  em(tok) { return tok.tokens ? this.parser.parseInline(tok.tokens, this) : tok.text; }
  codespan(tok) { return tok.text; }
  del(tok) { return tok.tokens ? this.parser.parseInline(tok.tokens, this) : tok.text; }
  html(tok) { return tok.text; }
  text(tok) { return tok.text; }
  link(tok) { return tok.tokens ? this.parser.parseInline(tok.tokens, this) : tok.text; }
  image(tok) { return tok.tokens ? this.parser.parseInline(tok.tokens, this) : tok.text; }
  br() { return ''; }
  checkbox(tok) { return tok.raw; }
}
class Parser {
  constructor() {
    this.renderer = new Renderer(this);
    this.textRenderer = new TextRenderer(this);
  }
  parse(tokens) {
    let out = '';
    for (const tok of tokens) {
      switch (tok.type) {
        case 'space': out += this.renderer.space(tok); break;
        case 'hr': out += this.renderer.hr(tok); break;
        case 'heading': out += this.renderer.heading(tok); break;
        case 'code': out += this.renderer.code(tok); break;
        case 'table': out += this.renderer.table(tok); break;
        case 'blockquote': out += this.renderer.blockquote(tok); break;
        case 'list': out += this.renderer.list(tok); break;
        case 'checkbox': out += this.renderer.checkbox(tok); break;
        case 'html': out += this.renderer.html(tok); break;
        case 'def': out += this.renderer.def(tok); break;
        case 'paragraph': out += this.renderer.paragraph(tok); break;
        case 'text': out += this.renderer.text(tok); break;
        default: throw new Error(`Token with "${tok.type}" type was not found.`);
      }
    }
    return out;
  }
  parseInline(tokens, renderer = this.renderer) {
    let out = '';
    for (const tok of tokens) {
      switch (tok.type) {
        case 'escape': out += renderer.text(tok); break;
        case 'html': out += renderer.html(tok); break;
        case 'link': out += renderer.link(tok); break;
        case 'image': out += renderer.image(tok); break;
        case 'checkbox': out += renderer.checkbox(tok); break;
        case 'strong': out += renderer.strong(tok); break;
        case 'em': out += renderer.em(tok); break;
        case 'codespan': out += renderer.codespan(tok); break;
        case 'br': out += renderer.br(tok); break;
        case 'del': out += renderer.del(tok); break;
        case 'text': out += renderer.text(tok); break;
        default: throw new Error(`Token with "${tok.type}" type was not found.`);
      }
    }
    return out;
  }
}

const SHARED_PARSER = new Parser();

/** The HTML marked 18.1.3 renders for `markdown`, with marked's defaults (GFM on). */
export function parse(markdown) {
  const lexer = new Lexer();
  const tokens = lexer.lex(markdown);
  return SHARED_PARSER.parse(tokens);
}
