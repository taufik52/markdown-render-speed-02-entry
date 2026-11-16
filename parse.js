// parse.js — dependency-free CommonMark 0.31.2 + GFM renderer.
//
// Written from scratch to match the HTML that marked 18.1.3 renders with
// its default options (GFM on, breaks off, pedantic off). The vendored
// marked was used only as a test oracle: this file contains no marked code.
//
// Design: two phases. Phase 1 parses blocks into a small block tree and
// collects link reference definitions document-wide (so a definition later
// in the document applies to an earlier link). Phase 2 renders the tree,
// parsing inline content with a delimiter-stack inline parser (CommonMark
// emphasis/link algorithm), which is what makes emphasis, links and
// strikethrough come out the way marked renders them.

export function parse(markdown) {
  let src = typeof markdown === 'string' ? markdown : String(markdown);
  src = src.replace(/\r\n?/g, '\n');
  const endsNL = src.endsWith('\n');
  let lines = src.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const ctx = { refs: new Map(), endsNL, lines, inLink: false };
  const blocks = parseBlocks(lines, 0, lines.length, ctx, null);
  return renderBlocks(blocks, ctx);
}

// ---------------------------------------------------------------------------
// Character helpers (char-code based; no regexes in hot paths)
// ---------------------------------------------------------------------------

function isSpaceCode(c) {
  return c === 32 || c === 9 || c === 10 || c === 11 || c === 12 || c === 13 ||
    c === 0xa0 || c === 0x1680 || (c >= 0x2000 && c <= 0x200a) ||
    c === 0x2028 || c === 0x2029 || c === 0x202f || c === 0x205f ||
    c === 0x3000 || c === 0xfeff;
}

function isSpaceCh(ch) {
  // The start / end of the inline text counts as whitespace (marked treats
  // the text as if preceded/followed by a newline for flanking purposes).
  return ch === undefined || isSpaceCode(ch.charCodeAt(0));
}

// ASCII punctuation: ! " # $ % & ' ( ) * + , - . / : ; < = > ? @ [ \ ] ^ _ ` { | } ~
function isAsciiPunctCode(c) {
  return (c >= 33 && c <= 47) || (c >= 58 && c <= 64) ||
    (c >= 91 && c <= 96) || (c >= 123 && c <= 126);
}

const NONASCII_PUNCT = /[\p{P}\p{S}]/u;

function isPunctCh(ch) {
  if (ch === undefined) return false;
  const c = ch.charCodeAt(0);
  if (c < 128) return isAsciiPunctCode(c);
  return NONASCII_PUNCT.test(ch);
}

function isDigitCode(c) { return c >= 48 && c <= 57; }
function isAlphaCode(c) {
  return (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
}
function isAlnumCode(c) { return isAlphaCode(c) || isDigitCode(c); }

// ---------------------------------------------------------------------------
// Escaping
// ---------------------------------------------------------------------------

// Escape text and attribute values the way marked does:
// & < > " '  ->  &amp; &lt; &gt; &quot; &#39;
function esc(s) {
  let out = '';
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    let rep = null;
    if (c === 38) rep = '&amp;';
    else if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      out += s.slice(last, i) + rep;
      last = i + 1;
    }
  }
  return last === 0 ? s : out + s.slice(last);
}

// Href encoding: encodeURI, then undo its % -> %25 so existing
// percent-encodings (and bare % signs) are preserved verbatim —
// marked keeps %20, %bar and even a trailing % as-is. Then
// attribute-escape (entity-like sequences kept verbatim).
function encodeHref(dest) {
  let u;
  try { u = encodeURI(dest).replace(/%25/g, '%'); } catch (e) { u = dest; }
  return escEnt(u);
}

// ---------------------------------------------------------------------------
// Lines: indentation, blankness, prefix stripping (tab-aware)
// ---------------------------------------------------------------------------

// Column width of the leading whitespace of a line (tab = to next multiple of 4).
function indentOf(line) {
  let col = 0;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === ' ') col++;
    else if (ch === '\t') col += 4 - (col % 4);
    else break;
  }
  return col;
}

function isBlank(line) {
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch !== ' ' && ch !== '\t') return false;
  }
  return true;
}

// Remove n columns of leading whitespace. A tab straddling the boundary
// is replaced by the spaces that remain after it.
function stripIndent(line, n) {
  let col = 0;
  let i = 0;
  while (i < line.length && col < n) {
    const ch = line[i];
    if (ch === ' ') { col++; i++; }
    else if (ch === '\t') {
      const w = 4 - (col % 4);
      if (col + w > n) return ' '.repeat(col + w - n) + line.slice(i + 1);
      col += w; i++;
    } else break;
  }
  return line.slice(i);
}

// Remove up to n leading whitespace CHARACTERS (a tab counts as one
// character, removed whole). Marked's fence indent compensation (Dt)
// is character-based, not column-based: a tab straddling the fence
// indent is removed entirely, not expanded to the remaining spaces
// (doc-13/17: an unclosed '  ````' fence's '\tindented with a tab'
// line loses the tab entirely, it does not keep 2 spaces; a
// '   ```' fence's keeps 0, not 1).
function stripIndentChars(line, n) {
  let i = 0;
  while (i < line.length && i < n && (line[i] === ' ' || line[i] === '\t')) i++;
  return line.slice(i);
}

// Expand the leading whitespace of s to spaces, where s starts at column
// startCol (a tab's width is computed from its original column).
function expandLeadingWs(s, startCol) {
  let col = startCol || 0;
  let i = 0;
  let out = '';
  while (i < s.length) {
    const c = s[i];
    if (c === ' ') { out += ' '; col++; i++; }
    else if (c === '\t') {
      const w = 4 - (col % 4);
      out += ' '.repeat(w);
      col += w;
      i++;
    } else break;
  }
  return out + s.slice(i);
}

// Remove exactly one column of leading whitespace from s (which starts at
// column col0), expanding any remaining leading whitespace to spaces.
// Used when a container marker (>, list marker) consumes one column.
function stripOneCol(s, col0) {
  let col = col0;
  let k = 0;
  while (k < s.length && col < col0 + 1) {
    const c = s[k];
    if (c === ' ') { col++; k++; }
    else if (c === '\t') {
      const w = 4 - (col % 4);
      if (col + w > col0 + 1) {
        return ' '.repeat(col + w - (col0 + 1)) + expandLeadingWs(s.slice(k + 1), col + w);
      }
      col += w;
      k++;
    } else break;
  }
  return expandLeadingWs(s.slice(k), col);
}

// Like stripIndent, but the remaining leading whitespace is expanded to
// spaces (original columns), so a tab after the stripped part keeps its
// original width. Used for container content lines, where the indent of
// the result is later re-measured.
function stripIndentExpand(line, n, startCol) {
  let col = startCol || 0;
  const target = col + n;
  let i = 0;
  while (i < line.length && col < target) {
    const c = line[i];
    if (c === ' ') { col++; i++; }
    else if (c === '\t') {
      const w = 4 - (col % 4);
      if (col + w > target) {
        return ' '.repeat(col + w - target) + expandLeadingWs(line.slice(i + 1), col + w);
      }
      col += w;
      i++;
    } else break;
  }
  return expandLeadingWs(line.slice(i), col);
}

// ---------------------------------------------------------------------------
// Numeric entities
// ---------------------------------------------------------------------------

function decodeNumericEntity(digits, hex) {
  let cp = 0;
  const base = hex ? 16 : 10;
  for (let i = 0; i < digits.length; i++) {
    const c = digits.charCodeAt(i);
    let d = -1;
    if (c >= 48 && c <= 57) d = c - 48;
    else if (hex && c >= 97 && c <= 102) d = c - 87;
    else if (hex && c >= 65 && c <= 70) d = c - 55;
    if (d < 0 || d >= base) return '\uFFFD';
    cp = cp * base + d;
    if (cp > 0x10FFFF) return '\uFFFD';
  }
  if (cp === 0 || (cp >= 0xD800 && cp <= 0xDFFF)) return '\uFFFD';
  return String.fromCodePoint(cp);
}

// ---------------------------------------------------------------------------
// Block-level recognisers
// ---------------------------------------------------------------------------

// Thematic break: 3+ of the same of * - _ with only spaces/tabs between.
function isThematicBreak(rest) {
  let ch = '';
  let count = 0;
  for (let i = 0; i < rest.length; i++) {
    const c = rest[i];
    if (c === ' ' || c === '\t') continue;
    if (c !== '*' && c !== '-' && c !== '_') return false;
    if (ch === '') ch = c;
    else if (c !== ch) return false;
    count++;
  }
  return count >= 3;
}

// Setext underline: a run of only = or only - (then trailing spaces/tabs).
// Returns 1, 2 or 0.
function setextLevel(rest) {
  let end = rest.length;
  while (end > 0 && (rest[end - 1] === ' ' || rest[end - 1] === '\t')) end--;
  if (end === 0) return 0;
  const ch = rest[0];
  if (ch !== '=' && ch !== '-') return 0;
  for (let i = 1; i < end; i++) {
    if (rest[i] !== ch) return 0;
  }
  return ch === '=' ? 1 : 2;
}

// --- HTML blocks (CommonMark types 1-7) -----------------------------------
// Returns the type (1..7) or 0. `rest` is the line with up to 3 spaces
// of indent already removed.

const BLOCK_TAGS = new Set(('address article aside base basefont blockquote body caption center col colgroup ' +
  'dd details dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 ' +
  'head header hr html iframe legend li link main menu menuitem meta nav noframes ol optgroup option p param ' +
  'search section source summary table tbody td tfoot th thead title tr track ul').split(' '));

function htmlBlockType(rest) {
  if (rest.charCodeAt(0) !== 60) return 0; // not '<'
  const lower = rest.toLowerCase();
  if (lower.startsWith('<script') || lower.startsWith('<pre') ||
      lower.startsWith('<style') || lower.startsWith('<textarea')) {
    // must be followed by space, tab, '>' or end of line
    const nameLen = lower.startsWith('<textarea') ? 9 : lower.startsWith('<script') ? 7 : lower.startsWith('<style') ? 6 : 4;
    const after = rest[nameLen];
    if (after === undefined || after === ' ' || after === '\t' || after === '>') return 1;
    return 0;
  }
  if (rest.startsWith('<!--')) return 2;
  if (rest.startsWith('<?')) return 3;
  if (rest.startsWith('<!') && rest.length > 2 && isAlphaCode(rest.charCodeAt(2))) return 4;
  if (rest.startsWith('<![CDATA[')) return 5;
  // Type 6: the line begins with a block-level tag (open or close).
  // The tag need not be complete on this line and need not be alone
  // on it (cm-153/154/156/157/158/159/160/161).
  let p = 0;
  if (rest[p] === '<') {
    p++;
    if (rest[p] === '/') p++;
    if (p < rest.length && isAlphaCode(rest.charCodeAt(p))) {
      let q = p;
      while (q < rest.length) {
        const qc = rest.charCodeAt(q);
        if (!isAlphaCode(qc) && !isDigitCode(qc) && rest[q] !== '-') break;
        q++;
      }
      const after = rest[q];
      if (after === undefined || after === ' ' || after === '\t' || after === '>' ||
          (after === '/' && rest[q + 1] === '>')) {
        if (BLOCK_TAGS.has(rest.slice(p, q).toLowerCase())) return 6;
      }
    }
  }
  // Type 7: the line is exactly one complete open/close tag (any tag
  // name) plus optional trailing whitespace. The tag must be complete
  // on this one line — a tag spanning lines is not type 7 (oracle22)
  // — and its attributes must be well-formed (cm-619/620/622/624/632).
  const tagEnd = parseTagEnd(rest, 0);
  if (tagEnd !== -1) {
    let k = tagEnd;
    while (k < rest.length && (rest[k] === ' ' || rest[k] === '\t')) k++;
    if (k === rest.length) return 7;
  }
  return 0;
}

// End condition for an HTML block of the given type: given the lines and
// the index of the current line (already included), does this line end it?
function htmlBlockEnds(type, line, rest) {
  switch (type) {
    case 1: {
      const l = line.toLowerCase();
      return l.includes('</script') || l.includes('</pre') ||
        l.includes('</style') || l.includes('</textarea');
    }
    case 2: return line.includes('-->');
    case 3: return line.includes('?>');
    case 4: return line.includes('>');
    case 5: return line.includes(']]>');
    default: return false; // types 6/7 end at a blank line
  }
}

// --- Tables -----------------------------------------------------------------

