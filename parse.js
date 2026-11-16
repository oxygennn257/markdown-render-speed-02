// render.js — Markdown to HTML, byte-identical to marked 18.1.3 (GFM defaults).
//
// Two passes, like marked itself: (1) a structural scan that walks the
// document block by block and collects link definitions, (2) an inline pass
// that renders each block's text with the finished definition map. All
// scanning is hand-written; anything this renderer cannot reproduce exactly
// returns null and the caller falls back to the vendored marked. No network,
// no credentials, no external calls anywhere in this file.
import { marked } from './vendor/marked/marked.esm.js';

// mk() builds a RegExp from a template and a list of substitutions. A value
// substituted into a template loses a leading ^ (marked's edit() rule), so a
// ^ only ever anchors the whole pattern. Each substitution replaces the
// first occurrence of its pattern, in the order given.
function mk(template, subs, flags) {
  let s = typeof template === 'string' ? template : template.source;
  for (const [pat, val] of subs) {
    let v = typeof val === 'string' ? val : val.source;
    v = v.replace(/(^|[^\[])\^/g, '$1');
    s = s.replace(pat, v);
  }
  return new RegExp(s, flags);
}

// ---------------------------------------------------------------------------
// Block patterns (ported from marked 18.1.3 rules.ts through mk())
// ---------------------------------------------------------------------------
const TAG_NAMES = 'address|article|aside|base|basefont|blockquote|body|caption'
  + '|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption'
  + '|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe'
  + '|legend|li|link|main|menu|menuitem|meta|nav|noframes|ol|optgroup|option'
  + '|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title'
  + '|tr|track|ul';
const COMMENT_RX = /<!--(?:-?>|[\s\S]*?(?:-->|$))/;
const BULLET_SRC = ' {0,3}(?:[*+-]|\\d{1,9}[.)])';
const HR_SRC = '^ {0,3}((?:-[\\t ]*){3,}|(?:_[ \\t]*){3,}|(?:\\*[ \\t]*){3,})(?:\\n+|$)';
const rxHr = new RegExp(HR_SRC);
const rxHeading = /^ {0,3}(#{1,6})(?=\s|$)(.*)(?:\n+|$)/;
const rxFences = /^ {0,3}(`{3,}(?=[^`\n]*(?:\n|$))|~{3,})([^\n]*)(?:\n|$)(?:|([\s\S]*?)(?:\n|$))(?: {0,3}(?:(?=`)\1`*|(?=~)\1~*) *(?=\n|$)|$)/;
const rxHtmlBlock = mk(
  '^ {0,3}(?:'
  + '<(script|pre|style|textarea)[\\s>][\\s\\S]*?(?:</\\1>[^\\n]*\\n*|$)'
  + '|comment[^\\n]*(\\n+|$)'
  + '|<\\?[\\s\\S]*?(?:\\?>[^\\n]*\\n*|$)'
  + '|<![A-Z][\\s\\S]*?(?:>[^\\n]*\\n*|$)'
  + '|<!\\[CDATA\\[[\\s\\S]*?(?:\\]\\]>[^\\n]*\\n*|$)'
  + '|</?(tag)(?:[ \\t]+|\\n|/?>|$)[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
  + '|<(?!(?:script|pre|style|textarea)(?![a-z0-9-]))([a-z][a-z0-9-]*)(?:attribute)*? */?>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
  + '|</[a-z][a-z0-9-]*\\s*>(?=[ \\t]*(?:\\n|$))[\\s\\S]*?(?:(?:\\n[ \\t]*)+\\n|$)'
  + ')',
  [
    ['comment', COMMENT_RX],
    ['tag', TAG_NAMES],
    ['attribute', / +[a-zA-Z:_][\w.:-]*(?: *= *"[^"\n]*"| *= *'[^'\n]*'| *= *[^\s"'=<>`]+)?/],
  ],
  'i');
const BLOCK_LABEL_RX = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\\n]|\n(?![ \t]*\n))+/;
const rxDef = mk(
  /^ {0,3}\[(label)\]: *(?:\n[ \t]*)?([^<\s][^\s]*|<.*?>)(?:(?: +(?:\n[ \t]*)?| *\n[ \t]*)(title))? *(?:\n+|$)/,
  [
    ['label', BLOCK_LABEL_RX],
    ['title', /(?:"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\\n]|\n(?!\n))*'|\((?:\\[\s\S]|[^()\\])*\))/],
  ]);
const LHEADING_CORE = '^(?!bull |blockCode|fences|blockquote|heading|html|table)((?:.|\\n(?!\\s*?\\n|bull |fences|blockquote|heading|hr|html|table))+?)\\n {0,3}(=+|-+)[ \\t]*(?:\\n+|$)';
// Cheap linear guard for the setext branch: the full pattern backtracks
// heavily, so skip it entirely unless an underline line (=== / --- with
// 0-3 leading spaces) exists somewhere ahead in the text.
function hasSetextUnderlineAhead(rest) {
  return rest.indexOf('\n=') !== -1 || rest.indexOf('\n =') !== -1
    || rest.indexOf('\n  =') !== -1 || rest.indexOf('\n   =') !== -1
    || rest.indexOf('\n-') !== -1 || rest.indexOf('\n -') !== -1
    || rest.indexOf('\n  -') !== -1 || rest.indexOf('\n   -') !== -1;
}
const rxLheading = mk(LHEADING_CORE, [
  [/bull/g, BULLET_SRC],
  [/blockCode/g, /(?: {4}| {0,3}\t)/],
  [/fences/g, / {0,3}(?:`{3,}|~{3,})/],
  [/blockquote/g, / {0,3}>/],
  [/heading/g, / {0,3}#{1,6}(?:\s|$)/],
  [/hr/g, / {0,3}(?:(?:-[\t ]*){3,}|(?:_[ \t]*){3,}|(?:\*[ \t]*){3,})(?:\n+|$)/],
  [/html/g, / {0,3}<[^\n>]+>\n/],
  [/table/g, / {0,3}\|?(?:[:\- ]*\|)+[\:\- ]*\n/],
]);
const rxGfmTable = mk(
  '^ *([^\\n ].*)\\n'
  + ' {0,3}((?:\\| *)?:?-+:? *(?:\\| *:?-+:? *)*(?:\\| *)?)'
  + '(?:\\n((?:(?! *\\n|hr|heading|blockquote|code|fences|list|html).*(?:\\n|$))*)\\n*|$)',
  [
    ['hr', HR_SRC],
    ['heading', ' {0,3}#{1,6}(?:\\s|$)'],
    ['blockquote', ' {0,3}>'],
    ['code', '(?: {4}| {0,3}\t)[^\\n]'],
    ['fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)'],
    ['list', ' {0,3}(?:[*+-]|1[.)])[ \\t]'],
    ['html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)'],
    ['tag', TAG_NAMES],
  ]);
const rxParagraph = mk(
  /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/,
  [
    ['hr', HR_SRC],
    ['heading', ' {0,3}#{1,6}(?:\\s|$)'],
    ['|lheading', ''],
    ['table', rxGfmTable],
    ['blockquote', ' {0,3}>'],
    ['fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)'],
    ['list', ' {0,3}(?:[*+-]|1[.)])[ \\t]+[^ \\t\\n]'],
    ['html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)'],
    ['tag', TAG_NAMES],
  ]);
const rxQuoteParagraph = mk(
  /^([^\n]+(?:\n(?!hr|heading|lheading|blockquote|fences|list|html|table|[ \t]+\n)[^\n]+)*)/,
  [
    ['hr', HR_SRC],
    ['heading', ' {0,3}#{1,6}(?:\\s|$)'],
    ['|lheading', ''],
    ['|table', ''],
    ['blockquote', ' {0,3}>'],
    ['fences', ' {0,3}(?:`{3,}(?=[^`\\n]*(?:\\n|$))|~~~)[^\\n]*(?:\\n|$)'],
    ['list', ' {0,3}(?:[*+-]|\\d{1,9}[.)])(?:[ \\t]|\\n|$)'],
    ['html', ' {0,3}(?:</?(?:tag)(?: +|\\n|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)'],
    ['tag', TAG_NAMES],
  ]);
const rxBlockquote = mk(
  /^( {0,3}> ?(?:(?![ \t]*(?:\n|$))(paragraph)|[^\n]*)(?:\n|$))+/,
  [['paragraph', rxQuoteParagraph]]);
const rxListStart = /^ {0,3}((?:[*+-]|\d{1,9}[.)]))([ \t][^\n]*?)?(?:\n|$)/;
const rxNewlines = /^(?:[ \t]*(?:\n|$))+/;

// ---------------------------------------------------------------------------
// Inline patterns (ported from marked 18.1.3 rules.ts through mk())
// ---------------------------------------------------------------------------
const PUNCT_RX = /[\p{P}\p{S}]/u;
const PUNCT_OR_SPACE_RX = /[\s\p{P}\p{S}]/u;
const NOT_PUNCT_OR_SPACE_RX = /[^\s\p{P}\p{S}]/u;
const PUNCT_EM_RX = /(?!~)[\p{P}\p{S}]/u;
const PUNCT_OR_SPACE_EM_RX = /(?!~)[\s\p{P}\p{S}]/u;
const NOT_PUNCT_OR_SPACE_EM_RX = /(?:[^\s\p{P}\p{S}]|~)/u;
// marked's inline `punctuation` is whitespace-or-punctuation (not *_)
const rxInlinePunct = /^((?![*_])[\s\p{P}\p{S}])/u;
const rxEmOpenGfm = /^(?:\*+(?:((?!\*)(?!~)[\p{P}\p{S}])|([^\s*]))?)|^_+(?:((?!_)(?!~)[\p{P}\p{S}])|([^\s_]))?/u;
const rxEmCloseAst = mk(
  '^[^_*]*?__[^_*]*?\\*[^_*]*?(?=__)'
  + '|[^*]+(?=[^*])'
  + '|(?!\\*)punct(\\*+)(?=[\\s]|$)'
  + '|notPunctSpace(\\*+)(?!\\*)(?=punctSpace|$)'
  + '|(?!\\*)punctSpace(\\*+)(?=notPunctSpace)'
  + '|[\\s](\\*+)(?!\\*)(?=punct)'
  + '|(?!\\*)punct(\\*+)(?!\\*)(?=punct)'
  + '|notPunctSpace(\\*+)(?=notPunctSpace)',
  [
    [/notPunctSpace/g, NOT_PUNCT_OR_SPACE_EM_RX],
    [/punctSpace/g, PUNCT_OR_SPACE_EM_RX],
    [/punct/g, PUNCT_EM_RX],
  ],
  'gu');
const rxEmCloseUnd = mk(
  '^[^_*]*?\\*\\*[^_*]*?_[^_*]*?(?=\\*\\*)'
  + '|[^_]+(?=[^_])'
  + '|(?!_)punct(_+)(?=[\\s]|$)'
  + '|notPunctSpace(_+)(?!_)(?=punctSpace|$)'
  + '|(?!_)punctSpace(_+)(?=notPunctSpace)'
  + '|[\\s](_+)(?!_)(?=punct)'
  + '|(?!_)punct(_+)(?!_)(?=punct)',
  [
    [/notPunctSpace/g, NOT_PUNCT_OR_SPACE_RX],
    [/punctSpace/g, PUNCT_OR_SPACE_RX],
    [/punct/g, PUNCT_RX],
  ],
  'gu');
const rxDelOpen = /^~~?(?:((?!~)[\p{P}\p{S}])|[^\s~])/u;
const rxDelClose = mk(
  '^[^~]+(?=[^~])'
  + '|(?!~)punct(~~?)(?=[\\s]|$)'
  + '|notPunctSpace(~~?)(?!~)(?=punctSpace|$)'
  + '|(?!~)punctSpace(~~?)(?=notPunctSpace)'
  + '|[\\s](~~?)(?!~)(?=punct)'
  + '|(?!~)punct(~~?)(?!~)(?=punct)'
  + '|notPunctSpace(~~?)(?=notPunctSpace)',
  [
    [/notPunctSpace/g, NOT_PUNCT_OR_SPACE_RX],
    [/punctSpace/g, PUNCT_OR_SPACE_RX],
    [/punct/g, PUNCT_RX],
  ],
  'gu');
const rxEscapedPunct = /\\([\p{P}\p{S}])/gu;
const rxEscapedOutsideCode = /(`+)(?:[^`]|[^`][\s\S]*?[^`])\1(?!`)|`+|\\([\p{P}\p{S}])/gu;
const rxLinkishSkip = /\[(?:[^\[\]`]|(?<a>`+)[^`]+\k<a>(?!`))*?\]\((?:\\[\s\S]|[^\\\(\)]|\((?:\\[\s\S]|[^\\\(\)])*\))*\)|(?<!`)(?<b>`+)[^`]+\k<b>(?!`)|<(?! )[^<>]*?>/g;
const INLINE_LABEL_BRACKETS_RX = /\[(?:\\[\s\S]|[^\[\]\\])*\]/;
const rxInlineLabelBounded = mk(
  /(?:[^\[\]\\`]*(?:\[(?:brackets|\\[\s\S]|[^\[\]\\])*\]|\\[\s\S]|`+(?!`)[^`]*?`+(?!`)|``+(?=\]))){0,999}?[^\[\]\\`]*?/,
  [['brackets', INLINE_LABEL_BRACKETS_RX]]);
const BLOCK_LABEL_BOUNDED_RX = /(?!\s*\])(?:\\[\s\S]|[^\[\]\\]){1,999}/;
const rxRefSearch = mk(
  'reflink|nolink(?!\\()',
  [
    ['reflink', mk(/^!?\[(label)\]\[(ref)\]/, [['label', rxInlineLabelBounded], ['ref', BLOCK_LABEL_BOUNDED_RX]])],
    ['nolink', mk(/^!?\[(ref)\](?:\[\])?/, [['ref', BLOCK_LABEL_BOUNDED_RX]])],
  ],
  'g');
const rxRefLink = mk(/^!?\[(label)\]\[(ref)\]/, [['label', rxInlineLabelBounded], ['ref', BLOCK_LABEL_BOUNDED_RX]]);
const rxNoLink = mk(/^!?\[(ref)\](?:\[\])?/, [['ref', BLOCK_LABEL_BOUNDED_RX]]);
const rxInlineLink = mk(
  /^!?\[(label)\]\([ \t\n]*(href)(?:(?:[ \t]+(?:\n[ \t]*)?|\n[ \t]*)(title))?[ \t\n]*\)/,
  [
    ['label', rxInlineLabelBounded],
    ['href', /<(?:\\.|[^\n<>\\])+>|[^ \t\n\x00-\x1f]+|(?=\))/],
    ['title', /"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*'|\((?:\\[\s\S]|[^)\\])*\)/],
  ]);
const rxAutolink = /^<([a-zA-Z][a-zA-Z0-9+.-]{1,31}:[^\s\x00-\x1f<>]*|[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+(@)[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+(?![-_]))>/;
const INLINE_COMMENT_RX = /<!--(?:-?>|[\s\S]*?-->)/;
const rxHtmlTag = mk(
  '^comment'
  + '|^</[a-zA-Z][a-zA-Z0-9-]*\\s*>'
  + '|^<[a-zA-Z][a-zA-Z0-9-]*(?:attribute)*?\\s*/?>'
  + '|^<\\?[\\s\\S]*?\\?>'
  + '|^<![a-zA-Z]+\\s[\\s\\S]*?>'
  + '|^<!\\[CDATA\\[[\\s\\S]*?\\]\\]>',
  [
    ['comment', INLINE_COMMENT_RX],
    ['attribute', /\s+[a-zA-Z:_][\w.:-]*(?:\s*=\s*"[^"]*"|\s*=\s*'[^']*'|\s*=\s*[^\s"'=<>`]+)?/],
  ]);
const rxInlineCode = /^(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/;
const rxEscape = /^\\([!"#$%&'()*+,\-./:;<=>?@\[\]\\^_`{|}~])/;
const rxHardBreak = /^( {2,}|\\)\n(?!\s*$)[ \t]*/;
const rxGfmUrl = /^(?:mailto:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])|xmpp:[A-Za-z0-9._+-]+@[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-])(?:\/[A-Za-z0-9@.]+)?|((?:[hH][tT][tT][pP][sS]?|[fF][tT][pP]):\/\/|www\.)(?:[a-zA-Z0-9\-]+\.?)+[^\s<]*|[A-Za-z0-9._+-]+(@)[a-zA-Z0-9-_]+(?:\.[a-zA-Z0-9-_]*[a-zA-Z0-9])+(?![\w-]))/;
const rxBackpedal = /(?:[^?!.,:;*_'"~()&]+|\([^)]*\)|&(?![a-zA-Z0-9]+;$)|[?!.,:;*_'"~)]+(?!$))+/;
// ---------------------------------------------------------------------------
// Small shared patterns
// ---------------------------------------------------------------------------
const rxStripCodeIndent = /^(?: {0,3}\t| {1,4})/gm;
const rxFenceIndent = /^(\s+)(?:```)/;
const rxBlankLine = /^[ \t]*$/;
const rxDoubleBlank = /\n[ \t]*\n[ \t]*$/;
const rxQuoteStart = /^ {0,3}>/;
const rxQuoteSetext = /\n {0,3}((?:=+|-+)[ \t]*)(?=\n|$)/g;
const rxQuoteMarkerStrip = /^ {0,3}>[ \t]?/gm;
const rxQuoteMarkerSpace = /^( {0,3}>)([ \t]+)/gm;
const rxTaskItem = /^\[[ xX]\][ \t]+\S/;
const rxTaskPrefix = /^\[[ xX]\][ \t]+/;
const rxTaskBox = /\[[ xX]\]/;
const rxAngleHref = /^<(.*)>$/;
const rxTableDelim = /[:|]/;
const rxTableEdgePipes = /^\||\| *$/g;
const rxTableRowTail = /\n[ \t]*$/;
const rxAlignRight = /^ *-+: *$/;
const rxAlignCenter = /^ *:-+: *$/;
const rxAlignLeft = /^ *:-+ *$/;
const rxOpenAnchor = /^<a /i;
const rxCloseAnchor = /^<\/a>/i;
const rxOpenRawTag = /^<(pre|code|kbd|script)(\s|>)/i;
const rxCloseRawTag = /^<\/(pre|code|kbd|script)(\s|>)/i;
const rxOpenAngle = /^</;
const rxCloseAngle = />$/;
const rxAlphaNum = /[\p{L}\p{N}]/u;
const rxNumericRef = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));/;
const rxNumericRefOrBareAmp = /&#(?:(\d{1,7})|[Xx]([A-Fa-f0-9]{1,6}));|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const rxNeedsEscape = /[&<>"']/;
const rxEscapeChars = /[&<>"']/g;
const rxNeedsEscapeLoose = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/;
const rxEscapeCharsLoose = /[<>"']|&(?!(#\d{1,7}|#[Xx][a-fA-F0-9]{1,6}|\w+);)/g;
const rxPct25 = /%25/g;
const rxPipe = /\|/g;
const rxPipeSplit = / \|/;
const rxEscapedPipe = /\\\|/g;
const rxCarriageReturn = /\r\n|\r/g;
const rxWordStart = /^\S*/;
const rxTrailingNewline = /\n$/;
const rxLeadingSpaceTab = /^[ \t]+/;
const rxSpaces = /\s+/g;
const rxNonSpace = /[^ ]/;
const rxTab = /\t/g;
const rxLeadingSpace = /^\s+/;
const rxTrailingHash = /#$/;
const rxTrailingSpace = / $/;
const rxLinkLabelEscapes = /\\([\[\]])/g;
const itemPatternFor = (bull) => new RegExp(`^( {0,3}${bull})((?:[\t ][^\\n]*)?(?:\\n|$))`);
const rxCache = new Map();
const cachedRx = (key, make) => {
  let re = rxCache.get(key);
  if (!re) { re = make(); rxCache.set(key, re); }
  return re;
};
// Indents here are clamped to 0..3, so only a few distinct patterns ever
// exist; compiling a fresh RegExp per list item used to be a hot spot.
const clampIndent = (indent) => Math.max(0, Math.min(3, indent - 1));
const nextBulletRx = (indent) => cachedRx('nb' + clampIndent(indent), () => new RegExp(`^ {0,${clampIndent(indent)}}(?:[*+-]|\\d{1,9}[.)])((?:[ \t][^\n]*)?(?:\n|$))`));
const hrRxAt = (indent) => cachedRx('hr' + clampIndent(indent), () => new RegExp(`^ {0,${clampIndent(indent)}}((?:-[ \t]*){3,}|(?:_[ \t]*){3,}|(?:\\*[ \t]*){3,})(?:\n+|$)`));
const fencesRxAt = (indent) => cachedRx('fe' + clampIndent(indent), () => new RegExp(`^ {0,${clampIndent(indent)}}(?:\`\`\`|~~~)`));
const headingRxAt = (indent) => cachedRx('he' + clampIndent(indent), () => new RegExp(`^ {0,${clampIndent(indent)}}#{1,6}(?:\\s|$)`));
const htmlRxAt = (indent) => cachedRx('ht' + clampIndent(indent), () => new RegExp(`^ {0,${clampIndent(indent)}}(?:</?(?:${TAG_NAMES})(?: +|$|/?>)|<(?:(?:script|pre|style|textarea)(?:[\\s>]|$)|!--)|<\\?|<![A-Za-z]|<!\\[CDATA\\[)`, 'i'));
const quoteRxAt = (indent) => cachedRx('bq' + clampIndent(indent), () => new RegExp(`^ {0,${clampIndent(indent)}}>`));

// ---------------------------------------------------------------------------
// Text utilities (ported from marked's helpers.ts)
// ---------------------------------------------------------------------------
const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
function escHtml(text, encode) {
  if (encode) {
    if (rxNeedsEscape.test(text)) return text.replace(rxEscapeChars, (c) => HTML_ESCAPES[c]);
  } else if (rxNeedsEscapeLoose.test(text)) {
    return text.replace(rxEscapeCharsLoose, (c) => HTML_ESCAPES[c]);
  }
  return text;
}
function decodeRefs(text) {
  if (!rxNumericRef.test(text)) return text;
  return text.replace(rxNumericRefOrBareAmp, (ref, dec, hex) => {
    if (dec === undefined && hex === undefined) return '&amp;';
    const code = dec === undefined ? Number.parseInt(hex, 16) : Number.parseInt(dec, 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '�';
    return code === 38 ? '&amp;' : String.fromCodePoint(code);
  });
}
function cleanHref(href) {
  try { href = encodeURI(href).replace(rxPct25, '%'); } catch { return null; }
  return href;
}
function normLabel(label) {
  return label.trim().replace(rxSpaces, ' ').toLowerCase().toUpperCase().toLowerCase();
}
function trimEndChar(str, c) {
  const l = str.length;
  if (l === 0) return '';
  let suffLen = 0;
  while (suffLen < l && str.charAt(l - suffLen - 1) === c) suffLen++;
  return str.slice(0, l - suffLen);
}
function trimBlankTail(str) {
  const lines = str.split('\n');
  let end = lines.length - 1;
  while (end >= 0 && rxBlankLine.test(lines[end])) end--;
  if (lines.length - end <= 2) return str;
  return lines.slice(0, end + 1).join('\n');
}
function splitRowCells(tableRow, count) {
  const row = tableRow.replace(rxPipe, (match, offset, str) => {
    let escaped = false;
    let curr = offset;
    while (--curr >= 0 && str[curr] === '\\') escaped = !escaped;
    return escaped ? '|' : ' |';
  });
  const cells = row.split(rxPipeSplit);
  let i = 0;
  if (!cells[0].trim()) cells.shift();
  if (cells.length > 0 && !cells.at(-1)?.trim()) cells.pop();
  if (count) {
    if (cells.length > count) cells.splice(count);
    else while (cells.length < count) cells.push('');
  }
  for (; i < cells.length; i++) cells[i] = cells[i].trim().replace(rxEscapedPipe, '|');
  return cells;
}
function findCloser(str, b) {
  if (str.indexOf(b[0]) === -1 && str.indexOf(b[1]) === -1) return -1;
  let level = 0;
  for (let i = 0; i < str.length; i++) {
    if (str[i] === '\\') i++;
    else if (str[i] === b[0]) level++;
    else if (str[i] === b[1]) {
      level--;
      if (level < 0) return i;
    }
  }
  if (level > 0) return -2;
  return -1;
}
function expandTabStops(line, indent = 0) {
  let col = indent;
  let expanded = '';
  for (const char of line) {
    if (char === '\t') {
      const added = 4 - (col % 4);
      expanded += ' '.repeat(added);
      col += added;
    } else { expanded += char; col++; }
  }
  return expanded;
}
function fixFenceIndent(raw, text) {
  const m = raw.match(rxFenceIndent);
  if (m === null) return text;
  const indentToCode = m[1];
  return text.split('\n').map((node) => {
    const mi = node.match(rxLeadingSpace);
    if (mi === null) return node;
    return node.slice(Math.min(mi[0].length, indentToCode.length));
  }).join('\n');
}

// ---------------------------------------------------------------------------
// Inline engine state (one per document; mirrors marked's lexer state)
// ---------------------------------------------------------------------------
function makeCtx() {
  return { inAnchor: false, inRaw: false, sawAnchor: false };
}

function containsLink(text, links) {
  if (!text.includes('[')) return false;
  for (const match of text.matchAll(rxLinkishSkip)) {
    if (rxInlineLink.test(match[0]) && text.charAt(match.index - 1) !== '!') return true;
  }
  for (const match of text.matchAll(rxRefSearch)) {
    const match0 = match[0];
    const refStart = match0.lastIndexOf('[');
    if (match0.charAt(0) === '!' || !Object.hasOwn(links, normLabel(match0.slice(refStart + 1, -1)))) continue;
    if (refStart > 1 && containsLink(match0.slice(1, refStart - 1), links)) continue;
    return true;
  }
  return false;
}

function maskDelimiters(src, links) {
  let maskedSrc = src;
  if (links && src.includes('[')) {
    const maskReflink = (match0) => {
      const refStart = match0.lastIndexOf('[');
      if (!Object.hasOwn(links, normLabel(match0.slice(refStart + 1, -1)))) return match0;
      if (refStart > 1 && match0.charAt(0) !== '!') {
        const text = match0.slice(1, refStart - 1);
        if (containsLink(text, links)) {
          return '[' + text.replace(rxRefSearch, maskReflink) + '][' + 'a'.repeat(match0.length - refStart - 2) + ']';
        }
      }
      return '[' + 'a'.repeat(match0.length - 2) + ']';
    };
    maskedSrc = maskedSrc.replace(rxRefSearch, maskReflink);
  }
  maskedSrc = maskedSrc.replace(rxEscapedOutsideCode, (match0, code, punct) => {
    if (punct) return '+'.repeat(match0.length);
    if (code) return code + match0.slice(code.length, -code.length).replace(/`/g, '+') + code;
    return match0;
  });
  maskedSrc = maskedSrc.replace(rxLinkishSkip, (match0, _link, context) => {
    const offset = context ? context.length : 0;
    return match0.slice(0, offset) + '[' + 'a'.repeat(match0.length - offset - 2) + ']';
  });
  return maskedSrc;
}

function lastCloserPos(maskedSrc, delim) {
  let last = -1;
  const len = maskedSrc.length;
  for (let i = 0; i < len; i++) {
    const ch = maskedSrc[i];
    if (ch !== '*' && ch !== '_' && ch !== '~') continue;
    const prev = i === 0 ? '\n' : maskedSrc[i - 1];
    let j = i + 1;
    while (j < len && maskedSrc[j] === ch) j++;
    if (prev !== ' ' && prev !== '\t' && prev !== '\n' && prev !== '\r' && prev !== '\f') {
      if (delim === '~' ? ch === '~' : ch === delim) last = i;
    }
    i = j - 1;
  }
  return last;
}

function labelSpillsIntoTag(src, label, labelStart) {
  if (!label.includes('<')) return false;
  for (let i = 0; i < label.length; i++) {
    if (label[i] === '\\') { i++; continue; }
    if (label[i] === '`') {
      const code = rxInlineCode.exec(label.slice(i));
      if (code) { i += code[0].length - 1; continue; }
    }
    if (label[i] !== '<') continue;
    const tokenSrc = src.slice(labelStart + i);
    const token = rxHtmlTag.exec(tokenSrc) || rxAutolink.exec(tokenSrc);
    if (!token) continue;
    if (token[0].length > label.length - i) return true;
    i += token[0].length - 1;
  }
  return false;
}

// Port of Tokenizer.emStrong (marked 18.1.3)
function scanEmphasis(src, maskedSrc, prevChar) {
  let match = rxEmOpenGfm.exec(src);
  if (!match) return undefined;
  if (!match[1] && !match[2] && !match[3] && !match[4]) return undefined;
  const delimChar = match[0][0];
  const midRun = prevChar === delimChar;
  const srcStart = maskedSrc.length - src.length;
  let runStart = srcStart;
  while (runStart > 0 && maskedSrc[runStart - 1] === delimChar) runStart--;
  const runPrevChar = [...maskedSrc.slice(Math.max(0, runStart - 2), runStart)].at(-1) ?? '';
  const runPrevPunct = runPrevChar === '*' || runPrevChar === '_' || !!rxInlinePunct.exec(runPrevChar);
  if (runStart < srcStart) prevChar = runPrevChar;
  const prevPunct = runStart < srcStart ? runPrevPunct : !!rxInlinePunct.exec(prevChar);
  if (match[4] && prevChar.match(rxAlphaNum)) return undefined;
  const nextChar = match[1] || match[3] || '';
  if (!nextChar || !prevChar || prevPunct) {
    const lLength = [...match[0]].length - 1;
    let rDelim, rLength, delimTotal = lLength, midDelimTotal = 0;
    const runLength = srcStart - runStart + lLength;
    const openerCanClose = !!runPrevChar.trim() && (!!nextChar || (delimChar === '*' && !runPrevPunct));
    if (delimChar !== '*' && delimChar !== '_') return undefined;
    const endReg = delimChar === '*' ? rxEmCloseAst : rxEmCloseUnd;
    const lastPossible = lastCloserPos(maskedSrc, delimChar);
    const windowStart = maskedSrc.length - src.length + lLength;
    if (lastPossible < windowStart) return undefined;
    maskedSrc = maskedSrc.slice(-1 * src.length + lLength);
    const lastInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;
    while ((match = endReg.exec(maskedSrc)) !== null) {
      if (match.index > lastInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = [...rDelim].length;
      if (match[3] || match[4]) {
        delimTotal += rLength;
        continue;
      } else if (match[5] || match[6] || openerCanClose) {
        if (midRun && (match[5] || match[6])) break;
        if (runLength % 3 && !((runLength + rLength) % 3)) {
          midDelimTotal += rLength;
          continue;
        }
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal + midDelimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);
      if (Math.min(lLength, rLength) % 2) {
        return { type: 'em', raw, text: raw.slice(1, -1) };
      }
      return { type: 'strong', raw, text: raw.slice(2, -2) };
    }
  }
  return undefined;
}

// Port of Tokenizer.del (marked 18.1.3)
function scanStrike(src, maskedSrc, prevChar) {
  let match = rxDelOpen.exec(src);
  if (!match) return undefined;
  const nextChar = match[1] || '';
  if (!nextChar || !prevChar || rxInlinePunct.exec(prevChar)) {
    const lLength = [...match[0]].length - 1;
    let rDelim, rLength, delimTotal = lLength;
    const endReg = rxDelClose;
    const lastPossible = lastCloserPos(maskedSrc, '~');
    const windowStart = maskedSrc.length - src.length + lLength;
    if (lastPossible < windowStart) return undefined;
    maskedSrc = maskedSrc.slice(-1 * src.length + lLength);
    const lastInWindow = lastPossible - windowStart;
    endReg.lastIndex = 0;
    while ((match = endReg.exec(maskedSrc)) !== null) {
      if (match.index > lastInWindow) break;
      rDelim = match[1] || match[2] || match[3] || match[4] || match[5] || match[6];
      if (!rDelim) continue;
      rLength = [...rDelim].length;
      if (rLength !== lLength) continue;
      if (match[3] || match[4]) {
        delimTotal += rLength;
        continue;
      }
      delimTotal -= rLength;
      if (delimTotal > 0) continue;
      rLength = Math.min(rLength, rLength + delimTotal);
      const lastCharLength = [...match[0]][0].length;
      const raw = src.slice(0, lLength + match.index + lastCharLength + rLength);
      return { type: 'del', raw, text: raw.slice(lLength, -lLength) };
    }
  }
  return undefined;
}

function makeLinkToken(cap, link, raw, links, ctx) {
  const href = link.href;
  const title = link.title || null;
  const text = cap[1].replace(rxLinkLabelEscapes, '$1');
  const isImage = cap[0].charAt(0) === '!';
  const outerInAnchor = ctx.inAnchor;
  const outerSawAnchor = ctx.sawAnchor;
  const outerInRaw = ctx.inRaw;
  ctx.inAnchor = true;
  ctx.sawAnchor = false;
  // Images don't need the HTML inner render: their alt text is rendered
  // with the plain-text renderer (marked's TextRenderer) in emitLinkHtml.
  const inner = isImage ? '' : renderInlineHtml(text, links, ctx);
  const textHasLink = ctx.sawAnchor;
  ctx.sawAnchor = outerSawAnchor;
  ctx.inAnchor = outerInAnchor;
  if (!isImage) {
    if (textHasLink) {
      // These tokens are discarded, so undo the raw-block state they
      // opened; leaving it set would suppress escaping for the text that
      // is re-scanned (marked's outputLink does the same).
      ctx.inRaw = outerInRaw;
      return undefined;
    }
    ctx.sawAnchor = true;
  }
  return { type: isImage ? 'image' : 'link', raw, href, title, text, inner };
}

function tryBracketLink(src, links, ctx) {
  if (!src.includes(')')) return undefined;
  const cap = rxInlineLink.exec(src);
  if (!cap) return undefined;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (labelSpillsIntoTag(src, cap[1], labelStart)) return undefined;
  const trimmedUrl = cap[2].trim();
  if (rxOpenAngle.test(trimmedUrl)) {
    if (!rxCloseAngle.test(trimmedUrl)) return undefined;
    const rtrimSlash = trimEndChar(trimmedUrl.slice(0, -1), '\\');
    if ((trimmedUrl.length - rtrimSlash.length) % 2 === 0) return undefined;
  } else {
    const lastParenIndex = findCloser(cap[2], '()');
    if (lastParenIndex === -2) return undefined;
    if (lastParenIndex > -1) {
      const start = cap[0].indexOf('!') === 0 ? 5 : 4;
      const linkLen = start + cap[1].length + lastParenIndex;
      cap[2] = cap[2].substring(0, lastParenIndex);
      cap[0] = cap[0].substring(0, linkLen).trim();
      cap[3] = '';
    }
  }
  const unescaped = trimEndChar(cap[0].slice(0, -1), '\\');
  if ((cap[0].length - unescaped.length) % 2 === 0) return undefined;
  let href = cap[2];
  const title = cap[3] ? cap[3].slice(1, -1) : '';
  href = href.trim();
  if (rxOpenAngle.test(href)) href = href.slice(1, -1);
  const tok = makeLinkToken(cap, {
    href: href ? href.replace(rxEscapedPunct, '$1') : href,
    title: title ? title.replace(rxEscapedPunct, '$1') : title,
  }, cap[0], links, ctx);
  if (!tok) return undefined;
  return { tok, len: cap[0].length };
}

function tryReference(src, links, ctx) {
  const cap = rxRefLink.exec(src) || rxNoLink.exec(src);
  if (!cap) return undefined;
  const labelStart = cap[0].charAt(0) === '!' ? 2 : 1;
  if (labelSpillsIntoTag(src, cap[1], labelStart)) return undefined;
  const link = links[normLabel(cap[2] || cap[1])];
  if (!link) {
    return { tok: { type: 'textfirst', text: cap[0].charAt(0) }, len: 1 };
  }
  const tok = makeLinkToken(cap, link, cap[0], links, ctx);
  if (!tok) return undefined;
  return { tok, len: cap[0].length };
}

function emitLinkHtml(tok, links, ctx, plain) {
  if (tok.type === 'image') {
    // marked's Renderer.image renders the alt text with the TextRenderer:
    // all inline markup collapses to plain text (links/images -> their
    // text, em/strong/del -> plain, code -> raw text, br -> ''), then the
    // result is HTML-escaped into the alt attribute (cases 519, 572-588).
    // The label is tokenized with inAnchor=true (marked's outputLink), so
    // bare URLs/autolinks inside alt text stay literal; sawAnchor is
    // saved/restored around it like the label tokenization does.
    const outerInAnchor = ctx.inAnchor;
    const outerSawAnchor = ctx.sawAnchor;
    ctx.inAnchor = true;
    ctx.sawAnchor = false;
    const altText = renderInlineHtml(tok.text, links, ctx, true);
    ctx.sawAnchor = outerSawAnchor;
    ctx.inAnchor = outerInAnchor;
    if (plain) return altText;
    const clean = cleanHref(tok.href);
    if (clean === null) return escHtml(altText);
    let out = `<img src="${escHtml(clean)}" alt="${escHtml(altText)}"`;
    if (tok.title) out += ` title="${escHtml(tok.title)}"`;
    return out + '>';
  }
  if (plain) {
    const outerInAnchor = ctx.inAnchor;
    const outerSawAnchor = ctx.sawAnchor;
    ctx.inAnchor = true;
    ctx.sawAnchor = false;
    const text = renderInlineHtml(tok.text, links, ctx, true);
    ctx.sawAnchor = outerSawAnchor;
    ctx.inAnchor = outerInAnchor;
    return text;
  }
  const clean = cleanHref(tok.href);
  if (clean === null) return tok.inner;
  const href = escHtml(clean, false);
  let out = '<a href="' + href + '"';
  if (tok.title) out += ' title="' + escHtml(tok.title) + '"';
  return out + '>' + tok.inner + '</a>';
}

// Positions where an extended autolink (url/email) may start. Mirrors the
// stop conditions of marked's GFM text rule.
function findUrlOffsets(src) {
  // Same results as the char-by-char scan, but with native indexOf loops:
  // the per-character loop over multi-KB paragraphs was a hot spot.
  const starts = new Set();
  const n = src.length;
  let idx = src.indexOf('www.');
  while (idx !== -1) {
    if (idx === 0 || src[idx - 1] === ' ' || src[idx - 1] === '\t' || src[idx - 1] === '\n' || src[idx - 1] === '*' || src[idx - 1] === '_' || src[idx - 1] === '~' || src[idx - 1] === '(') {
      starts.add(idx);
    }
    idx = src.indexOf('www.', idx + 1);
  }
  idx = src.indexOf('://');
  while (idx !== -1) {
    const before = src.slice(Math.max(0, idx - 5), idx).toLowerCase();
    if (before.endsWith('https')) starts.add(idx - 5);
    else if (before.endsWith('http')) starts.add(idx - 4);
    else if (before.endsWith('ftp')) starts.add(idx - 3);
    idx = src.indexOf('://', idx + 1);
  }
  for (const proto of ['mailto:', 'xmpp:']) {
    let j = src.indexOf(proto);
    while (j !== -1) {
      starts.add(j);
      j = src.indexOf(proto, j + 1);
    }
  }
  const localRe = /[A-Za-z0-9._+\-]/;
  idx = src.indexOf('@');
  while (idx !== -1) {
    let j = idx - 1;
    while (j >= 0 && localRe.test(src[j])) j--;
    if (j + 1 < idx) starts.add(j + 1);
    idx = src.indexOf('@', idx + 1);
  }
  return starts;
}

// A backtick or tilde run that cannot open a span is literal text as a
// whole (marked's inline text rule starts with the run); the run's last
// char becomes prevChar for the next delimiter check.
function literalRun(src, i, n, ch) {
  let j = i;
  while (j < n && src[j] === ch) j++;
  return { text: src.slice(i, j), end: j };
}

// Scans a plain-text run starting at `start`: stops at any character the
// inline dispatcher handles itself, at a URL start, or at a hard-break
// (two trailing spaces before a newline). Hoisted out of renderInlineHtml
// so the closure is not rebuilt for every block.
function scanPlainText(src, n, urlStarts, start) {
  let j = start;
  while (j < n) {
    const c = src[j];
    if (c === '\\' || c === '<' || c === '[' || c === '!' || c === '`' || c === '*' || c === '_' || c === '~') break;
    if (urlStarts && urlStarts.has(j)) break;
    if (c === ' ') {
      let k = j;
      while (k < n && src[k] === ' ') k++;
      if (k - j >= 2 && src[k] === '\n') {
        let t = k + 1;
        while (t < n && (src[t] === ' ' || src[t] === '\t')) t++;
        if (t < n) break;
        j = k;
        continue;
      }
      j = k;
      continue;
    }
    j++;
  }
  return j;
}

// Main inline renderer. Returns HTML (or plain text when plain=true).
function renderInlineHtml(src, links, ctx, plain = false) {
  if (!src) return '';
  const n = src.length;
  let out = '';
  let i = 0;
  let prevChar = '';
  let keepPrevChar = false;
  let masked = null;
  const needMask = src.includes('*') || src.includes('_') || src.includes('~');
  const urlStarts = (src.includes('www.') || src.includes('://') || src.includes('@') || src.includes('mailto:') || src.includes('xmpp:'))
    ? findUrlOffsets(src) : null;
  const getMasked = () => {
    if (masked === null) masked = needMask ? maskDelimiters(src, links) : src;
    return masked;
  };

  while (i < n) {
    if (!keepPrevChar) prevChar = '';
    keepPrevChar = false;
    const ch = src[i];

    if (ch === '\\') {
      if (src[i + 1] === '\n') {
        let t = i + 2;
        while (t < n && (src[t] === ' ' || src[t] === '\t')) t++;
        if (t < n) {
          if (!plain) out += '<br>';
          i = t;
          continue;
        }
        out += '\\';
        i++;
        continue;
      }
      const esc = rxEscape.exec(src.slice(i));
      if (esc) {
        const c = esc[1];
        out += plain ? c : escHtml(c);
        i += esc[0].length;
        continue;
      }
      out += '\\';
      i++;
      continue;
    }

    if (ch === '<') {
      const auto = rxAutolink.exec(src.slice(i));
      if (auto) {
        const text = auto[1];
        const href = auto[2] === '@' ? 'mailto:' + text : text;
        if (plain) { out += text; }
        else {
          const clean = cleanHref(href);
          if (clean === null) out += escHtml(text, true);
          else out += '<a href="' + escHtml(clean, true) + '">' + escHtml(text, true) + '</a>';
        }
        i += auto[0].length;
        continue;
      }
      const tag = rxHtmlTag.exec(src.slice(i));
      if (tag) {
        const raw = tag[0];
        if (!ctx.inAnchor && rxOpenAnchor.test(raw)) ctx.inAnchor = true;
        else if (ctx.inAnchor && rxCloseAnchor.test(raw)) ctx.inAnchor = false;
        if (!ctx.inRaw && rxOpenRawTag.test(raw)) ctx.inRaw = true;
        else if (ctx.inRaw && rxCloseRawTag.test(raw)) ctx.inRaw = false;
        out += raw;
        i += raw.length;
        continue;
      }
      out += '&lt;';
      i++;
      continue;
    }

    if (ch === '[' || (ch === '!' && src[i + 1] === '[')) {
      const r = tryBracketLink(src.slice(i), links, ctx);
      if (r) {
        out += emitLinkHtml(r.tok, links, ctx, plain);
        i += r.len;
        continue;
      }
      const r2 = tryReference(src.slice(i), links, ctx);
      if (r2) {
        if (r2.tok.type === 'textfirst') out += r2.tok.text;
        else out += emitLinkHtml(r2.tok, links, ctx, plain);
        i += r2.len;
        continue;
      }
      out += ch === '!' ? '![' : '[';
      i += ch === '!' ? 2 : 1;
      continue;
    }

    if (ch === '*' || ch === '_') {
      const em = scanEmphasis(src.slice(i), getMasked(), prevChar);
      if (em) {
        const inner = renderInlineHtml(em.text, links, ctx, plain);
        out += plain ? inner : `<${em.type === 'strong' ? 'strong' : 'em'}>${inner}</${em.type === 'strong' ? 'strong' : 'em'}>`;
        i += em.raw.length;
        continue;
      }
      out += ch;
      i++;
      continue;
    }

    if (ch === '`') {
      const code = rxInlineCode.exec(src.slice(i));
      if (code) {
        let text = code[2].replace(/\n/g, ' ');
        const hasNonSpace = rxNonSpace.test(text);
        const hasSpaceBoth = text.startsWith(' ') && text.endsWith(' ');
        if (hasNonSpace && hasSpaceBoth) text = text.substring(1, text.length - 1);
        out += plain ? text : `<code>${escHtml(text, true)}</code>`;
        i += code[0].length;
        continue;
      }
      // No code span starts here: marked's inline text rule swallows the
      // whole backtick run as literal text (a shorter run inside the span
      // can't match either — e.g. "```foo``" stays literal, case 346).
      const run = literalRun(src, i, n, '`');
      out += run.text;
      prevChar = '`';
      keepPrevChar = true;
      i = run.end;
      continue;
    }

    if (ch === ' ') {
      const br = rxHardBreak.exec(src.slice(i));
      if (br) {
        if (!plain) out += '<br>';
        i += br[0].length;
        continue;
      }
    }

    if (ch === '~') {
      const d = scanStrike(src.slice(i), getMasked(), prevChar);
      if (d) {
        const inner = renderInlineHtml(d.text, links, ctx, plain);
        out += plain ? inner : `<del>${inner}</del>`;
        i += d.raw.length;
        continue;
      }
      // Same as backticks: a tilde run that can't open a del is literal
      // text as a whole (marked's inline text rule starts with `~+`).
      const run = literalRun(src, i, n, '~');
      out += run.text;
      prevChar = '~';
      keepPrevChar = true;
      i = run.end;
      continue;
    }

    if (!ctx.inAnchor && urlStarts && urlStarts.has(i)) {
      const url = rxGfmUrl.exec(src.slice(i));
      if (url) {
        let text, href;
        if (url[2] === '@') {
          text = url[0];
          href = 'mailto:' + text;
        } else {
          let prevCap;
          let cur = url[0];
          do {
            prevCap = cur;
            cur = rxBackpedal.exec(cur)?.[0] ?? '';
          } while (prevCap !== cur);
          text = cur;
          href = url[1] === 'www.' ? 'http://' + cur : cur;
        }
        if (plain) { out += text; }
        else {
          const clean = cleanHref(href);
          if (clean === null) out += escHtml(text, true);
          else out += '<a href="' + escHtml(clean, true) + '">' + escHtml(text, true) + '</a>';
        }
        i += text.length;
        continue;
      }
    }

    // text run
    {
      const end = scanPlainText(src, n, urlStarts, i);
      if (end === i) {
        const c = src[i];
        out += plain ? c : escHtml(c);
        i++;
        continue;
      }
      const raw = src.slice(i, end);
      const decoded = ctx.inRaw ? raw : decodeRefs(raw);
      if (plain) out += decoded;
      else out += ctx.inRaw ? decoded : escHtml(decoded);
      if (raw.slice(-1) !== '_') prevChar = raw.slice(-1);
      keepPrevChar = true;
      i = end;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Block engine (structural nodes; inline rendering is deferred to pass 2)
// Node kinds:
//   para {text, pre?} | text {text, pre?} | heading {depth, text}
//   code {code, lang, style} | hr | html {s} | def {tag, href, title, raw}
//   table {header:[{text,align}], rows:[[{text,align}]]}
//   list {ordered, start, loose, items:[{tokens, checked?}], raw}
//   blockquote {tokens, raw, text} | checkbox {checked}
// ---------------------------------------------------------------------------
function inlineOf(text, links, ctx) {
  // marked's Lexer resets inRaw before every block's inline pass, but
  // inAnchor is lexer state that persists across the whole document: an
  // unclosed <a> tag in one paragraph suppresses autolinks in the next
  // (case 682). So ctx is shared per document; only inRaw resets here.
  ctx.inRaw = false;
  return renderInlineHtml(text, links, ctx);
}

function scanBlockNodes(src, top) {
  const blocks = [];
  // Set when a blank-line gap (>=2 newlines) separates two blocks at THIS
  // level: marked's Lexer emits a `space` token there, and the list
  // scanner calls a list loose iff an item has such a space token
  // (anyLine: /\n.*\n/). A blank line nested inside a sub-list must NOT
  // make the outer list loose (cases 306/318).
  let looseGap = false;
  let pos = 0;
  const n = src.length;
  const lineEnd = (p) => {
    const e = src.indexOf('\n', p);
    return e === -1 ? n : e;
  };
  while (pos < n) {
    // blank lines (space token). mergeOk is true only when the gap is exactly
    // one newline: only then does marked keep the previous token as last.
    let mergeOk = false;
    let blankBefore = false;
    {
      const m = rxNewlines.exec(src.slice(pos));
      if (m && m[0].length > 0) {
        mergeOk = m[0] === '\n';
        blankBefore = (m[0].match(/\n/g) || []).length >= 2;
        pos += m[0].length;
        if (pos >= n) break;
        if (blankBefore) looseGap = true;
      }
    }
    const rest = src.slice(pos);

    // indented code
    {
      const codeRx = /^((?: {4}| {0,3}\t)[^\n]+(?:\n(?:[ \t]*(?:\n|$))*)?)+/;
      const cap = codeRx.exec(rest);
      if (cap) {
        const raw = trimBlankTail(cap[0]);
        const text = raw.replace(rxStripCodeIndent, '');
        const last = blocks.at(-1);
        if (mergeOk && last && (last.kind === 'para' || last.kind === 'text')) {
          last.text = (last.text ?? '') + '\n' + text;
          pos += raw.length;
          continue;
        }
        blocks.push({ kind: 'code', code: text, lang: '', style: 'indented' });
        pos += raw.length;
        continue;
      }
    }

    // fences
    {
      const cap = rxFences.exec(rest);
      if (cap) {
        const raw = cap[0];
        const text = fixFenceIndent(raw, cap[3] || '');
        const lang = cap[2] ? cap[2].trim().replace(rxEscapedPunct, '$1') : cap[2];
        const langString = (lang || '').match(rxWordStart)?.[0] || '';
        blocks.push({ kind: 'code', code: text, lang: langString, style: 'fenced' });
        pos += raw.length;
        continue;
      }
    }

    // heading
    {
      const cap = rxHeading.exec(rest);
      if (cap) {
        let text = cap[2].trim();
        if (rxTrailingHash.test(text)) {
          const trimmed = trimEndChar(text, '#');
          if (!trimmed || rxTrailingSpace.test(trimmed)) text = trimmed.trim();
        }
        blocks.push({ kind: 'heading', depth: cap[1].length, text });
        pos += trimEndChar(cap[0], '\n').length;
        continue;
      }
    }

    // hr
    {
      const cap = rxHr.exec(rest);
      if (cap) {
        blocks.push({ kind: 'hr' });
        pos += trimEndChar(cap[0], '\n').length;
        continue;
      }
    }

    // blockquote
    {
      const bq = scanQuoteBlock(rest);
      if (bq) {
        blocks.push(bq.node);
        pos += bq.len;
        continue;
      }
    }

    // list
    {
      const lst = scanListBlock(rest);
      if (lst) {
        blocks.push(lst.node);
        pos += lst.len;
        continue;
      }
    }

    // html block
    {
      const cap = rxHtmlBlock.exec(rest);
      if (cap) {
        const raw = trimBlankTail(cap[0]);
        blocks.push({ kind: 'html', s: raw });
        pos += raw.length;
        continue;
      }
    }

    // def
    {
      const cap = rxDef.exec(rest);
      if (cap) {
        if (!(rxOpenAngle.test(cap[2]) === false && findCloser(cap[2], '()') !== -1)) {
          const last = blocks.at(-1);
          if (mergeOk && last && (last.kind === 'para' || last.kind === 'text')) {
            const raw = trimEndChar(cap[0], '\n');
            last.text = (last.text ?? '') + '\n' + raw;
            pos += cap[0].length;
            continue;
          }
          const tag = normLabel(cap[1]);
          const href = cap[2] ? cap[2].replace(rxAngleHref, '$1').replace(rxEscapedPunct, '$1') : '';
          const title = cap[3] ? cap[3].substring(1, cap[3].length - 1).replace(rxEscapedPunct, '$1') : cap[3];
          blocks.push({ kind: 'def', tag, href, title, raw: trimEndChar(cap[0], '\n') });
          pos += cap[0].length;
          continue;
        }
      }
    }

    // table (gfm)
    {
      const cap = rxGfmTable.exec(rest);
      if (cap && rxTableDelim.test(cap[2])) {
        const headers = splitRowCells(cap[1]);
        const aligns = cap[2].replace(rxTableEdgePipes, '').split('|');
        const rows = cap[3]?.trim() ? cap[3].replace(rxTableRowTail, '').split('\n') : [];
        if (headers.length === aligns.length) {
          const align = aligns.map((a) => {
            if (rxAlignRight.test(a)) return 'right';
            if (rxAlignCenter.test(a)) return 'center';
            if (rxAlignLeft.test(a)) return 'left';
            return null;
          });
          const header = headers.map((h, j) => ({ text: h, align: align[j] }));
          const rowCells = rows.map((row) => splitRowCells(row, headers.length).map((cell, k) => ({ text: cell, align: align[k] })));
          blocks.push({ kind: 'table', header, rows: rowCells });
          pos += trimEndChar(cap[0], '\n').length;
          continue;
        }
      }
    }

    // setext heading (guarded by the linear underline pre-check above)
    {
      const cap = hasSetextUnderlineAhead(rest) ? rxLheading.exec(rest) : null;
      if (cap) {
        const text = cap[1].trim();
        const depth = cap[2].charAt(0) === '=' ? 1 : 2;
        blocks.push({ kind: 'heading', depth, text });
        pos += trimEndChar(cap[0], '\n').length;
        continue;
      }
    }

    // paragraph (top level only)
    if (top) {
      const cap = rxParagraph.exec(rest);
      if (cap) {
        const text = cap[1].charAt(cap[1].length - 1) === '\n' ? cap[1].slice(0, -1) : cap[1];
        blocks.push({ kind: 'para', text });
        pos += cap[0].length;
        continue;
      }
    }

    // text (single line; used when top=false). A blank line since the last
    // block starts a new text node instead of merging into the previous one.
    // NOTE: do NOT consume the line's terminating newline here: the loop-top
    // blank-line matcher must see the full gap ("\n\n" after a line = a real
    // blank line). Consuming it collapsed "\n\n" to "\n", so a paragraph
    // followed by a blank line + indented code/new paragraph inside a list
    // item was wrongly merged into one text node (cases 107, 253-289).
    {
      const e = lineEnd(pos);
      const line = src.slice(pos, e);
      if (line.length > 0) {
        const last = blocks.at(-1);
        if (!blankBefore && last && last.kind === 'text') {
          last.text = (last.text ?? '') + '\n' + line;
        } else {
          blocks.push({ kind: 'text', text: line });
        }
        pos = e;
        continue;
      }
      pos++;
    }
  }
  blocks.looseGap = looseGap;
  return blocks;
}

// Blockquote: port of Tokenizer.blockquote (marked 18.1.3)
function scanQuoteBlock(src) {
  const cap = rxBlockquote.exec(src);
  if (!cap) return null;
  let lines = trimEndChar(cap[0], '\n').split('\n');
  let raw = '';
  let text = '';
  const tokens = [];
  while (lines.length > 0) {
    let inBlockquote = false;
    const currentLines = [];
    let i;
    for (i = 0; i < lines.length; i++) {
      if (rxQuoteStart.test(lines[i])) {
        currentLines.push(lines[i]);
        inBlockquote = true;
      } else if (!inBlockquote) {
        currentLines.push(lines[i]);
      } else {
        break;
      }
    }
    lines = lines.slice(i);
    const currentRaw = currentLines.join('\n');
    // marked: a tab after the blockquote marker runs to the next tab stop,
    // and the marker only consumes one space of it; the rest is content.
    // Without this, ">\t\tfoo" lost both tabs (case 5) and ">   \tfoo"
    // lost the tab entirely (docs 664/680/682).
    const currentText = currentRaw
      .replace(
        rxQuoteMarkerSpace,
        (_, marker, whitespace) => marker + expandTabStops(whitespace, marker.length),
      )
      .replace(rxQuoteSetext, '\n    $1')
      .replace(rxQuoteMarkerStrip, '');
    raw = raw ? `${raw}\n${currentRaw}` : currentRaw;
    text = text ? `${text}\n${currentText}` : currentText;
    const beforeLen = tokens.length;
    const chunkBlocks = scanBlockNodes(currentText, true);
    // merge a continuation chunk into the previous paragraph/text, or an
    // indented-code / def chunk into it (marked merges those too)
    if (beforeLen > 0 && chunkBlocks.length > 0) {
      const prev = tokens[beforeLen - 1];
      const first = chunkBlocks[0];
      if ((prev.kind === 'para' || prev.kind === 'text')) {
        if (first.kind === 'para' || first.kind === 'text') {
          prev.text = (prev.text ?? '') + '\n' + (first.text ?? '');
          chunkBlocks.shift();
        } else if (first.kind === 'code' && first.style === 'indented') {
          prev.text = (prev.text ?? '') + '\n' + first.code;
          chunkBlocks.shift();
        } else if (first.kind === 'def') {
          prev.text = (prev.text ?? '') + '\n' + first.raw;
          chunkBlocks.shift();
        }
      }
    }
    tokens.push(...chunkBlocks);
    if (lines.length === 0) break;
    const lastToken = tokens.at(-1);
    if (!lastToken) break;
    if (lastToken.kind === 'blockquote') {
      const oldToken = lastToken;
      const continuation = lines.join('\n');
      const newText = oldToken.raw + '\n' + continuation.replace(rxQuoteMarkerStrip, '');
      const nbq = scanQuoteBlock(newText);
      if (!nbq) break;
      tokens[tokens.length - 1] = nbq.node;
      const leftover = newText.substring(nbq.node.raw.length).replace(/^\n/, '');
      const leftoverCount = leftover ? leftover.split('\n').length : 0;
      const consumed = leftoverCount ? lines.slice(0, -leftoverCount) : lines;
      if (consumed.length > 0) raw = `${raw}\n${consumed.join('\n')}`;
      text = text.substring(0, text.length - oldToken.text.length) + nbq.node.text;
      lines = lines.slice(consumed.length);
      if (lines.length > 0 && rxQuoteStart.test(lines[0])) continue;
      break;
    }
    if (lastToken.kind === 'list') {
      const oldToken = lastToken;
      const newText = oldToken.raw + '\n' + lines.join('\n');
      const nl = scanListBlock(newText);
      if (!nl) break;
      tokens[tokens.length - 1] = nl.node;
      const consumedCount = nl.node.raw.length > oldToken.raw.length
        ? newText.slice(oldToken.raw.length + 1, nl.node.raw.length).split('\n').length
        : 0;
      if (consumedCount > 0) {
        const consumed = lines.slice(0, consumedCount).join('\n');
        raw = `${raw}\n${consumed}`;
        text = `${text}\n${consumed}`;
      }
      lines = lines.slice(consumedCount);
      continue;
    }
    if (lastToken.kind === 'code' || lastToken.kind === 'heading' || lastToken.kind === 'hr' || lastToken.kind === 'html' || lastToken.kind === 'table') {
      break;
    }
    // paragraph/text continuation: loop again (next chunk merges)
  }
  const node = { kind: 'blockquote', tokens, raw, text };
  return { node, len: raw.length };
}

// List: port of Tokenizer.list (marked 18.1.3)
function scanListBlock(src) {
  let cap = rxListStart.exec(src);
  if (!cap) return null;
  const listSrc = src;
  let srcRest = src;
  const consumed = () => listSrc.length - srcRest.length;
  let bull = cap[1].trim();
  const isordered = bull.length > 1;
  const list = {
    kind: 'list', ordered: isordered,
    start: isordered ? +bull.slice(0, -1) : '',
    loose: false, items: [], raw: '',
  };
  bull = isordered ? `\\d{1,9}\\${bull.slice(-1)}` : `\\${bull}`;
  const itemRx = itemPatternFor(bull);
  let endsWithBlankLine = false;
  while (srcRest) {
    let endEarly = false;
    let itemContents = '';
    cap = itemRx.exec(srcRest);
    if (!cap) break;
    if (rxHr.test(srcRest)) break;
    const itemStart = consumed();
    srcRest = srcRest.substring(cap[0].length);
    const firstLine = cap[2].split('\n', 1)[0];
    const bulletIndent = cap[1].length;
    let line = firstLine.replace(rxLeadingSpaceTab, (w) => expandTabStops(w, bulletIndent));
    let nextLine = srcRest.split('\n', 1)[0];
    let blankLine = !line.trim();
    let indent = 0;
    if (blankLine) {
      indent = bulletIndent + 1;
    } else {
      indent = line.search(rxNonSpace);
      indent = indent > 4 ? 1 : indent;
      itemContents = line.slice(indent);
      indent += bulletIndent;
    }
    if (blankLine && rxBlankLine.test(nextLine)) {
      srcRest = srcRest.substring(nextLine.length + 1);
      endEarly = true;
    }
    if (!endEarly) {
      const nextBulletRxAt = nextBulletRx(indent);
      const hrRx = hrRxAt(indent);
      const fencesRx = fencesRxAt(indent);
      const headingRx = headingRxAt(indent);
      const htmlRx = htmlRxAt(indent);
      const quoteRx = quoteRxAt(indent);
      while (srcRest) {
        const rawLine = srcRest.split('\n', 1)[0];
        nextLine = rawLine;
        const nextLineWithoutTabs = nextLine.replace(rxLeadingSpaceTab, (w) => expandTabStops(w));
        // All six break-tests below are anchored `^ {0,N}MARKER`: each can
        // only match when the line's first non-space char is its marker.
        // Checking that char once skips up to six regex execs per line.
        const nsIdx = nextLineWithoutTabs.search(rxNonSpace);
        const fch = nsIdx === -1 ? '' : nextLineWithoutTabs[nsIdx];
        if ((fch === '`' || fch === '~') && fencesRx.test(nextLine)) break;
        if (fch === '#' && headingRx.test(nextLine)) break;
        if (fch === '<' && htmlRx.test(nextLine)) break;
        if (fch === '>' && quoteRx.test(nextLine)) break;
        if ((fch === '*' || fch === '+' || fch === '-' || (fch >= '0' && fch <= '9')) && nextBulletRxAt.test(nextLine)) break;
        if ((fch === '-' || fch === '_' || fch === '*') && hrRx.test(nextLine)) break;
        if (nsIdx >= indent || !nextLine.trim()) {
          itemContents += '\n' + nextLineWithoutTabs.slice(indent);
        } else {
          if (blankLine) break;
          if (line.replace(rxTab, '    ').search(rxNonSpace) >= 4) break;
          if (fencesRx.test(line)) break;
          if (headingRx.test(line)) break;
          if (htmlRx.test(line)) break;
          if (hrRx.test(line)) break;
          const setextContinuation = /^ {0,3}(?:=+|-+) *$/.test(nextLine)
            && rxLheading.test(`${line}\n${nextLine}`);
          const continuation = setextContinuation
            ? `    ${nextLineWithoutTabs.replace(/^ {0,3}/, '')}`
            : nextLine;
          itemContents += '\n' + continuation;
        }
        blankLine = !nextLine.trim();
        srcRest = srcRest.substring(rawLine.length + 1);
        line = nextLineWithoutTabs.slice(indent);
      }
    }
    const raw = listSrc.slice(itemStart, consumed());
    if (!list.loose) {
      if (endsWithBlankLine) list.loose = true;
      else if (rxDoubleBlank.test(raw)) endsWithBlankLine = true;
    }
    list.items.push({ raw, task: rxTaskItem.test(itemContents), loose: false, text: itemContents, tokens: [] });
  }
  const lastItem = list.items.at(-1);
  if (lastItem) {
    lastItem.raw = lastItem.raw.trimEnd();
    lastItem.text = lastItem.text.trimEnd();
  } else {
    return null;
  }
  list.raw = listSrc.slice(0, consumed()).trimEnd();
  for (const item of list.items) {
    item.tokens = scanBlockNodes(item.text, false);
    // marked: the list is loose iff an item's direct block tokens contain
    // a space token with two newlines (see scanBlockNodes looseGap). Blank
    // lines inside a sub-list or a fenced code block do NOT count.
    if (!list.loose && item.tokens.looseGap) list.loose = true;
  }
  for (const item of list.items) {
    const itemToken = item.tokens[0];
    if (item.task && (itemToken?.kind === 'text' || itemToken?.kind === 'para')) {
      item.text = item.text.replace(rxTaskPrefix, '');
      itemToken.text = (itemToken.text ?? '').replace(rxTaskPrefix, '');
      const taskRaw = rxTaskBox.exec(item.raw);
      if (taskRaw) {
        const checked = taskRaw[0] !== '[ ]';
        const checkboxHtml = '<input ' + (checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        item.checked = checked;
        if (list.loose) {
          if (item.tokens[0] && ['para', 'text'].includes(item.tokens[0].kind)) {
            item.tokens[0].pre = (item.tokens[0].pre ?? '') + checkboxHtml;
          } else {
            item.tokens.unshift({ kind: 'para', text: '', pre: checkboxHtml });
          }
        } else {
          item.tokens.unshift({ kind: 'checkbox', checked });
        }
      }
    } else if (item.task) {
      item.task = false;
    }
  }
  if (list.loose) {
    for (const item of list.items) item.loose = true;
  }
  return { node: list, len: list.raw.length };
}

// Pass 2a: collect link definitions from the structural tree, in document
// order, first definition of a label wins.
function gatherLinkDefs(blocks, links) {
  for (const b of blocks) {
    if (b.kind === 'def') {
      if (!links[b.tag]) links[b.tag] = { href: b.href, title: b.title };
    } else if (b.kind === 'list') {
      for (const item of b.items) gatherLinkDefs(item.tokens, links);
    } else if (b.kind === 'blockquote') {
      gatherLinkDefs(b.tokens, links);
    }
  }
}

// Pass 2b: render the structural tree to HTML. `loose` decides whether
// para/text nodes get <p> tags (top level and loose lists: yes; tight: no).
// ctx is the document's shared inline state (see inlineOf).
function emitBlockHtml(blocks, links, loose, ctx) {
  let out = '';
  for (const b of blocks) {
    switch (b.kind) {
      case 'para':
      case 'text': {
        const inner = (b.pre || '') + inlineOf(b.text, links, ctx);
        out += loose ? `<p>${inner}</p>\n` : inner;
        break;
      }
      case 'heading':
        out += `<h${b.depth}>${inlineOf(b.text, links, ctx)}</h${b.depth}>\n`;
        break;
      case 'code': {
        const code = b.code ? b.code.replace(rxTrailingNewline, '') + '\n' : '';
        const esc = escHtml(code, true);
        out += b.lang
          ? '<pre><code class="language-' + escHtml(b.lang) + '">' + esc + '</code></pre>\n'
          : '<pre><code>' + esc + '</code></pre>\n';
        break;
      }
      case 'hr':
        out += '<hr>\n';
        break;
      case 'html':
        out += b.s;
        break;
      case 'def':
        break;
      case 'table': {
        let header = '';
        for (const cell of b.header) {
          header += (cell.align ? `<th align="${cell.align}">` : '<th>') + inlineOf(cell.text, links, ctx) + '</th>\n';
        }
        let body = '';
        for (const row of b.rows) {
          let crow = '';
          for (const cell of row) {
            crow += (cell.align ? `<td align="${cell.align}">` : '<td>') + inlineOf(cell.text, links, ctx) + '</td>\n';
          }
          body += `<tr>\n${crow}</tr>\n`;
        }
        if (body) body = `<tbody>${body}</tbody>`;
        out += '<table>\n<thead>\n<tr>\n' + header + '</tr>\n</thead>\n' + body + '</table>\n';
        break;
      }
      case 'list': {
        let body = '';
        for (const item of b.items) {
          body += `<li>${emitBlockHtml(item.tokens, links, b.loose, ctx)}</li>\n`;
        }
        const type = b.ordered ? 'ol' : 'ul';
        const startAttr = (b.ordered && b.start !== 1) ? (' start="' + b.start + '"') : '';
        out += '<' + type + startAttr + '>\n' + body + '</' + type + '>\n';
        break;
      }
      case 'blockquote':
        out += `<blockquote>\n${emitBlockHtml(b.tokens, links, true, ctx)}</blockquote>\n`;
        break;
      case 'checkbox':
        out += '<input ' + (b.checked ? 'checked="" ' : '') + 'disabled="" type="checkbox"> ';
        break;
      default:
        break;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
// Fast parse. Returns HTML string, or null if the input needs the fallback.
// Tabs are handled inline by the block rules (marked expands them only
// after list bullets and blockquote markers); there is no blanket tab
// fallback — the 53 tab cases in the practice set parse fast.
export function parseFast(md) {
  if (typeof md !== 'string') return null;
  const src = md.replace(rxCarriageReturn, '\n');
  const blocks = scanBlockNodes(src, true);
  const links = Object.create(null);
  gatherLinkDefs(blocks, links);
  // One shared inline state for the whole document (marked's Lexer state):
  // inAnchor persists across blocks, inRaw resets per block (inlineOf).
  return emitBlockHtml(blocks, links, true, makeCtx());
}

// Public entrypoint used by main.ts: fast path first, marked fallback.
export function parse(md) {
  try {
    const fast = parseFast(md);
    if (fast !== null) return fast;
  } catch { /* fall through to marked */ }
  return marked.parse(md);
}