// Split a table line into cells on unescaped pipes. Returns null when the
// line cannot be a table line at all (blank). Cells are trimmed; a leading
// empty cell (line starts with |) and a trailing empty cell (ends with |)
// are dropped.
function splitTableCells(line) {
  const cells = [];
  let cur = '';
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    // An escaped pipe is not a separator: the backslash is consumed
    // and the pipe becomes cell content (gfm-200). Other backslash
    // escapes are left for the inline parser.
    if (c === '\\' && i + 1 < line.length && line[i + 1] === '|') {
      cur += '|';
      i++;
      continue;
    }
    if (c === '|') { cells.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  cells.push(cur.trim());
  if (cells.length && cells[0] === '') cells.shift();
  if (cells.length && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

// Parse a delimiter row. Returns an array of {align, colon} or null.
function parseDelimiterRow(line) {
  if (indentOf(line) > 3) return null;
  const cells = splitTableCells(line);
  if (!cells.length) return null;
  const out = [];
  for (const cell of cells) {
    const m = /^(:?)-+(:?)$/.exec(cell);
    if (!m) return null;
    const left = cell[0] === ':';
    const right = cell[cell.length - 1] === ':';
    out.push({
      align: left && right ? 'center' : left ? 'left' : right ? 'right' : null,
      colon: left || right,
    });
  }
  return out;
}

// Is line j a table header whose delimiter row is line j+1? Returns
// {header, delim} or null. A single-column delimiter without a colon is
// a setext underline, not a table.
// Does the line contain an unescaped '|' (a real cell separator)?
function hasUnescapedPipe(s) {
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '|') {
      let bs = 0;
      for (let k = i - 1; k >= 0 && s[k] === '\\'; k--) bs++;
      if (bs % 2 === 0) return true;
    }
  }
  return false;
}

function tableStart(L, j, e) {
  if (j + 1 >= e) return null;
  // A delimiter row must contain a dash; skip the (allocating) cell
  // split entirely when it cannot be one.
  if (!L[j + 1].includes('-')) return null;
  if (indentOf(L[j]) > 3) return null;
  const header = splitTableCells(L[j]);
  if (!header.length) return null;
  const delim = parseDelimiterRow(L[j + 1]);
  if (!delim || delim.length !== header.length) return null;
  // A single-column delimiter needs a colon or a pipe in the
  // delimiter line; otherwise it is a setext underline (gfm-200).
  if (delim.length === 1 && !delim[0].colon && !hasUnescapedPipe(L[j + 1])) return null;
  return { header, delim };
}

// --- Link reference definitions ---------------------------------------------

function normalizeLabel(raw) {
  // Collapse whitespace runs to one space, trim, then Unicode case-fold.
  // Backslash escapes are NOT resolved: the label keeps its backslashes,
  // so `foo\!` does not match a definition labelled `foo!` (cm-545), while
  // `foo\!` does match a definition labelled `foo\!`.
  let out = '';
  let lastSpace = true; // trims leading whitespace
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    if (isSpaceCode(c)) {
      if (!lastSpace) { out += ' '; lastSpace = true; }
      continue;
    }
    out += raw[i];
    lastSpace = false;
  }
  if (lastSpace && out.length) out = out.slice(0, -1);
  return caseFold(out);
}

// Unicode case folding (lowercase + the mappings toLowerCase misses):
// sharp s -> ss (so `ẞ` matches `SS`, cm-540), final sigma -> sigma,
// and the Latin ligatures -> their expansions.
function caseFold(s) {
  s = s.toLowerCase();
  if (!/[ßςﬀﬁﬂﬃﬄﬅﬆ]/.test(s)) return s;
  return s.replace(/ß/g, 'ss').replace(/ς/g, 'σ')
    .replace(/ﬀ/g, 'ff').replace(/ﬁ/g, 'fi').replace(/ﬂ/g, 'fl')
    .replace(/ﬃ/g, 'ffi').replace(/ﬄ/g, 'ffl')
    .replace(/ﬅ/g, 'st').replace(/ﬆ/g, 'st');
}

// Try to parse a link reference definition starting at line j.
// The definition may span up to 3 lines (label, destination, title).
// Returns {end, label, dest, title} (end = index past the last line used)
// or null. `lines` is the line array, `e` its end.
function tryRefDef(L, j, e) {
  const first = L[j];
  const ind = indentOf(first);
  if (ind > 3) return null;
  const rest = stripIndent(first, ind);
  if (rest.charCodeAt(0) !== 91) return null; // '['
  // Parse the label. It may span onto following lines (up to 3 lines
  // total for the definition); a newline inside the label normalizes
  // to a space (cm-541: `[Foo\n  bar]: /url` defines `Foo bar`).
  let src = rest;
  let linesUsed = 1;
  const needMore = () => {
    // A definition cannot span a blank line (it lives inside one
    // paragraph), so a blank next line ends it. Otherwise join the
    // next line — the title may span several lines (cm-196).
    if (j + linesUsed >= e) return false;
    const nl = L[j + linesUsed];
    if (isBlank(nl)) return false;
    src += '\n' + nl;
    linesUsed++;
    return true;
  };
  let i = 1;
  let labelRaw = '';
  let closed = false;
  while (true) {
    while (i < src.length) {
      const c = src[i];
      if (c === '\\' && i + 1 < src.length && isAsciiPunctCode(src.charCodeAt(i + 1))) {
        labelRaw += src.slice(i, i + 2);
        i += 2;
        continue;
      }
      if (c === '[') return null;
      if (c === ']') { closed = true; i++; break; }
      labelRaw += c;
      i++;
    }
    if (closed) break;
    if (!needMore()) return null;
  }
  const label = normalizeLabel(labelRaw);
  if (!label || label.length > 999) return null;
  if (src[i] !== ':') return null;
  i++;
  // The rest (dest + title) may continue on the following lines.
  // Collect up to 2 more lines of source, joined with '\n'.
  // src now starts on the line where the label closed.
  const srcStartLine = j + linesUsed - 1;
  src = src.slice(i);
  let p = 0;
  const skipWs = () => {
    while (p < src.length && (src[p] === ' ' || src[p] === '\t' || src[p] === '\n')) p++;
  };
  skipWs();
  if (p >= src.length && !needMore()) return null;
  skipWs();
  // Destination.
  let dest = null;
  if (src[p] === '<') {
    let q = p + 1;
    let d = '';
    let ok = false;
    while (q < src.length) {
      const c = src[q];
      if (c === '\n' || c === '<') break;
      if (c === '\\' && q + 1 < src.length && isAsciiPunctCode(src.charCodeAt(q + 1))) {
        d += src[q + 1];
        q += 2;
        continue;
      }
      if (c === '>') { ok = true; q++; break; }
      d += c;
      q++;
    }
    if (!ok) return null;
    dest = d;
    p = q;
  } else {
    // Bare destination: no spaces/control, balanced parens.
    let q = p;
    let depth = 0;
    let d = '';
    while (q < src.length) {
      const c = src[q];
      const cc = c.charCodeAt(0);
      if (c === ' ' || c === '\t' || c === '\n' || cc < 32 || cc === 127) break;
      if (c === '\\' && q + 1 < src.length && isAsciiPunctCode(src.charCodeAt(q + 1))) {
        d += src[q + 1];
        q += 2;
        continue;
      }
      if (c === '(') { depth++; d += c; q++; continue; }
      if (c === ')') {
        if (depth === 0) break;
        depth--; d += c; q++; continue;
      }
      d += c;
      q++;
    }
    if (!d) return null;
    dest = d;
    p = q;
  }
  // Optional title (same line or next line(s); it may span lines, but
  // not a blank line). Only pull in the next line when it could start a
  // title — joining it unconditionally would make the trailing-junk
  // check below see the next definition's text and wrongly reject this
  // one (cm-565: two defs on consecutive lines).
  const pAfterDest = p;
  skipWs();
  if (p >= src.length) {
    const nx = j + linesUsed;
    if (nx < e) {
      const nl = L[nx];
      let k = 0;
      while (k < nl.length && (nl[k] === ' ' || nl[k] === '\t')) k++;
      if (nl[k] === '"' || nl[k] === "'" || nl[k] === '(') needMore();
    }
  }
  skipWs();
  // Did we cross a newline between the dest and here? If the title sits
  // on a later line than the dest, an invalid title just means the
  // definition ends after the dest (cm-210); if it sits on the dest's
  // own line, an invalid title fails the whole definition (cm-197).
  let crossedNl = false;
  for (let k = pAfterDest; k < p; k++) if (src[k] === '\n') { crossedNl = true; break; }
  let title = null;
  if (p < src.length && (src[p] === '"' || src[p] === "'" || src[p] === '(')) {
    // A title must be separated from the destination by whitespace
    // (cm-201: `[foo]: <bar>(baz)` is not a definition).
    if (p === pAfterDest) return null;
    const open = src[p];
    const close = open === '(' ? ')' : open;
    let q = p + 1;
    let t = '';
    let ok = false;
    let badParen = false;
    while (true) {
      while (q < src.length) {
        const c = src[q];
        if (c === '\\' && q + 1 < src.length && isAsciiPunctCode(src.charCodeAt(q + 1))) {
          t += src[q + 1];
          q += 2;
          continue;
        }
        if (c === close) { ok = true; q++; break; }
        if (open === '(' && c === '(') { badParen = true; break; }
        t += c;
        q++;
      }
      if (ok || badParen) break;
      if (!needMore()) break; // title may continue on the next line
    }
    if (ok) {
      // Only whitespace may follow the title.
      let r = q;
      while (r < src.length && (src[r] === ' ' || src[r] === '\t' || src[r] === '\n')) r++;
      if (r >= src.length) {
        title = t;
        p = q;
      } else if (crossedNl) {
        // Discard the title; the definition ends after the dest.
        // Truncate the joined source back to the dest so the trailing
        // check and the end computation only see the dest's line.
        src = src.slice(0, pAfterDest);
        p = pAfterDest;
      } else {
        return null;
      }
    } else {
      // Title never closed (or a '(' inside a paren title).
      if (crossedNl) {
        src = src.slice(0, pAfterDest);
        p = pAfterDest;
      } else return null;
    }
  }
  skipWs();
  // Only whitespace may follow on the last line used.
  if (p < src.length) {
    let onlyWs = true;
    for (let k = p; k < src.length; k++) {
      if (src[k] !== ' ' && src[k] !== '\t' && src[k] !== '\n') { onlyWs = false; break; }
    }
    if (!onlyWs) return null;
  }
  // Count how many lines the definition actually consumed: the last line
  // that holds any of the definition's characters. src starts on
  // srcStartLine (the line where the label closed), so count newlines
  // in src before p from there.
  let end = j + linesUsed;
  let lineNo = srcStartLine;
  let consumed = srcStartLine + 1;
  for (let k = 0; k < p && lineNo < j + linesUsed; k++) {
    if (src[k] === '\n') { lineNo++; consumed = lineNo + 1; }
  }
  end = consumed;
  return { end, label, dest, title };
}

// ---------------------------------------------------------------------------
// Block parser — phase 1 (builds the block tree, collects link refs)
// ---------------------------------------------------------------------------

function fenceStart(rest) {
  const ch = rest[0];
  if (ch !== '`' && ch !== '~') return null;
  let len = 0;
  while (len < rest.length && rest[len] === ch) len++;
  if (len < 3) return null;
  const info = rest.slice(len).trim();
  if (ch === '`' && info.includes('`')) return null;
  // The language is the first word of the info string, with backslash
  // escapes resolved ('\+' -> '+', cm-024).
  const lang = (info.split(/[ \t]+/)[0] || '').replace(/\\([!-/:-@\[-`{-~])/g, '$1');
  return { ch, len, lang };
}

function isFenceClose(rest, f) {
  let len = 0;
  while (len < rest.length && rest[len] === f.ch) len++;
  if (len < f.len) return false;
  for (let i = len; i < rest.length; i++) {
    if (rest[i] !== ' ' && rest[i] !== '\t') return false;
  }
  return true;
}

function atxMatch(rest) {
  let n = 0;
  while (n < rest.length && rest[n] === '#') n++;
  if (n === 0 || n > 6) return null;
  if (n === rest.length) return { level: n, text: '' };
  const c = rest[n];
  if (c !== ' ' && c !== '\t') return null;
  let text = rest.slice(n).replace(/^[ \t]+/, '').replace(/[ \t]+$/, '');
  if (/^#+$/.test(text)) text = '';
  else {
    const m = /[ \t]+#+$/.exec(text);
    if (m) text = text.slice(0, m.index).replace(/[ \t]+$/, '');
  }
  return { level: n, text };
}

// List marker. Returns {ordered, bullet, delim, num, content, contentIndent}
// or null. `rest` is the line with up to 3 spaces of indent removed.
function listMarker(rest) {
  if (!rest) return null;
  const c0 = rest.charCodeAt(0);
  if (c0 === 45 || c0 === 43 || c0 === 42) { // - + *
    if (rest.length === 1) {
      return { ordered: false, bullet: rest[0], delim: null, num: 0, content: '', contentIndent: 2 };
    }
    const c1 = rest.charCodeAt(1);
    if (c1 !== 32 && c1 !== 9) return null;
    return finishMarker(rest, 1, false, null, rest[0], 0);
  }
  if (isDigitCode(c0)) {
    let n = 0;
    let num = 0;
    while (n < rest.length && isDigitCode(rest.charCodeAt(n))) {
      if (n >= 9) return null;
      num = num * 10 + (rest.charCodeAt(n) - 48);
      n++;
    }
    if (n === 0) return null;
    const d = rest[n];
    if (d !== '.' && d !== ')') return null;
    if (n + 1 === rest.length) {
      return { ordered: true, bullet: null, delim: d, num, content: '', contentIndent: n + 2 };
    }
    const c1 = rest.charCodeAt(n + 1);
    if (c1 !== 32 && c1 !== 9) return null;
    return finishMarker(rest, n + 1, true, d, null, num);
  }
  return null;
}

function finishMarker(rest, markerEnd, ordered, delim, bullet, num) {
  let col = markerEnd;
  let i = markerEnd;
  let spaces = 0;
  while (i < rest.length) {
    const c = rest[i];
    if (c === ' ') { spaces++; col++; i++; }
    else if (c === '\t') { const w = 4 - (col % 4); spaces += w; col += w; i++; }
    else break;
  }
  if (i >= rest.length) {
    return { ordered, bullet, delim, num, content: '', contentIndent: markerEnd + 1 };
  }
  const contentIndent = spaces >= 1 && spaces <= 4 ? markerEnd + spaces : markerEnd + 1;
  let content;
  if (spaces <= 4) {
    // All whitespace after the marker is consumed; content starts at i.
    content = rest.slice(i);
  } else {
    // 5+ spaces: only one column is the marker's gap; the rest of the
    // whitespace run stays in the content (a straddled tab expands).
    content = stripOneCol(rest.slice(markerEnd), markerEnd);
  }
  return {
    ordered, bullet, delim, num,
    content,
    contentIndent,
  };
}

function isBlockStarter(rest) {
  // A blockquote line is a block starter: it interrupts a paragraph
  // and ends the list item it cannot belong to (doc-17: a '>'
  // line indented below a nested item's content indent ends the
  // inner list and opens a blockquote in the outer item, it is not
  // lazy paragraph text).
  if (rest[0] === '>') return true;
  if (fenceStart(rest) || atxMatch(rest) || isThematicBreak(rest)) return true;
  const ht = htmlBlockType(rest);
  if (ht >= 1 && ht <= 6) return true;
  if (listMarker(rest)) return true;
  return false;
}

function parseBlocks(L, s, e, ctx, lazySet, wsSet) {
  const blocks = [];
  let i = s;
  // Whether a blank line separated two top-level blocks in this
  // container. Used for list looseness: a blank line between two
  // blocks directly inside an item makes that item's list loose
  // (cm-307, cm-319), but blank lines inside a nested sublist or
  // blockquote do not propagate to the parent list.
  let blankBetween = false;
  let pendingBlank = false;
  while (i < e) {
    const line = L[i];
    if (isBlank(line)) {
      if (blocks.length > 0) pendingBlank = true;
      i++; continue;
    }
    if (pendingBlank) { blankBetween = true; pendingBlank = false; }
    const ind = indentOf(line);
    if (ind >= 4) {
      // Indented code block.
      const codeLines = [];
      let j = i;
      while (j < e) {
        const l2 = L[j];
        if (isBlank(l2)) {
          let k = j + 1;
          while (k < e && isBlank(L[k])) k++;
          if (k < e && indentOf(L[k]) >= 4) {
            // Blank lines inside indented code keep their spaces
            // minus the 4-column indent (cm-112).
            for (; j < k; j++) codeLines.push(stripIndent(L[j], 4));
            continue;
          }
          break;
        }
        if (indentOf(l2) >= 4) { codeLines.push(stripIndent(l2, 4)); j++; continue; }
        break;
      }
      blocks.push({ k: 'icode', t: codeLines.join('\n') + '\n' });
      i = j;
      continue;
    }
    const rest = stripIndent(line, ind);
    // Fenced code.
    const f = fenceStart(rest);
    if (f) {
      const content = [];
      let j = i + 1;
      while (j < e) {
        const l2 = L[j];
        const ind2 = indentOf(l2);
        if (ind2 <= 3 && isFenceClose(stripIndent(l2, ind2), f)) { j++; break; }
        // Content lines are stripped of up to the opening fence's
        // indent — but only for backtick fences. A tilde fence does
        // NOT strip its indent from content lines (oracle51: a
        // `~~~` fence indented 3 leaves its content at indent 3,
        // while a ``` fence indented 3 strips it to 0). The strip
        // is character-based (stripIndentChars), matching marked's
        // Dt: a tab in the content's leading whitespace is removed
        // whole when it falls inside the indent (doc-13/17).
        content.push(f.ch === '`' ? stripIndentChars(l2, ind) : l2);
        j++;
      }
      // The code text is the content lines joined with '\n'; a trailing
      // '\n' is added only when the joined text does not already end
      // with one (a trailing blank line before the closing fence
      // already supplies it — oracle29).
      let t = content.length ? content.join('\n') : '';
      if (t && !t.endsWith('\n')) t += '\n';
      blocks.push({ k: 'code', lang: f.lang, t });
      i = j;
      continue;
    }
    // ATX heading.
    const atx = atxMatch(rest);
    if (atx) {
      blocks.push({ k: 'h', l: atx.level, t: atx.text });
      i++;
      continue;
    }
    // Thematic break.
    if (isThematicBreak(rest)) {
      blocks.push({ k: 'hr' });
      i++;
      continue;
    }
    // HTML block.
    const ht = htmlBlockType(rest);
    if (ht) {
      let endLine;
      if (ht <= 5) {
        let j = i;
        endLine = e;
        while (j < e) {
          if (htmlBlockEnds(ht, L[j])) { endLine = j + 1; break; }
          j++;
        }
      } else {
        let j = i;
        while (j < e && !isBlank(L[j])) j++;
        endLine = j;
      }
      let raw = L.slice(i, endLine).join('\n');
      // Trailing newline: the "blank line" that suppresses it means
      // something different per type (oracle43/44). Types 1-5 only
      // treat a truly empty line as blank — a whitespace-only line
      // still gets the trailing newline. Types 6-7 treat any
      // whitespace-only line as blank.
      // When the block is the last one in a container, no trailing
      // newline is added — even when the source ends with one
      // (cm-175). Only a top-level block at the very end of the
      // source takes the source's final newline.
      let trailing;
      if (endLine < e) {
        trailing = ht <= 5 ? L[endLine].length > 0 : !isBlank(L[endLine]);
      } else trailing = L === ctx.lines ? ctx.endsNL : false;
      if (trailing) raw += '\n';
      blocks.push({ k: 'html', t: raw });
      i = endLine;
      continue;
    }
    // Blockquote.
    if (rest[0] === '>') {
      const r = collectBQ(L, i, e, ctx);
      blocks.push({ k: 'bq', b: parseBlocks(r.lines, 0, r.lines.length, ctx, r.lazy, r.ws) });
      i = r.end;
      continue;
    }
    // List.
    const lm = listMarker(rest);
    if (lm) {
      const r = parseList(L, i, e, ctx);
      blocks.push(r.block);
      // A list that consumed trailing blank lines separates the next
      // block from it with a blank line (cm-325).
      if (r.contentEnd < r.end) pendingBlank = true;
      i = r.end;
      continue;
    }
    // Table or paragraph.
    const ts = tableStart(L, i, e);
    if (ts) {
      const r = parseTable(L, i, e, ts);
      blocks.push(r.block);
      i = r.end;
      continue;
    }
    const r = parseParagraph(L, i, e, ctx, lazySet, wsSet);
    if (r.block) blocks.push(r.block);
    i = r.end;
  }
  blocks._blankBetween = blankBetween;
  return blocks;
}

function parseTable(L, i, e, ts) {
  const head = ts.header;
  const align = ts.delim.map(d => d.align);
  const rows = [];
  let j = i + 2;
  while (j < e) {
    const line = L[j];
    // A whitespace-only line ends the table — but only when it is
    // empty or spaces-only. A line containing a tab is a row of empty
    // cells (dbg30: a '\t' line is a row and the table continues past
    // it, while '   ' ends the table).
    if (isBlank(line)) {
      if (line.indexOf('\t') === -1) break;
      rows.push(new Array(head.length).fill(''));
      j++;
      continue;
    }
    const ind = indentOf(line);
    if (ind > 3) break;
    const rest = stripIndent(line, ind);
    if (fenceStart(rest) || atxMatch(rest) || isThematicBreak(rest) ||
        rest[0] === '>' || listMarker(rest)) break;
    const ht = htmlBlockType(rest);
    if (ht >= 1 && ht <= 6) break;
    rows.push(splitTableCells(line));
    j++;
  }
  return { block: { k: 'table', align, head, rows }, end: j };
}

function parseParagraph(L, i, e, ctx, lazySet, wsSet) {
  let j = i;
  // Link reference definitions at the start of the paragraph.
  while (j < e && !isBlank(L[j])) {
    const def = tryRefDef(L, j, e);
    if (!def) break;
    if (!ctx.refs.has(def.label)) {
      ctx.refs.set(def.label, { dest: def.dest, title: def.title });
    }
    j = def.end;
  }
  if (j >= e || isBlank(L[j])) return { block: null, end: j };
  const lines = [];
  let setext = 0;
  while (j < e) {
    const line = L[j];
    // A whitespace-only proper '>' line is paragraph content, not a
    // blank separator (cm-241).
    if (isBlank(line) && !(wsSet && wsSet.has(j))) break;
    // A lazy line is a paragraph continuation by definition: it must
    // not break the paragraph even if, after the 4-column strip, it
    // looks like a list marker (cm-238, cm-312). Only a table header
    // still breaks it (a lazy line can start a table).
    const isLazy = lazySet ? lazySet.has(j) : false;
    const ind = indentOf(line);
    if (ind <= 3) {
      if (tableStart(L, j, e)) break;
      if (!isLazy) {
        const rest = stripIndent(line, ind);
        if (lines.length) {
          const sl = setextLevel(rest);
          if (sl) { setext = sl; j++; break; }
        }
        // A proper list-marker line inside a container always starts
        // a (sub)list, regardless of its number (oracle39). At the
        // top level an ordered list interrupts a paragraph only when
        // it starts with 1. An empty item never interrupts.
        const lmHere = listMarker(rest);
        if (lmHere && lmHere.content !== '' &&
            (lazySet || !lmHere.ordered || lmHere.num === 1)) break;
        if (fenceStart(rest) || atxMatch(rest) || isThematicBreak(rest) ||
            rest[0] === '>') break;
        const ht = htmlBlockType(rest);
        if (ht >= 1 && ht <= 6) break;
      }
    }
    lines.push(line);
    j++;
  }
  if (!lines.length) return { block: null, end: j };
  if (setext) {
    const text = lines.map((l, idx) => {
      let s = l;
      if (idx === 0) s = stripIndent(s, 3);
      if (idx === lines.length - 1) {
        let e2 = s.length;
        while (e2 > 0 && (s[e2 - 1] === ' ' || s[e2 - 1] === '\t')) e2--;
        s = s.slice(0, e2);
      }
      return s;
    }).join('\n');
    return { block: { k: 'h', l: setext, t: text }, end: j };
  }
  const text = lines.join('\n');
  return { block: { k: 'p', t: text }, end: j };
}

// ---------------------------------------------------------------------------
// Container line collection (blockquotes and list items)
//
// A container's lines are gathered before they are block-parsed. Lines that
// carry the container's marker (or the item's indent) are "proper" lines.
// Other lines are "lazy": they belong to the container only while the
// innermost open block is a paragraph (so they continue it), and a lazy
// line never turns a paragraph into a setext heading.
//
// open state after a line: 'para' | 'table' | 'fence' | null.
// ---------------------------------------------------------------------------

// Open state after a proper line's content, given the current open state.
function openAfter(content, curOpen, depth) {
  if (depth === undefined) depth = 0;
  if (depth > 32 || content === '') return null;
  const ind = indentOf(content);
  if (ind >= 4) return curOpen === 'para' || curOpen === 'table' ? curOpen : null;
  const rest = stripIndent(content, ind);
  if (fenceStart(rest)) return 'fence';
  if (atxMatch(rest) || isThematicBreak(rest) || htmlBlockType(rest) !== 0) return null;
  if (rest[0] === '>') return openAfter(stripOneCol(rest.slice(1), 1), curOpen, depth + 1);
  const lm = listMarker(rest);
  if (lm) return openAfter(lm.content, curOpen, depth + 1);
  if (setextLevel(rest)) return null;
  return curOpen === 'table' ? 'table' : 'para';
}

// Is `headerContent` a table header whose delimiter is `delimContent`?
function tableStartContent(headerContent, delimContent) {
  if (!delimContent.includes('-')) return null;
  if (indentOf(headerContent) > 3 || indentOf(delimContent) > 3) return null;
  const header = splitTableCells(headerContent);
  if (!header.length) return null;
  const delim = parseDelimiterRow(delimContent);
  if (!delim || delim.length !== header.length) return null;
  // A single-column delimiter needs a colon or a pipe in the
  // delimiter line; otherwise it is a setext underline (gfm-200).
  if (delim.length === 1 && !delim[0].colon && !hasUnescapedPipe(delimContent)) return null;
  return { header, delim };
}

function collectBQ(L, i, e, ctx) {
  const lines = [];
  const lazy = new Set();
  // Indices of lines that are proper '>' lines whose content is only
  // whitespace (e.g. '>  ' -> ' '). Such a line is paragraph content,
  // not a blank separator (cm-241).
  const ws = new Set();
  let open = null;
  let inFence = null;
  let j = i;
  const bqContent = (line) => {
    if (isBlank(line)) return null;
    const ind = indentOf(line);
    if (ind > 3) return null;
    const rest = stripIndent(line, ind);
    if (rest[0] !== '>') return null;
    return stripOneCol(rest.slice(1), ind + 1);
  };
  while (j < e) {
    const line = L[j];
    if (isBlank(line)) {
      // A truly blank line (no '>' marker) ends the blockquote
      // (cm-242, cm-252) — even inside a fenced code block (dbg44:
      // '> ```\n> code\n\n> more' ends the fence at the blank line,
      // and a nested '> > ``` ... >' ends the inner fence too). A
      // '>' line, even an empty one, is handled below via bqContent
      // and IS fence content.
      break;
    }
    const content = bqContent(line);
    if (content !== null) {
      lines.push(content);
      if (content.length > 0 && isBlank(content)) ws.add(lines.length - 1);
      if (inFence) {
        if (isFenceClose(content, inFence)) { inFence = null; open = null; }
      } else {
        const f = fenceStart(content);
        if (f) { inFence = f; open = 'fence'; }
        else {
          // A proper table header + a proper delimiter row opens a table.
          const next = j + 1 < e ? bqContent(L[j + 1]) : null;
          if (next !== null && tableStartContent(content, next)) open = 'table';
          else open = openAfter(content, open);
        }
      }
      j++;
      continue;
    }
    // Not a '>' line.
    if (inFence) break;
    if (open !== 'para') break;
    const ind = indentOf(line);
    const rest = ind <= 3 ? stripIndent(line, ind) : line;
    if (isBlockStarter(rest)) break;
    // A lazy setext underline ('===') that is not the first lazy line
    // is indented by 4 spaces so it stays paragraph text and cannot
    // be a setext underline (cm-093).
    if (setextLevel(rest) === 1 && lazy.size > 0) {
      lines.push('    ' + rest);
    } else {
      // A lazy line with indent >= 4 has 4 columns stripped (cm-238,
      // oracle27); a less-indented lazy line is kept verbatim.
      lines.push(ind >= 4 ? stripIndent(line, 4) : line);
    }
    lazy.add(lines.length - 1);
    j++;
  }
  return { lines, lazy, ws, end: j };
}

function parseList(L, i, e, ctx) {
  const firstInd = indentOf(L[i]);
  const firstRest = stripIndent(L[i], firstInd);
  const firstMarker = listMarker(firstRest);
  const ordered = firstMarker.ordered;
  const bullet = firstMarker.bullet;
  const delim = firstMarker.delim;
  const items = [];
  let loose = false;
  let j = i;
  // Index just after the last non-blank line consumed. A list that
  // consumed trailing blank lines reports contentEnd < end, so the
  // parent knows a blank line separates it from the next block
  // (cm-325).
  let contentEnd = i;
  let cur = null;

  const peekContent = (k, contentIndent) => {
    if (k >= e) return null;
    const line = L[k];
    if (isBlank(line)) return null;
    if (indentOf(line) < contentIndent) return null;
    return stripIndentExpand(line, contentIndent);
  };

  const newItem = (lm, rest, k, ind) => {
    // contentIndent is an absolute column: the marker line's indent
    // plus the marker-relative indent listMarker computed.
    const ci = ind + lm.contentIndent;
    const it = {
      lines: [lm.content],
      lazy: new Set(),
      contentIndent: ci,
      blankPending: false,
      closed: false,
      hasContent: lm.content !== '',
      open: 'para',
      inFence: null,
      // Number of content lines collected into the currently open
      // fence. A fence only "takes hold" in the item once a proper
      // (indented) content line has been collected; a non-indented
      // first content line leaves the fence empty (dbg61).
      fenceContent: 0,
      inBQ: lm.content.length > 0 && lm.content[0] === '>',
      blocks: null,
    };
    const f = fenceStart(lm.content);
    if (f) { it.inFence = f; it.open = 'fence'; }
    else {
      const next = peekContent(k + 1, ci);
      if (next !== null && tableStartContent(lm.content, next)) it.open = 'table';
      else it.open = openAfter(lm.content, null);
    }
    return it;
  };

  const finishItem = () => {
    if (!cur) return;
    cur.blocks = parseBlocks(cur.lines, 0, cur.lines.length, ctx, cur.lazy);
    // A blank line between two blocks directly inside the item makes
    // this list loose (cm-307, cm-319). Blank lines inside a nested
    // sublist do not propagate (they are inside the sublist block).
    if (cur.blocks._blankBetween) loose = true;
    items.push(cur);
    cur = null;
  };

  // Content of line L[k] as collected in the current item, or null when
  // the line is not an indented (proper) line of the item.
  const itemContent = (k) => {
    if (k >= e || !cur) return null;
    const line = L[k];
    if (isBlank(line)) return null;
    if (indentOf(line) < cur.contentIndent) return null;
    return stripIndentExpand(line, cur.contentIndent);
  };

  const updateState = (content, k) => {
    if (cur.inFence) {
      // The closing-fence check needs the indent-stripped rest: the
      // content may still carry a leading space from the container
      // prefix (e.g. ' ````' inside a list item).
      const indC = indentOf(content);
      const restC = indC <= 3 ? stripIndent(content, indC) : content;
      if (isFenceClose(restC, cur.inFence)) { cur.inFence = null; cur.open = null; }
      return;
    }
    cur.inBQ = content.length > 0 && content[0] === '>';
    const f = fenceStart(content);
    if (f) { cur.inFence = f; cur.open = 'fence'; cur.fenceContent = 0; return; }
    const next = itemContent(k + 1);
    if (next !== null && tableStartContent(content, next)) { cur.open = 'table'; return; }
    cur.open = openAfter(content, cur.open);
  };

  while (j < e) {
    const line = L[j];
    if (isBlank(line)) {
      if (cur) {
        cur.lines.push('');
        cur.blankPending = true;
        // A blank line closes the open paragraph/table, so a later
        // non-indented line is not a lazy continuation (cm-255, cm-276).
        // A fenced code block stays open across blank lines.
        if (!cur.inFence) cur.open = null;
        // An empty item cannot gain content after a blank line (cm-280):
        // the blank line closes it for good.
        if (!cur.hasContent) cur.closed = true;
      }
      j++;
      continue;
    }
    const ind = indentOf(line);
    const rest = ind <= 3 ? stripIndent(line, ind) : line;
    // A line indented to the current item's content indent belongs to
    // the item — even when it looks like a list marker (it is a sublist
    // inside the item, cm-294). Only a less-indented marker line can
    // start a sibling item or end the list. A closed (empty) item takes
    // no more content (cm-280).
    if (cur && !cur.closed && ind >= cur.contentIndent) {
      const content = stripIndentExpand(line, cur.contentIndent);
      const wasInFence = cur.inFence;
      cur.lines.push(content);
      cur.hasContent = true;
      cur.blankPending = false;
      updateState(content, j);
      if (wasInFence) cur.fenceContent++;
      contentEnd = j + 1;
      j++;
      continue;
    }
    if (ind <= 3) {
      // A thematic break ends the list (cm-060); it is not a list item.
      if (isThematicBreak(rest)) break;
      const lm = listMarker(rest);
      if (lm) {
        if (lm.ordered === ordered && lm.bullet === bullet && lm.delim === delim) {
          if (cur && cur.blankPending) loose = true;
          finishItem();
          cur = newItem(lm, rest, j, ind);
          contentEnd = j + 1;
          j++;
          continue;
        }
        break; // a different list starts here
      }
    }
    if (!cur) break;
    // A '>' line continues the item only while a blockquote is open
    // in it — and only when the '>' is indented to the item's content
    // indent. A '>' at a lower indent is a top-level blockquote, not
    // a continuation of the inner one (doc-05: '> 535085)...' at
    // indent 0 ends the list item whose blockquote sat at indent 3).
    if (rest[0] === '>' && cur.inBQ && !cur.closed && ind >= cur.contentIndent) {
      const content = stripOneCol(rest.slice(1), ind + 1);
      const wasInFence = cur.inFence;
      cur.lines.push(content);
      cur.hasContent = true;
      cur.blankPending = false;
      updateState(content, j);
      if (wasInFence) cur.fenceContent++;
      contentEnd = j + 1;
      j++;
      continue;
    }
    // A fence content line stays in the item even when it is not
    // indented to the content indent — but only once the fence has
    // already collected a proper content line (fenceContent > 0).
    // A non-indented FIRST content line leaves the fence empty and
    // ends the item (dbg61: '- a\n  ```sh\nprint("hi")' has an empty
    // fence and 'print("hi")' as a paragraph outside).
    if (cur.inFence && cur.fenceContent > 0 && !cur.closed) {
      const content = ind >= cur.contentIndent
        ? stripIndentExpand(line, cur.contentIndent) : line;
      cur.lines.push(content);
      cur.hasContent = true;
      cur.blankPending = false;
      updateState(content, j);
      cur.fenceContent++;
      contentEnd = j + 1;
      j++;
      continue;
    }
    // Lazy line: only while a paragraph is open, and not a block starter.
    if (cur.open !== 'para') break;
    if (isBlockStarter(rest)) break;
    // A lazy line with indent >= 4 has 4 columns stripped (cm-312,
    // oracle27); a less-indented lazy line is kept verbatim.
    cur.lines.push(ind >= 4 ? stripIndent(line, 4) : line);
    cur.hasContent = true;
    // A lazy setext underline ('===') that is not the first lazy line
    // is NOT marked lazy, so it forms a setext heading (oracle32).
    // The first lazy '===' stays paragraph text.
    if (!(setextLevel(rest) === 1 && cur.lazy.size > 0)) {
      cur.lazy.add(cur.lines.length - 1);
    }
    cur.blankPending = false;
    contentEnd = j + 1;
    j++;
  }
  // Trailing whitespace is stripped from the last line of the last
  // item in a list (dbg51: '- a  \n- b  ' keeps 'a  ' in the first
  // item but strips the last item to 'b'; a top-level paragraph keeps
  // its trailing spaces). Not applied inside a fenced code block,
  // whose content is verbatim.
  if (cur && !cur.inFence) {
    for (let li = cur.lines.length - 1; li >= 0; li--) {
      const s = cur.lines[li];
      if (s.length > 0) {
        let e2 = s.length;
        while (e2 > 0 && (s[e2 - 1] === ' ' || s[e2 - 1] === '\t')) e2--;
        if (e2 < s.length) cur.lines[li] = s.slice(0, e2);
        break;
      }
    }
  }
  finishItem();
  return {
    block: { k: 'list', ordered, start: firstMarker.num, loose, items },
    end: j,
    contentEnd,
  };
}

// ---------------------------------------------------------------------------
// Rendering — phase 2
// ---------------------------------------------------------------------------

function renderBlocks(blocks, ctx) {
  let out = '';
  for (const b of blocks) out += renderBlock(b, ctx);
  return out;
}

function renderBlock(b, ctx) {
  switch (b.k) {
    case 'p': return '<p>' + inline(b.t, ctx) + '</p>\n';
    case 'h': return '<h' + b.l + '>' + inline(b.t, ctx) + '</h' + b.l + '>\n';
    case 'code':
      return '<pre><code' + (b.lang ? ' class="language-' + escEnt(b.lang) + '"' : '') +
        '>' + esc(b.t) + '</code></pre>\n';
    case 'icode': return '<pre><code>' + esc(b.t) + '</code></pre>\n';
    case 'html': return b.t;
    case 'hr': return '<hr>\n';
    case 'bq': return '<blockquote>\n' + renderBlocks(b.b, ctx) + '</blockquote>\n';
    case 'list': {
      let out = b.ordered
        ? '<ol' + (b.start !== 1 ? ' start="' + b.start + '"' : '') + '>\n'
        : '<ul>\n';
      for (const it of b.items) out += renderItem(it, b.loose, ctx);
      out += b.ordered ? '</ol>\n' : '</ul>\n';
      return out;
    }
    case 'table': {
      let out = '<table>\n<thead>\n<tr>\n';
      for (let c = 0; c < b.head.length; c++) {
        out += '<th' + (b.align[c] ? ' align="' + b.align[c] + '"' : '') +
          '>' + inline(b.head[c], ctx) + '</th>\n';
      }
      out += '</tr>\n</thead>\n';
      if (b.rows.length) {
        out += '<tbody>';
        for (const row of b.rows) {
          out += '<tr>\n';
          for (let c = 0; c < b.head.length; c++) {
            const cell = c < row.length ? row[c] : '';
            out += '<td' + (b.align[c] ? ' align="' + b.align[c] + '"' : '') +
              '>' + inline(cell, ctx) + '</td>\n';
          }
          out += '</tr>\n';
        }
        out += '</tbody></table>\n';
      } else {
        out += '</table>\n';
      }
      return out;
    }
    default: return '';
  }
}

// Task-list info for a paragraph's text: [ ] / [x] / [X] followed by
// whitespace and non-empty content.
function taskInfo(text) {
  if (text.length < 4 || text[0] !== '[') return null;
  const c = text[1];
  if (c !== ' ' && c !== 'x' && c !== 'X') return null;
  if (text[2] !== ']') return null;
  const w = text[3];
  if (w !== ' ' && w !== '\t' && w !== '\n') return null;
  let k = 3;
  while (k < text.length && (text[k] === ' ' || text[k] === '\t' || text[k] === '\n')) k++;
  if (k >= text.length) return null;
  return { checked: c === 'x' || c === 'X', rest: text.slice(k) };
}

function renderItem(item, loose, ctx) {
  const blocks = item.blocks;
  let inner = '';
  for (let k = 0; k < blocks.length; k++) {
    const b = blocks[k];
    if (b.k === 'p') {
      // In a tight list every paragraph is rendered bare (no <p>);
      // in a loose list every paragraph gets <p> tags. The task-list
      // checkbox only applies to the item's first block.
      let content;
      if (k === 0) {
        const task = taskInfo(b.t);
        content = task
          ? (task.checked
            ? '<input checked="" disabled="" type="checkbox"> '
            : '<input disabled="" type="checkbox"> ') + inline(task.rest, ctx)
          : inline(b.t, ctx);
      } else {
        content = inline(b.t, ctx);
      }
      inner += loose ? '<p>' + content + '</p>\n' : content;
    } else {
      inner += renderBlock(b, ctx);
    }
  }
  return '<li>' + inner + '</li>\n';
}

// ---------------------------------------------------------------------------
// Inline parser — node-list model
// Node types:
//   0 text {s}                 — raw text, escaped at render
//   1 raw  {s, plain, ext}    — final HTML; plain = plain-text form (alt text)
//   2 delim {c, n, o, cl, a, before, after}
//   3 opener {img, a, pos, idx}
//   4 linkStart {href, title}
//   5 linkEnd {}
// ---------------------------------------------------------------------------

function isLocalPartCode(c) {
  // The GFM spec lists '*' and '~' as local-part chars, but marked
  // does not treat them as such: '*foo@bar.com' links only
  // 'foo@bar.com' (the '*' stays literal), and 'a*b@c.com' links
  // only 'b@c.com' (dbg36). '_' IS a local-part char.
  return isAlnumCode(c) || c === 46 || c === 33 || c === 35 || c === 36 || c === 37 ||
    c === 38 || c === 39 || c === 43 || c === 47 || c === 61 || c === 63 ||
    c === 94 || c === 95 || c === 96 || c === 123 || c === 124 || c === 125 || c === 45;
}

function isWwwTrigger(c) {
  return c === undefined || isSpaceCh(c) || c === '(' || c === '*' || c === '~' || c === '_';
}

// Lookup tables for the ASCII char classes (exact: isAlnumCode,
// isLocalPartCode and isAsciiPunctCode are all ASCII-only, so an
// out-of-range index yields undefined, which is falsy — the same as
// the function returning false). A table lookup is far cheaper than
// the function-call chain on the inline() hot path.
const ALNUM_T = new Uint8Array(128);
const LOCAL_T = new Uint8Array(128);
const PUNCT_T = new Uint8Array(128);
for (let c = 0; c < 128; c++) {
  if (isAlnumCode(c)) ALNUM_T[c] = 1;
  if (isLocalPartCode(c)) LOCAL_T[c] = 1;
  if (isAsciiPunctCode(c)) PUNCT_T[c] = 1;
}

// Trim trailing punctuation off a matched URL (GFM autolink rules).
function trimUrl(u) {
  let end = u.length;
  // A '(' with no ')' after it in the run truncates the URL there:
  // marked's backpedal only keeps a '(' as part of a \(...\) group
  // (v9 vs v10: 'https://x.com)](https://y.com (T))' splits into two
  // autolinks, but 'https://x.com)](https://y.com)' swallows both).
  // This also fixes n7/n9, where a run ending in '(not'/'(y.com'
  // must stop at the '('.
  for (let p = u.indexOf('('); p !== -1; p = u.indexOf('(', p + 1)) {
    if (u.indexOf(')', p + 1) === -1) { end = p; break; }
  }
  // A trailing named entity reference (&word;) is not part of the URL
  // (oracle34). A numeric entity (&#...;) keeps its digits; only its
  // ';' is trimmed as punctuation below.
  if (end > 0 && u[end - 1] === ';') {
    let p = end - 2;
    while (p >= 0 && isAlnumCode(u.charCodeAt(p))) p--;
    if (p >= 0 && u[p] === '&' && p + 1 < end - 1) {
      const c1 = u.charCodeAt(p + 1);
      if ((c1 >= 65 && c1 <= 90) || (c1 >= 97 && c1 <= 122)) end = p;
    }
  }
  while (end > 0) {
    const c = u[end - 1];
    if (c === '.' || c === ',' || c === ':' || c === ';' || c === '!' || c === '?' ||
      c === '*' || c === '_' || c === '~' || c === "'" || c === '"' || c === '(') {
      end--;
      continue;
    }
    if (c === ')') {
      const li = u.lastIndexOf('(', end - 1);
      if (li === -1) { end--; continue; }
      const nc = u.indexOf(')', li + 1);
      if (nc !== -1 && nc < end - 1) { end--; continue; }
      break;
    }
    break;
  }
  return u.slice(0, end);
}

// URL run: chars until whitespace or '<'. Returns {text, end} or null.
// A ']' only stops the run when it would close a link that actually
// forms (checked with tryLink on the nearest open '['): marked's URL
// regex never stops at ']' — it swallows it (href '…)%5D') — so a run
// must continue past a ']' whose link attempt fails (the opener is then
// consumed and can never form a link later). Stopping at every ']' broke
// doc-08/12/22/36; never stopping broke '[a https://example.com](foo)',
// where the outer link must form.
function matchUrlRun(text, i, openers, refs) {
  let j = i;
  const n = text.length;
  // '[' groups inside the run are balanced groups in marked's label
  // regex, so a ']' closing one is not the outer link's closing
  // bracket (probe n4: '[a https://x.com/(y[z](u2)' is one autolink,
  // the ']' after '[z' does not close '[a').
  let depth = 0;
  while (j < n) {
    const c = text[j];
    if (c === ' ' || c === '\t' || c === '\n' || c === '<') break;
    if (c === '\\' && j + 1 < n &&
        (text[j + 1] === '[' || text[j + 1] === ']' || text[j + 1] === '\\')) {
      j += 2;
      continue;
    }
    if (c === '[') { depth++; j++; continue; }
    if (c === ']') {
      if (depth > 0) { depth--; j++; continue; }
      if (openers && openers.length) {
        const opener = openers[openers.length - 1];
        if (opener.a && tryLink(text, j, opener, refs)) break;
      }
    }
    j++;
  }
  const trimmed = trimUrl(text.slice(i, j));
  if (!trimmed) return null;
  return { text: trimmed, end: i + trimmed.length };
}

// First ']' in text[from, to) at bracket depth 0 (balanced '[' groups
// skipped) where a link would form for the nearest opener, else -1.
// Used to keep a code span from swallowing a link's closing bracket:
// marked tokenizes the link first, so a span is confined to the link
// text (doc-09/16/28/35). If the first depth-0 ']' fails tryLink the
// opener is consumed there, so no later ']' can form it either.
function firstFormingBracket(text, from, to, openers, refs) {
  if (!openers || !openers.length) return -1;
  const opener = openers[openers.length - 1];
  if (!opener.a) return -1;
  let depth = 0;
  for (let j = from; j < to; j++) {
    const c = text[j];
    if (c === '\\' && j + 1 < to &&
        (text[j + 1] === '[' || text[j + 1] === ']' || text[j + 1] === '\\')) {
      j++;
      continue;
    }
    if (c === '[') { depth++; continue; }
    if (c === ']') {
      if (depth > 0) { depth--; continue; }
      return tryLink(text, j, opener, refs) ? j : -1;
    }
  }
  return -1;
}

// Scan a link label from its opener, following marked's label regex:
// code-span units (a backtick run to the FIRST later backtick run, any
// length) and nested bracket pairs. A ']' at position b is "swallowed"
// when it falls inside a code-span unit (between the unit's opener run
// and the end of its closer run); otherwise it is the bracket that
// closes the label. `closer` is the start of the closer run of the
// unit whose opener is at position i (or -1 when i is not a unit
// opener — e.g. i is itself a unit's closer run).
function labelUnits(text, openerPos, img, i, b) {
  const n = text.length;
  let j = openerPos + (img ? 2 : 1);
  let closer = -1;
  while (j < b && j < n) {
    const c = text[j];
    if (c === '\\' && j + 1 < n) { j += 2; continue; }
    if (c === '[') {
      // Nested bracket unit: backticks inside it are literal chars,
      // so skip to its matching ']' (depth-aware, escapes respected).
      let depth = 1;
      j++;
      while (j < n && depth > 0) {
        const d = text[j];
        if (d === '\\' && j + 1 < n) { j += 2; continue; }
        if (d === '[') depth++;
        else if (d === ']') depth--;
        j++;
      }
      continue;
    }
    if (c === '`') {
      // Unit opener at j: its closer is the first backtick run after it.
      let q = j;
      while (q < n && text[q] === '`') q++;
      let r = q;
      while (r < n && text[r] !== '`') r++;
      if (r >= n) break; // no closer run: the unit never closes
      let rEnd = r;
      while (rEnd < n && text[rEnd] === '`') rEnd++;
      if (j === i) closer = r;
      if (b > j && b < rEnd) return { swallowed: true, closer };
      j = rEnd;
      continue;
    }
    j++;
  }
  return { swallowed: false, closer };
}

function schemeLen(text, i) {
  // Case-insensitive 'https://' / 'http://' / 'ftp://' by char codes —
  // no slice/lowercase allocation (called for every h/H/f/F char).
  // charCodeAt past the end yields NaN, which never equals a target.
  const c0 = text.charCodeAt(i);
  if (c0 === 104 || c0 === 72) { // h/H
    if (text.charCodeAt(i + 1) !== 116 && text.charCodeAt(i + 1) !== 84) return 0;
    if (text.charCodeAt(i + 2) !== 116 && text.charCodeAt(i + 2) !== 84) return 0;
    if (text.charCodeAt(i + 3) !== 112 && text.charCodeAt(i + 3) !== 80) return 0;
    const c4 = text.charCodeAt(i + 4);
    if (c4 === 115 || c4 === 83) { // s/S -> https://
      return text.charCodeAt(i + 5) === 58 && text.charCodeAt(i + 6) === 47 &&
        text.charCodeAt(i + 7) === 47 ? 8 : 0;
    }
    // http://
    return c4 === 58 && text.charCodeAt(i + 5) === 47 &&
      text.charCodeAt(i + 6) === 47 ? 7 : 0;
  }
  if (c0 === 102 || c0 === 70) { // f/F -> ftp://
    if (text.charCodeAt(i + 1) !== 116 && text.charCodeAt(i + 1) !== 84) return 0;
    if (text.charCodeAt(i + 2) !== 112 && text.charCodeAt(i + 2) !== 80) return 0;
    return text.charCodeAt(i + 3) === 58 && text.charCodeAt(i + 4) === 47 &&
      text.charCodeAt(i + 5) === 47 ? 6 : 0;
  }
  return 0;
}

// If text[colonPos] is ':' ending a valid scheme (2-32 chars, starts
// with a letter), return the scheme's start index; else -1. Used for
// scheme:email extended autolinks (mailto:, xmpp:, ...).
function schemeStartBefore(text, colonPos) {
  let p = colonPos - 1;
  while (p >= 0) {
    const c = text.charCodeAt(p);
    if (isAlnumCode(c) || c === 43 || c === 46 || c === 45) { p--; continue; }
    break;
  }
  const start = p + 1;
  const len = colonPos - start;
  if (len < 2 || len > 32) return -1;
  const c0 = text.charCodeAt(start);
  if (!((c0 >= 65 && c0 <= 90) || (c0 >= 97 && c0 <= 122))) return -1;
  return start;
}

// Email match at i (i is the start of the local part). Returns {text, end}.
// When allowTrailingUnderscore is true, a '_' right after the domain
// does not invalidate the email — it is a closing emphasis delimiter
// for a '_' run that opened before the email (doc-04:
// '__because@mark.example.com__' links 'because@mark.example.com').
function matchEmailAt(text, i, allowTrailingUnderscore) {
  const n = text.length;
  let j = i;
  while (j < n && LOCAL_T[text.charCodeAt(j)]) j++;
  if (j === i || j >= n || text[j] !== '@') return null;
  let k = j + 1;
  let m = k;
  while (m < n) {
    const c = text.charCodeAt(m);
    if (ALNUM_T[c] || c === 45 || c === 46) { m++; continue; }
    break;
  }
  let end = m;
  // Only a trailing '.' is punctuation to trim. A trailing '-' makes
  // the domain label end with '-' (invalid) and must NOT be trimmed
  // (gfm-632: a.b-c_d@a.b- is not a link at all).
  while (end > k && text[end - 1] === '.') end--;
  if (end === k) return null;
  const domain = text.slice(k, end);
  if (!domain.includes('.')) return null;
  let start = 0;
  for (let p = 0; p <= domain.length; p++) {
    if (p === domain.length || domain[p] === '.') {
      const label = domain.slice(start, p);
      if (!label) return null;
      if (!ALNUM_T[label.charCodeAt(0)] ||
        !ALNUM_T[label.charCodeAt(label.length - 1)]) return null;
      start = p + 1;
    }
  }
  // A '_' immediately after the domain invalidates the email
  // (gfm-632: a.b-c_d@a.b_ is not a link) — unless it is the closing
  // delimiter of a '_' run that opened before the email.
  if (end < n && text[end] === '_' && !allowTrailingUnderscore) return null;
  return { text: text.slice(i, end), end };
}

function matchAngleAutolink(text, i) {
  const n = text.length;
  let j = i + 1;
  while (j < n) {
    const c = text[j];
    if (c === ' ' || c === '\t' || c === '\n' || c === '<') return null;
    const cc = text.charCodeAt(j);
    if (cc < 32 || cc === 127) return null;
    if (c === '>') break;
    j++;
  }
  if (j >= n || text[j] !== '>') return null;
  const content = text.slice(i + 1, j);
  // scheme: 2-32 chars
  let colon = -1;
  for (let k = 0; k < content.length; k++) {
    if (content[k] === ':') { colon = k; break; }
    if (k === 0) {
      if (!isAlphaCode(content.charCodeAt(0))) break;
    } else if (!(isAlnumCode(content.charCodeAt(k)) ||
      content[k] === '+' || content[k] === '.' || content[k] === '-')) break;
  }
  if (colon >= 2 && colon <= 32) {
    return {
      node: { t: 1, s: '<a href="' + encodeHref(content) + '">' + escEnt(content) + '</a>', plain: content },
      end: j + 1,
    };
  }
  const em = matchEmailAt(content, 0);
  if (em && em.end === content.length) {
    return {
      node: {
        t: 1,
        s: '<a href="mailto:' + encodeHref(content) + '">' + escEnt(content) + '</a>',
        plain: content,
      },
      end: j + 1,
    };
  }
  return null;
}

// Parse an HTML open/close tag starting at text[i] === '<'.
// Returns the index just past the closing '>' or -1 if invalid.
// Attribute names: [A-Za-z_:][A-Za-z0-9_.:-]*
// Values: unquoted (no ws " ' = < > `), '...' or "...".
// Closing tags take no attributes. Used by the inline raw-HTML
// matcher and by the type-7 HTML-block check.
function parseTagEnd(text, i) {
  const n = text.length;
  let j = i + 1;
  let closing = false;
  if (text[j] === '/') { closing = true; j++; }
  if (j >= n || !isAlphaCode(text.charCodeAt(j))) return -1;
  j++;
  while (j < n) {
    const c = text.charCodeAt(j);
    if (isAlnumCode(c) || c === 45) { j++; continue; }
    break;
  }
  if (closing) {
    // Only whitespace may follow a closing tag's name.
    while (j < n && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n')) j++;
    if (j < n && text[j] === '>') return j + 1;
    return -1;
  }
  // Open tag: attributes, then '>' or '/>'. Attributes must be
  // separated by whitespace (cm-622: `<a href='bar'title=title>` is
  // not a tag, because `title` follows `'bar'` with no whitespace).
  let needWs = true; // whitespace required before the next attribute
  while (j < n) {
    const c = text[j];
    if (c === '>') return j + 1;
    if (c === '/' && text[j + 1] === '>') return j + 2;
    if (c === ' ' || c === '\t' || c === '\n') { j++; needWs = false; continue; }
    if (needWs) return -1;
    // Attribute name (must start with a letter, '_' or ':').
    if (!isAlphaCode(text.charCodeAt(j)) && c !== '_' && c !== ':') return -1;
    j++;
    while (j < n) {
      const ac = text.charCodeAt(j);
      if (isAlnumCode(ac) || ac === 95 || ac === 58 || ac === 46 || ac === 45) { j++; continue; }
      break;
    }
    // Optional whitespace, '=', value. Remember whether whitespace
    // was skipped: it is what separates a valueless attribute from
    // the next attribute (a valueless attribute followed by whitespace
    // needs no further whitespace before the next attribute).
    let sawWs = false;
    while (j < n && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n')) { j++; sawWs = true; }
    if (text[j] !== '=') { needWs = !sawWs; continue; } // valueless attribute
    j++;
    while (j < n && (text[j] === ' ' || text[j] === '\t' || text[j] === '\n')) j++;
    if (j >= n) return -1;
    const vc = text[j];
    if (vc === '"') {
      const k = text.indexOf('"', j + 1);
      if (k === -1) return -1;
      j = k + 1;
    } else if (vc === "'") {
      const k = text.indexOf("'", j + 1);
      if (k === -1) return -1;
      j = k + 1;
    } else {
      // Unquoted value: at least one char, none of ws " ' = < > `.
      if (vc === ' ' || vc === '\t' || vc === '\n' || vc === '"' || vc === "'" ||
          vc === '=' || vc === '<' || vc === '>' || vc === '`') return -1;
      while (j < n) {
        const uc = text[j];
        if (uc === ' ' || uc === '\t' || uc === '\n' || uc === '"' || uc === "'" ||
            uc === '=' || uc === '<' || uc === '>' || uc === '`') break;
        j++;
      }
    }
    needWs = true;
  }
  return -1;
}

function matchRawHtml(text, i) {
  const n = text.length;
  if (text.startsWith('<!--', i)) {
    // `<!-->` and `<!--->` are empty comments that close immediately
    // (cm-626: `<!--> foo -->` is the comment `<!-->` plus the text
    // ` foo -->`, whose `-->` is escaped).
    if (text[i + 4] === '>') return { text: '<!-->', end: i + 5 };
    if (text[i + 4] === '-' && text[i + 5] === '>') return { text: '<!--->', end: i + 6 };
    const end = text.indexOf('-->', i + 4);
    if (end === -1) return null;
    return { text: text.slice(i, end + 3), end: end + 3 };
  }
  if (text.startsWith('<?', i)) {
    const end = text.indexOf('?>', i + 2);
    if (end === -1) return null;
    return { text: text.slice(i, end + 2), end: end + 2 };
  }
  if (text.startsWith('<!', i) && i + 2 < n && isAlphaCode(text.charCodeAt(i + 2))) {
    const end = text.indexOf('>', i + 2);
    if (end === -1) return null;
    return { text: text.slice(i, end + 1), end: end + 1 };
  }
  if (text.startsWith('<![CDATA[', i)) {
    const end = text.indexOf(']]>', i + 9);
    if (end === -1) return null;
    return { text: text.slice(i, end + 3), end: end + 3 };
  }
  const tagEnd = parseTagEnd(text, i);
  if (tagEnd === -1) return null;
  return { text: text.slice(i, tagEnd), end: tagEnd };
}

function skipInlineWs(text, j) {
  const n = text.length;
  while (j < n) {
    const c = text[j];
    if (c === ' ' || c === '\t' || c === '\n') { j++; continue; }
    break;
  }
  return j;
}

// Parse an inline link destination + optional title starting at the '('
// (text[openParen] === '('). Returns {href, title, end} or null when the
// inline form does not parse.
function parseInlineLink(text, openParen) {
  const n = text.length;
  let j = skipInlineWs(text, openParen + 1);
  let dest = '';
  if (text[j] === '<') {
    let k = j + 1;
    let ok = false;
    while (k < n) {
      const c = text[k];
      if (c === '\n' || c === '<') break;
      if (c === '\\' && k + 1 < n && isAsciiPunctCode(text.charCodeAt(k + 1))) {
        dest += text[k + 1];
        k += 2;
        continue;
      }
      if (c === '>') { ok = true; k++; break; }
      dest += c;
      k++;
    }
    if (!ok) return null;
    j = k;
  } else {
    let k = j;
    let depth = 0;
    while (k < n) {
      const c = text[k];
      const cc = text.charCodeAt(k);
      if (c === ' ' || c === '\t' || c === '\n') break;
      if (cc < 32 || cc === 127) return null;
      if (c === '\\' && k + 1 < n && isAsciiPunctCode(text.charCodeAt(k + 1))) {
        dest += text[k + 1];
        k += 2;
        continue;
      }
      if (c === '(') { depth++; dest += c; k++; continue; }
      if (c === ')') {
        if (depth === 0) break;
        depth--;
        dest += c;
        k++;
        continue;
      }
      dest += c;
      k++;
    }
    j = k;
  }
  j = skipInlineWs(text, j);
  let title = null;
  if (text[j] === '"' || text[j] === "'" || text[j] === '(') {
    const open = text[j];
    const close = open === '(' ? ')' : open;
    let k = j + 1;
    let t = '';
    let ok = false;
    while (k < n) {
      const c = text[k];
      if (c === '\\' && k + 1 < n && isAsciiPunctCode(text.charCodeAt(k + 1))) {
        t += text[k + 1];
        k += 2;
        continue;
      }
      if (c === close) { ok = true; k++; break; }
      if (open === '(' && c === '(') break;
      t += c;
      k++;
    }
    if (!ok) return null;
    title = t;
    j = skipInlineWs(text, k);
  }
  if (text[j] !== ')') return null;
  return { href: encodeHref(dest), title, end: j + 1 };
}

// Try to resolve a link at ']' (text[i] === ']'). Returns
// {href, title, img, end} or null.
//
// Form selection mirrors marked's regex alternation: the forms are tried
// in order (inline, full reference, collapsed reference, shortcut) and
// the FIRST form whose syntax matches is used. A form that matches
// syntactically but whose label is undefined fails the link entirely
// (no fall-through to a later form). A form whose syntax does not match
// falls through to the next form. So an inline link that fails to parse
// falls back to the shortcut (cm-568: `[foo](not a link)` links via
// `[foo]`), while a well-formed full reference with an undefined label
// does not (cm-565: `[foo][bar]` stays literal when only `[foo]` is
// defined).
// A code span inside link text blocks the link when (oracle52/53/54):
// the span is unclosed (no matching backtick run before the ']'), or
// the span is delimited by >=2 backticks, its content contains a
// backtick, and the span does not end exactly at the ']' (text follows
// it). A closed span without an inner backtick, or one ending right at
// the ']', lets the link form.
function hasBadCodeSpan(s) {
  const n = s.length;
  let i = 0;
  while (i < n) {
    // An escaped backtick is literal text, not a code span delimiter.
    if (s[i] === '\\' && i + 1 < n) { i += 2; continue; }
    if (s[i] !== '`') { i++; continue; }
    let run = 0;
    while (i + run < n && s[i + run] === '`') run++;
    let j = i + run;
    let found = -1;
    while (j < n) {
      if (s[j] === '`') {
        let r2 = 0;
        while (j + r2 < n && s[j + r2] === '`') r2++;
        if (r2 === run) { found = j; break; }
        j += r2;
      } else j++;
    }
    if (found === -1) {
      // An unclosed run is literal text (it does not block the link
      // on its own — the lone-backtick cases in oracle54 are covered
      // by the inner-backtick rule below when a span is present, and
      // a bare unclosed run like doc-24 `[client ``commit` ...]`
      // leaves the link intact). Skip it and keep scanning.
      i += run;
      continue;
    }
    const content = s.slice(i + run, found);
    if (run >= 2 && content.indexOf('`') !== -1 && found + run < n) return true;
    i = found + run;
  }
  return false;
}

function tryLink(text, i, opener, refs) {
  const n = text.length;
  const img = opener.img;
  const linkText = text.slice(opener.pos + (img ? 2 : 1), i);
  if (linkText.indexOf('`') !== -1 && hasBadCodeSpan(linkText)) return null;
  const mk = (ref, end) => ({
    href: encodeHref(ref.dest),
    title: ref.title !== null ? ref.title : null,
    img, end,
  });
  if (text[i + 1] === '(') {
    const inl = parseInlineLink(text, i + 1);
    if (inl) return { href: inl.href, title: inl.title, img, end: inl.end };
    // Inline syntax failed: fall through to the shortcut below.
  } else if (text[i + 1] === '[') {
    // Full or collapsed reference. The label may contain balanced
    // brackets, tracked with a depth counter.
    let j = i + 2;
    let label = '';
    let closed = false;
    let depth = 0;
    while (j < n) {
      const c = text[j];
      if (c === '\\' && j + 1 < n && isAsciiPunctCode(text.charCodeAt(j + 1))) {
        label += text.slice(j, j + 2);
        j += 2;
        continue;
      }
      if (c === '[') { depth++; label += c; j++; continue; }
      if (c === ']') {
        if (depth === 0) { closed = true; j++; break; }
        depth--; label += c; j++; continue;
      }
      label += c;
      j++;
    }
    if (closed) {
      const ref = refs.get(normalizeLabel(label === '' ? linkText : label));
      if (ref) return mk(ref, j);
      return null; // form matched but the label is undefined: fail entirely
    }
    // Label unclosed: fall through to the shortcut below.
  }
  const ref = refs.get(normalizeLabel(linkText));
  if (!ref) return null;
  return mk(ref, i + 1);
}

function altText(nodes, fromIdx, toIdx) {
  let out = '';
  for (let k = fromIdx; k < toIdx; k++) {
    const node = nodes[k];
    switch (node.t) {
      case 0: out += node.s; break;
      case 1: if (node.plain !== undefined) out += node.plain; break;
      case 2: out += node.c.repeat(node.n); break;
      case 3: out += node.img ? '![' : '['; break;
      default: break;
    }
  }
  return out;
}

// Escape for alt attributes: like esc(), but an '&' starting an
// entity-like sequence (&word; / &#...;) is kept verbatim.
// Also used for hrefs, titles and fenced-code languages, where marked
// keeps entity-like sequences verbatim too.
function escEnt(s) {
  let out = '';
  let last = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c === 38) {
      let j = i + 1;
      let ok = false;
      if (s[j] === '#') {
        j++;
        if (s[j] === 'x' || s[j] === 'X') j++;
        let k = j;
        while (k < s.length) {
          const cc = s.charCodeAt(k);
          if (isDigitCode(cc) || (cc >= 97 && cc <= 102) || (cc >= 65 && cc <= 70)) { k++; continue; }
          break;
        }
        if (k > j && s[k] === ';') ok = true;
      } else {
        let k = j;
        while (k < s.length) {
          const cc = s.charCodeAt(k);
          if (isAlnumCode(cc) || cc === 95) { k++; continue; }
          break;
        }
        if (k > j && s[k] === ';') ok = true;
      }
      if (ok) continue;
      out += s.slice(last, i) + '&amp;';
      last = i + 1;
      continue;
    }
    let rep = null;
    if (c === 60) rep = '&lt;';
    else if (c === 62) rep = '&gt;';
    else if (c === 34) rep = '&quot;';
    else if (c === 39) rep = '&#39;';
    if (rep !== null) {
      out += s.slice(last, i) + rep;
      last = i + 1;
    }
  }
  return last === 0 ? s : out + s.slice(last);
}

function isLeftFlanking(prev, next) {
  if (isSpaceCh(next)) return false;
  if (!isPunctCh(next)) return true;
  return isSpaceCh(prev) || isPunctCh(prev);
}

function isRightFlanking(prev, next) {
  if (isSpaceCh(prev)) return false;
  if (!isPunctCh(prev)) return true;
  return isSpaceCh(next) || isPunctCh(next);
}

function hasInnerBothFlanking(delims, k, di) {
  for (let m = k + 1; m < di; m++) {
    const r = delims[m];
    if (r.o && r.usedCl) return true;
  }
  return false;
}

// Whether closer C may match opener O under marked's emStrong pool
// (doc-03/07/11/22/29: '*X **Y**Z*' — the outer '*' must stay
// literal, the inner '**' still forms strong). m starts at O's
// original run length; same-character runs between O and C adjust it:
// opener-only adds its length, closer-only subtracts (m<=0 means
// that run is the closer, so C cannot match O), both-flanking either
// goes to f (rule of 3: y%3 && (y+b)%3==0) or subtracts like a
// closer. At C, m - C.origN > 0 means C cannot absorb the pool.
// Returns {ok, m, f, affected} where m/f are the pool state after
// the intermediate runs (before C), used for the b_used computation.
// `affected` is true only when an intermediate run actually moved
// m/f; with no effective intermediates the existing odd-match/use
// logic already handles the match (and the run-splitting fallback
// relies on matching the whole run, e.g. '***foo*' -> '**<em>foo</em>').
function poolCheck(O, C, delims, oj, di) {
  let m = O.origN;
  let f = 0;
  const y = O.origN;
  const p = O.prev;
  const d = O.next !== undefined && isPunctCh(O.next);
  const h = p !== undefined && (p === '*' || p === '_' || isPunctCh(p));
  const R = p !== undefined && p.trim() !== '' && (d || (O.c === '*' && !h));
  let affected = false;
  for (let k = oj + 1; k < di; k++) {
    const r = delims[k];
    if (r.c !== O.c || r.scope !== O.scope) continue;
    // A run deactivated but unconsumed sits inside a matched span
    // of a DIFFERENT character (the "different character" rule
    // deactivates it without consuming it). Marked's RDelim regex
    // skips such spans entirely (cm-470: '*foo __bar *baz bim__ bam*'
    // — the '*' inside '__...__' must not count in the '*' pool),
    // so it must not count here either. A run consumed by a
    // same-character match (n < origN) DOES count: marked scans the
    // raw text, where the full run is still present (doc-03).
    if (!r.a && r.n === r.origN) continue;
    // A delimiter inside a masked (pseudo-code-span) region is
    // invisible to marked's RDelim scan, so it must not count in
    // the pool either (doc-09/16/28/35).
    if (r.masked) continue;
    const b = r.origN;
    if (r.o && !r.cl) { m += b; affected = true; continue; }
    if ((r.o && r.cl) || R) {
      if (y % 3 !== 0 && (y + b) % 3 === 0) { f += b; affected = true; continue; }
      m -= b;
      affected = true;
      if (m <= 0) return { ok: false, m, f, affected };
      continue;
    }
    if (!r.o && r.cl) {
      m -= b;
      affected = true;
      if (m <= 0) return { ok: false, m, f, affected };
      continue;
    }
  }
  if (!affected) return { ok: true, m, f, affected };
  if (m - C.origN > 0) return { ok: false, m, f, affected };
  return { ok: true, m, f, affected };
}

function processEmphasis(nodes, delims) {
  for (let di = 0; di < delims.length; di++) {
    const closer = delims[di];
    if (!closer.a || !closer.cl || closer.n === 0 || closer.masked) continue;
    // Marked's b_used (emStrong) for the LAST match this closer
    // makes, and the total delimiters it consumed: after the loop,
    // leftover stars that marked claims inside the outermost element
    // (b_used - totalUsed) are moved ahead of the last end tag
    // (doc-11/30). Tracked here; applied after the while loop so a
    // star reserved for a later (outer) match is never stolen early
    // ('***bar***' must stay '<em><strong>bar</strong></em>').
    let totalUsed = 0;
    let lastBUsed = 0;
    while (closer.n > 0 && closer.cl) {
      let opener = null;
      let oj = -1;
      let poolState = null;
      // The nearest opener that can match, and the earliest opener
      // that can match with a full-length run (origN === closer.origN).
      let nearOpener = null, nearOj = -1, nearPool = null;
      let fullOpener = null, fullOj = -1, fullPool = null;
      for (let k = di - 1; k >= 0; k--) {
        const o = delims[k];
        if (!o.a || !o.o || o.n === 0) continue;
        if (o.c !== closer.c) continue;
        // A delimiter inside a link's text may only match a delimiter
        // in the same link scope, never one outside the link.
        if (o.scope !== closer.scope) continue;
        if (closer.c === '~') {
          if (o.n !== closer.n) continue;
        } else if (o.origN % 3 !== 0 &&
          (o.origN + closer.origN) % 3 === 0 &&
          ((o.cl || closer.o) ||
            (o.origN > closer.origN && hasInnerBothFlanking(delims, k, di)))) {
          // marked's odd-match rule (original run lengths). The
          // CommonMark canClose/canOpen qualifier applies normally,
          // but once a both-flanking inner closer sits between the
          // opener and this closer AND the opener run is longer than
          // the closer run, the qualifier is dropped: the closer is
          // skipped on lengths alone.
          // (doc-01: `**public as *so*other* option html**` — the
          // inner `*so*` closer is both-flanking and the opener
          // `**` is longer than the lone `*`, so the lone `*` after
          // `other` is skipped and the `**` at the end forms the
          // strong. doc-27 `*uses state *callback*markdown**` keeps
          // its outer em because the opener `*` is shorter than the
          // closer `**`.)
          continue;
        }
        // Pool check: a closer cannot match an opener whose pool it
        // cannot absorb (see poolCheck).
        const pool = poolCheck(o, closer, delims, k, di);
        if (pool.affected && !pool.ok) continue;
        if (!nearOpener) { nearOpener = o; nearOj = k; nearPool = pool; }
        if (closer.c !== '~' && o.origN === closer.origN) {
          // Full-length match; keep the earliest one (the scan
          // continues back, so the last one found is the earliest).
          fullOpener = o; fullOj = k; fullPool = pool;
        }
        // If the nearest opener is itself a full match it wins and
        // there is no need to scan further ('~' always takes the
        // nearest opener).
        if (nearOpener && (closer.c === '~' || nearOpener.origN === closer.origN)) break;
      }
      // A full-length match from an earlier opener wins over a shorter
      // nearer opener (doc-11/h2: '**removes example *input
      // **parse**parse* release**' — the outer '**' claims the '**'
      // closer; the nearer '*' stays literal). Otherwise the nearest
      // opener wins.
      if (nearOpener && nearOpener.origN === closer.origN) {
        opener = nearOpener; oj = nearOj; poolState = nearPool;
      } else if (fullOpener) {
        opener = fullOpener; oj = fullOj; poolState = fullPool;
      } else {
        opener = nearOpener; oj = nearOj; poolState = nearPool;
      }
      if (!opener) break;
      let use;
      if (closer.c === '~') use = opener.n;
      else use = opener.n >= 2 && closer.n >= 2 ? 2 : 1;
      const strong = use === 2;
      const startTag = closer.c === '~' ? '<del>' : strong ? '<strong>' : '<em>';
      const endTag = closer.c === '~' ? '</del>' : strong ? '</strong>' : '</em>';
      opener.after = opener.after ? [startTag, ...opener.after] : [startTag];
      closer.before = closer.before ? [...closer.before, endTag] : [endTag];
      opener.n -= use;
      closer.n -= use;
      closer.usedCl += use;
      totalUsed += use;
      // b_used = min(b, pool.m + pool.f) for this match (marked's
      // emStrong); the last match's value decides the inside split.
      if (closer.c !== '~' && poolState) {
        lastBUsed = Math.min(closer.origN, poolState.m + poolState.f);
      }
      if (opener.n === 0) opener.a = false;
      if (closer.n === 0) closer.a = false;
      // Delimiters of a different character strictly between the matched
      // pair can no longer open/close (they are inside the emphasis and
      // their would-be partner lies outside it).
      for (let k = oj + 1; k < di; k++) {
        if (delims[k].c !== opener.c) delims[k].a = false;
      }
    }
    // Leftover closer stars: marked's outermost emStrong claims
    // b_used of the run (b_used - totalUsed of them as literal text
    // inside its element, the rest outside). Move that many ahead of
    // the last (outermost) end tag; the remainder stays outside.
    if (closer.c !== '~' && closer.n > 0 && closer.usedCl > 0 &&
        lastBUsed > 0 && closer.before && closer.before.length) {
      const inside = Math.max(0, Math.min(closer.n, lastBUsed - totalUsed));
      if (inside > 0) {
        const stars = closer.c.repeat(inside);
        closer.before = [
          ...closer.before.slice(0, -1), stars,
          closer.before[closer.before.length - 1],
        ];
        closer.n -= inside;
      }
    }
  }
}

function renderInline(nodes) {
  let out = '';
  for (const node of nodes) {
    if (node.before) out += node.before.join('');
    switch (node.t) {
      case 0: out += esc(node.s); break;
      case 1: out += node.s; break;
      case 2: out += node.c.repeat(node.n); break;
      case 3: out += node.img ? '![' : '['; break;
      case 4:
        out += '<a href="' + node.href + '"' +
          (node.title !== null && node.title !== undefined
            ? ' title="' + escEnt(node.title) + '"'
            : '') + '>';
        break;
      case 5: out += '</a>'; break;
      default: break;
    }
    if (node.after) out += node.after.join('');
  }
  return out;
}

function inline(text, ctx) {
  const refs = ctx.refs;
  const nodes = [];
  const delims = [];
  const openers = [];
  const n = text.length;
  let i = 0;
  let textStart = 0;
  // Position of a backtick run that is the closing run of a blocked
  // code-span unit: literal text, not a new span opener (doc-09).
  let literalCodeRunAt = -1;
  // Masked regions (marked's emStrong mask): [start, end] of a pseudo
  // code span — a gate-blocked code span whose opener pairs with the
  // first later equal-length run. Emphasis delimiters inside such a
  // region are invisible to marked's findClosing (doc-09/16/28/35).
  const maskRegions = [];
  const flush = (to) => { if (to > textStart) nodes.push({ t: 0, s: text.slice(textStart, to) }); };

  while (i < n) {
    const ch = text[i];
    const cc = text.charCodeAt(i);

    // --- extended autolinks (suppressed while inside an unclosed
    // '<a' tag — ctx.inLink, see the raw-HTML branch below) ---
    if (!ctx.inLink && cc === 119 && text.startsWith('www.', i) &&
      isWwwTrigger(i === 0 ? undefined : text[i - 1])) {
      const m = matchUrlRun(text, i, openers, refs);
      if (m && m.text.length > 4) {
        flush(i);
        nodes.push({
          t: 1,
          s: '<a href="http://' + encodeHref(m.text) + '">' + escEnt(m.text) + '</a>',
          plain: m.text,
          ext: true,
        });
        i = m.end;
        textStart = i;
        continue;
      }
    }
    if (!ctx.inLink && (cc === 104 || cc === 72 || cc === 102 || cc === 70)) {
      const sl = schemeLen(text, i);
      if (sl > 0) {
        const m = matchUrlRun(text, i, openers, refs);
        if (m && m.text.length > sl) {
          flush(i);
          nodes.push({
            t: 1,
            s: '<a href="' + encodeHref(m.text) + '">' + escEnt(m.text) + '</a>',
            plain: m.text,
            ext: true,
          });
          i = m.end;
          textStart = i;
          continue;
        }
      }
    }
    // An email is attempted at the start of a word — and also right
    // after a '_' run that starts at a word boundary, where the run
    // is an emphasis opener rather than part of the local part
    // (doc-04: '__because@mark.example.com__' links the email
    // inside the strong). In that case a '_' after the domain is the
    // closing delimiter, not an invalidator. The same applies when
    // the email sits inside an already-open '_' emphasis run
    // ('__in extensible heading because@mark.example.com__').
    let afterUnderscoreRun = false;
    if (i > 0 && text[i - 1] === '_') {
      let rs = i - 1;
      while (rs > 0 && text[rs - 1] === '_') rs--;
      if (rs === 0 || !LOCAL_T[text.charCodeAt(rs - 1)]) afterUnderscoreRun = true;
    }
    if (!ctx.inLink && LOCAL_T[cc] && (i === 0 || !LOCAL_T[text.charCodeAt(i - 1)] || afterUnderscoreRun)) {
      // The 200-node scan for an open '_' delimiter is only needed
      // when an email is actually attempted (it feeds
      // matchEmailAt's allowTrailingUnderscore); doing it per
      // character was the main inline() hotspot.
      let allowTrailingUnderscore = afterUnderscoreRun;
      if (!allowTrailingUnderscore) {
        // The opening '_' delimiter that this email sits inside is
        // always recent (same paragraph, a handful of nodes back);
        // bounding the scan keeps long documents fast.
        const start = Math.max(0, nodes.length - 200);
        for (let ni = nodes.length - 1; ni >= start; ni--) {
          const nd = nodes[ni];
          if (nd.t === 2 && nd.c === '_' && nd.a) { allowTrailingUnderscore = true; break; }
          if (nd.t === 1 && nd.s && nd.s.startsWith('<a ')) break;
        }
      }
      const m = matchEmailAt(text, i, allowTrailingUnderscore);
      if (m) {
        // A scheme immediately before the email makes the whole
        // scheme:email (plus at most one path segment) a single link
        // (gfm-633, gfm-634, gfm-635).
        let linkStart = i;
        let linkEnd = m.end;
        if (i > 0 && text[i - 1] === ':') {
          const ss = schemeStartBefore(text, i - 1);
          if (ss >= 0) {
            linkStart = ss;
            if (linkEnd < n && text[linkEnd] === '/') {
              let pe = linkEnd + 1;
              while (pe < n) {
                const pc = text[pe];
                if (pc === '/' || pc === ' ' || pc === '\t' || pc === '\n' ||
                  pc === '<' || pc === '>' || pc === '"' || pc === "'") break;
                pe++;
              }
              // Only include the '/' when a path segment follows it.
              if (pe > linkEnd + 1) linkEnd = pe;
            }
          }
        }
        const linkText = trimUrl(text.slice(linkStart, linkEnd));
        if (linkText.length > 0) {
          flush(linkStart);
          const href = linkStart === i ? 'mailto:' + encodeHref(linkText)
            : encodeHref(linkText);
          nodes.push({
            t: 1,
            s: '<a href="' + href + '">' + escEnt(linkText) + '</a>',
            plain: linkText,
            ext: true,
          });
          i = linkStart + linkText.length;
          textStart = i;
          continue;
        }
      }
    }

    // --- backslash ---
    if (ch === '\\') {
      const nc = text[i + 1];
      if (nc === '\n') {
        flush(i);
        nodes.push({ t: 1, s: '<br>', plain: '\n' });
        i += 2;
        while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
        textStart = i;
        continue;
      }
      if (nc !== undefined && isAsciiPunctCode(nc.charCodeAt(0))) {
        flush(i);
        nodes.push({ t: 0, s: nc });
        i += 2;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }

    // --- newline (hard / soft break) ---
    if (ch === '\n') {
      let back = i;
      let spaces = 0;
      while (back > textStart && text[back - 1] === ' ') { back--; spaces++; }
      if (spaces >= 2) {
        flush(back);
        nodes.push({ t: 1, s: '<br>', plain: '\n' });
        i++;
        while (i < n && (text[i] === ' ' || text[i] === '\t')) i++;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }

    // --- code span ---
    if (ch === '`') {
      let run = 0;
      while (i + run < n && text[i + run] === '`') run++;
      // The closing run of a blocked code-span unit is literal text,
      // not a new span opener (doc-09: the single '`' after '``url').
      if (i === literalCodeRunAt) { literalCodeRunAt = -1; i += run; continue; }
      let j = i + run;
      let found = -1;
      while (j < n) {
        if (text[j] === '`') {
          let r2 = 0;
          while (j + r2 < n && text[j + r2] === '`') r2++;
          if (r2 === run) { found = j; break; }
          j += r2;
        } else {
          j++;
        }
      }
      if (found === -1) { i += run; continue; }
      // A code span must not swallow the ']' that closes a forming
      // link: marked tokenizes the link first, so the span is confined
      // to the link text (doc-09/16/28/35: '``url`' inside link text
      // stays literal). But marked's label regex consumes a code-span
      // unit ending at the FIRST backtick run after the opener (any
      // length), so a ']' inside that unit is not a bracket at all
      // (doc-36: '[foo`][ref]`' is a code span, not a link). Only a
      // ']' at or after the unit's end blocks the span. The unit may
      // start at an earlier unclosed run (doc-28/16/35: the '``'
      // before the text, whose closer is the current single '`'), so
      // the unit is found by scanning the label from the opener
      // (labelUnits), not from the current run. When blocked, the
      // unit's closing run is literal text too (it is the unit's
      // closer, not a new span opener) — remember its position; when
      // the current run is itself the unit's closer, nothing more
      // needs remembering.
      const b = firstFormingBracket(text, i + run, found, openers, refs);
      if (b !== -1) {
        const opener = openers[openers.length - 1];
        const lu = labelUnits(text, opener.pos, opener.img, i, b);
        if (!lu.swallowed) {
          if (lu.closer !== -1) literalCodeRunAt = lu.closer;
          // Masked region: marked's blockSkip code regex pairs this
          // run with the first later run of the SAME length (found),
          // hiding the emphasis delimiters between them from
          // findClosing — even though the span itself is blocked by
          // the link gate (doc-09: '``url`' pairs with the '``'
          // before 'a', skipping the single '`' after 'url').
          maskRegions.push([i, found + run]);
          i += run;
          continue;
        }
      }
      let content = text.slice(i + run, found);
      if (content.indexOf('\n') !== -1) content = content.split('\n').join(' ');
      if (content.length >= 2 && content[0] === ' ' &&
        content[content.length - 1] === ' ') {
        let hasNonSpace = false;
        for (let q = 1; q < content.length - 1; q++) {
          if (content[q] !== ' ') { hasNonSpace = true; break; }
        }
        if (hasNonSpace) content = content.slice(1, -1);
      }
      flush(i);
      nodes.push({ t: 1, s: '<code>' + esc(content) + '</code>', plain: content });
      i = found + run;
      textStart = i;
      continue;
    }

    // --- '<' autolink / raw HTML ---
    if (ch === '<') {
      const al = matchAngleAutolink(text, i);
      if (al) {
        flush(i);
        nodes.push(al.node);
        i = al.end;
        textStart = i;
        continue;
      }
      const h = matchRawHtml(text, i);
      if (h) {
        // An unclosed '<a' opening tag (with whitespace after the
        // 'a', so '<a>' and '<a/>' do not count) puts marked into an
        // "inside a link" state that suppresses extended autolinks
        // (www / scheme / email) in this and all following paragraphs
        // until a '</a>' is seen (dbg40/41/42/43). A lone '<a ...>'
        // tag that forms an HTML block never reaches this branch, so
        // it does not suppress anything.
        const t = h.text;
        if (t.length > 2 && (t[1] === 'a' || t[1] === 'A') &&
            (t[2] === ' ' || t[2] === '\t' || t[2] === '\n')) {
          ctx.inLink = true;
        } else if (t.length > 3 && t[1] === '/' && (t[2] === 'a' || t[2] === 'A') &&
            (t[3] === '>' || t[3] === ' ' || t[3] === '\t' || t[3] === '\n')) {
          ctx.inLink = false;
        }
        flush(i);
        nodes.push({ t: 1, s: h.text, plain: h.text });
        i = h.end;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }

    // --- entities ---
    if (ch === '&') {
      if (text[i + 1] === '#') {
        let j = i + 2;
        let hex = false;
        if (text[j] === 'x' || text[j] === 'X') { hex = true; j++; }
        let k = j;
        while (k < n) {
          const c = text.charCodeAt(k);
          if (isDigitCode(c)) { k++; continue; }
          if (hex && ((c >= 97 && c <= 102) || (c >= 65 && c <= 70))) { k++; continue; }
          break;
        }
        if (k > j && text[k] === ';' && k - j <= (hex ? 6 : 7)) {
          const decoded = decodeNumericEntity(text.slice(j, k), hex);
          flush(i);
          nodes.push({ t: 1, s: esc(decoded), plain: decoded });
          i = k + 1;
          textStart = i;
          continue;
        }
        i++;
        continue;
      }
      let j = i + 1;
      while (j < n) {
        const c = text.charCodeAt(j);
        if (isAlnumCode(c) || c === 95) { j++; continue; }
        break;
      }
      if (j > i + 1 && text[j] === ';') {
        flush(i);
        const ent = text.slice(i, j + 1);
        nodes.push({ t: 1, s: ent, plain: ent });
        i = j + 1;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }

    // --- image / link opener ---
    if (ch === '!') {
      if (text[i + 1] === '[') {
        flush(i);
        const op = { t: 3, img: true, a: true, pos: i, idx: nodes.length };
        nodes.push(op);
        openers.push(op);
        i += 2;
        textStart = i;
        continue;
      }
      i++;
      continue;
    }
    if (ch === '[') {
      flush(i);
      const op = { t: 3, img: false, a: true, pos: i, idx: nodes.length };
      nodes.push(op);
      openers.push(op);
      i++;
      textStart = i;
      continue;
    }

    // --- link close ---
    if (ch === ']') {
      // The ']' pairs with the nearest unmatched '[' (bracket pairing),
      // whether or not that opener is still active. A deactivated opener
      // absorbs this ']' (no link forms, the ']' is literal) and is then
      // consumed; a failed link attempt likewise consumes its opener.
      // This is what lets the outer image form in cm-520
      // (`![[[foo](uri1)](uri2)](uri3)`) while the middle one does not,
      // and what lets `[a [b] c](/uri)` form its outer link after `[b]`
      // fails as a shortcut.
      if (openers.length === 0) { i++; continue; }
      const oi = openers.length - 1;
      const opener = openers[oi];
      if (!opener.a) {
        openers.splice(oi, 1);
        i++;
        continue;
      }
      const res = tryLink(text, i, opener, refs);
      if (!res) {
        // The link failed. If it failed because the link text holds
        // a bad code span (a multi-backtick span whose content holds
        // a backtick), the '_' delimiters inside the text stay
        // literal too (doc-20: '[but _previous from `` a ` b ``_](…)'
        // has no link and no em). Only '_' is deactivated — '*' is
        // left alone (doc-01/doc-14/doc-24/doc-40 rely on it).
        const linkText = text.slice(opener.pos + (opener.img ? 2 : 1), i);
        if (linkText.indexOf('`') !== -1 && hasBadCodeSpan(linkText)) {
          for (let k = opener.idx + 1; k < nodes.length; k++) {
            if (nodes[k].t === 2 && nodes[k].c === '_') nodes[k].a = false;
          }
        }
        openers.splice(oi, 1);
        i++;
        continue;
      }
      flush(i);
      if (res.img) {
        // The alt text is the link text rendered as plain text: emphasis
        // (and strikethrough) inside it is resolved on its own first, so
        // its delimiter characters disappear from the alt.
        const altDelims = [];
        for (let k = opener.idx + 1; k < nodes.length; k++) {
          if (nodes[k].t === 2) altDelims.push(nodes[k]);
        }
        if (altDelims.length) processEmphasis(nodes, altDelims);
        const alt = altText(nodes, opener.idx + 1, nodes.length);
        for (let k = opener.idx; k < nodes.length; k++) {
          if (nodes[k].t === 2) nodes[k].a = false;
        }
        const imgHtml = '<img src="' + res.href + '" alt="' + escEnt(alt) + '"' +
          (res.title !== null ? ' title="' + escEnt(res.title) + '"' : '') + '>';
        nodes.length = opener.idx;
        nodes.push({ t: 1, s: imgHtml, plain: alt });
        openers.splice(oi, 1);
      } else {
        for (let k = opener.idx + 1; k < nodes.length; k++) {
          const nd = nodes[k];
          // Delimiters inside the link text move one link-scope deeper:
          // they may only match each other, never a delimiter outside
          // the link (cm-521 `*[foo*](/uri)`, cm-535 `[foo *bar][ref]*`).
          if (nd.t === 2) nd.scope++;
          if (nd.t === 1 && nd.ext) {
            nd.t = 0;
            nd.s = nd.plain;
            delete nd.ext;
            delete nd.plain;
          }
        }
        nodes[opener.idx] = { t: 4, href: res.href, title: res.title };
        nodes.push({ t: 5 });
        for (let k = 0; k < oi; k++) {
          if (!openers[k].img) openers[k].a = false;
        }
        openers.splice(oi, 1);
      }
      i = res.end;
      textStart = i;
      continue;
    }

    // --- emphasis delimiters ---
    if (ch === '*' || ch === '_' || ch === '~') {
      let run = 0;
      while (i + run < n && text[i + run] === ch) run++;
      if (ch === '~' && run >= 3) { i += run; continue; }
      const prev = i > 0 ? text[i - 1] : undefined;
      const next = i + run < n ? text[i + run] : undefined;
      const left = isLeftFlanking(prev, next);
      const right = isRightFlanking(prev, next);
      let canOpen;
      let canClose;
      if (ch === '_') {
        canOpen = left && (!right || isPunctCh(prev));
        canClose = right && (!left || isPunctCh(next));
      } else {
        canOpen = left;
        canClose = right;
      }
      flush(i);
      const d = {
        t: 2, c: ch, n: run, origN: run, o: canOpen, cl: canClose, a: true,
        before: null, after: null, scope: 0, usedCl: 0, prev, next, pos: i,
      };
      nodes.push(d);
      delims.push(d);
      i += run;
      textStart = i;
      continue;
    }

    i++;
  }
  flush(n);
  // Masked emphasis: a delimiter inside a pseudo-code-span region
  // cannot be a closer (marked's findClosing cannot see it), though
  // it can still be an opener — an opener inside the region may
  // match a closer outside it (probe: '[a ``b`](c) parser __start
  // by same `x` z end__ more' forms the <strong>). Only top-level
  // (scope 0) delimiters: link text is tokenized recursively by
  // marked with a fresh mask, so its delimiters keep their role.
  if (maskRegions.length) {
    for (const d of delims) {
      if (d.scope !== 0 || d.masked) continue;
      for (let k = 0; k < maskRegions.length; k++) {
        const rg = maskRegions[k];
        if (d.pos >= rg[0] && d.pos < rg[1]) { d.masked = true; break; }
      }
    }
  }
  processEmphasis(nodes, delims);
  return renderInline(nodes);
}
