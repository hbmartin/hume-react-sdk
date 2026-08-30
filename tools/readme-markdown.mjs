/**
 * Sibling Markdown files a package README links to relatively, mapped to the
 * routes they occupy on the documentation site. Relative links resolve on
 * GitHub and npm, where the README is read next to its siblings, but not on
 * the site, where the README is published under `/packages/`.
 *
 * @type {ReadonlyArray<readonly [RegExp, string]>}
 */
const SIBLING_DOCUMENT_ROUTES = [[/\.\/MIGRATION\.md/gu, '/guide/migration']];

/**
 * Rewrites relative links to sibling Markdown files so they resolve on the
 * documentation site.
 *
 * @param {string} readme
 */
export function rewriteSiblingDocumentLinks(readme) {
  return SIBLING_DOCUMENT_ROUTES.reduce(
    (result, [pattern, route]) => result.replace(pattern, route),
    readme,
  );
}

/**
 * Escapes type-like angle brackets that Vue could interpret as template tags
 * while preserving fenced examples and deliberate raw-HTML blocks, and points
 * relative sibling-document links at their site routes.
 *
 * @param {string} readme
 */
export function makeReadmeVitePressSafe(readme) {
  const state = {
    /** @type {{ character: '`' | '~', length: number } | null} */
    codeFence: null,
    /** @type {number | null} */
    indentedCodeIndent: null,
    /** @type {number | null} */
    listContinuationIndent: null,
    /** Whether the preceding block can continue as a paragraph. */
    paragraphOpen: false,
    /** Raw HTML elements whose text content must remain literal. */
    rawHtmlElement: null,
  };
  return readme
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map((line) => transformReadmeLine(line, state))
    .join('\n');
}

/**
 * @param {string} line
 * @param {{ codeFence: { character: '`' | '~', length: number } | null, indentedCodeIndent: number | null, listContinuationIndent: number | null, paragraphOpen: boolean, rawHtmlElement: string | null }} state
 */
// fallow-ignore-next-line complexity -- explicit branches model CommonMark fence state and escaping
function transformReadmeLine(line, state) {
  if (state.rawHtmlElement !== null) {
    return rewriteSiblingDocumentLinksInRawHtml(line, state);
  }
  if (state.indentedCodeIndent !== null) {
    if (line.trim().length === 0) {
      return line;
    }
    if (getLeadingIndentation(line).columns >= state.indentedCodeIndent) {
      return line;
    }
    state.indentedCodeIndent = null;
  }

  const listItemContentStart =
    state.codeFence === null ? updateListContainer(line, state) : null;
  const paragraphWasOpen = state.paragraphOpen;
  const fence = getCodeFence(
    line,
    state.listContinuationIndent,
    listItemContentStart,
  );
  if (isOpeningFence(state.codeFence, fence)) {
    state.codeFence = {
      character: fence.character,
      length: fence.length,
    };
    state.paragraphOpen = false;
    return line;
  }
  if (state.codeFence !== null) {
    if (isClosingFence(state.codeFence, fence)) state.codeFence = null;
    state.paragraphOpen = false;
    return line;
  }
  const leadingIndentation = getLeadingIndentation(line).columns;
  const indentedCodeIndent =
    state.listContinuationIndent === null
      ? 4
      : state.listContinuationIndent + 4;
  if (leadingIndentation >= indentedCodeIndent && !state.paragraphOpen) {
    state.indentedCodeIndent = indentedCodeIndent;
    return line;
  }
  if (line.trimStart().startsWith('<')) {
    const interruptsParagraph = isInterruptingHtmlBlockStart(line);
    state.paragraphOpen = interruptsParagraph
      ? false
      : paragraphWasOpen || !isTypeSevenHtmlBlockStart(line);
    return rewriteSiblingDocumentLinksInRawHtml(line, state);
  }
  const inlineCodeSegments = getInlineCodeSegments(line);
  const rewrittenSegments = inlineCodeSegments.map((segment) =>
    segment.code
      ? segment
      : { ...segment, value: rewriteSiblingDocumentLinks(segment.value) },
  );
  state.paragraphOpen = canContinueParagraph(
    line,
    listItemContentStart,
    paragraphWasOpen,
  );
  if (
    !rewrittenSegments.some(
      (segment) => !segment.code && /[A-Za-z0-9_.)\]]</u.test(segment.value),
    )
  ) {
    return rewrittenSegments.map((segment) => segment.value).join('');
  }
  return escapeAnglesOutsideInlineCode(rewrittenSegments);
}

/**
 * Raw HTML is preserved, but relative document links in actual `href`
 * attributes still need site routes. Restricting the rewrite to the attribute
 * avoids changing examples in `<code>` elements or unrelated data attributes.
 *
 * @param {string} line
 * @param {{ rawHtmlElement: string | null }} state
 */
function rewriteSiblingDocumentLinksInRawHtml(line, state) {
  let cursor = 0;
  let result = '';

  while (cursor < line.length) {
    if (state.rawHtmlElement !== null) {
      const closingTag = new RegExp(
        `</${escapeRegularExpression(state.rawHtmlElement)}[ \\t]*>`,
        'giu',
      );
      closingTag.lastIndex = cursor;
      const closingMatch = closingTag.exec(line);
      if (closingMatch === null) return `${result}${line.slice(cursor)}`;

      const closingEnd = closingMatch.index + closingMatch[0].length;
      result += line.slice(cursor, closingEnd);
      cursor = closingEnd;
      state.rawHtmlElement = null;
      continue;
    }

    const tagStart = line.indexOf('<', cursor);
    if (tagStart === -1) {
      return `${result}${rewriteSiblingDocumentLinks(line.slice(cursor))}`;
    }
    result += rewriteSiblingDocumentLinks(line.slice(cursor, tagStart));

    const tagEnd = findHtmlTagEnd(line, tagStart);
    if (tagEnd === null) return `${result}${line.slice(tagStart)}`;
    const tag = line.slice(tagStart, tagEnd);
    const literalElement = getOpeningRawHtmlElement(tag);
    result +=
      literalElement === null
        ? rewriteSiblingDocumentLinksInHrefAttributes(tag)
        : tag;
    state.rawHtmlElement = literalElement;
    cursor = tagEnd;
  }

  return result;
}

/** @param {string} tag */
function rewriteSiblingDocumentLinksInHrefAttributes(tag) {
  return tag.replace(
    /(^|[ \t]+)(href[ \t]*=[ \t]*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/giu,
    (
      _attribute,
      leadingWhitespace,
      prefix,
      doubleQuoted,
      singleQuoted,
      unquoted,
    ) => {
      if (doubleQuoted !== undefined) {
        return `${leadingWhitespace}${prefix}"${rewriteSiblingDocumentLinks(doubleQuoted)}"`;
      }
      if (singleQuoted !== undefined) {
        return `${leadingWhitespace}${prefix}'${rewriteSiblingDocumentLinks(singleQuoted)}'`;
      }
      return `${leadingWhitespace}${prefix}${rewriteSiblingDocumentLinks(unquoted)}`;
    },
  );
}

/**
 * Finds the end of one HTML tag without treating `>` inside an attribute value
 * as the end of the tag.
 *
 * @param {string} line
 * @param {number} tagStart
 */
function findHtmlTagEnd(line, tagStart) {
  let quote = null;
  for (let cursor = tagStart + 1; cursor < line.length; cursor += 1) {
    const character = line[cursor];
    if (quote !== null) {
      if (character === quote) quote = null;
    } else if (character === '"' || character === "'") {
      quote = character;
    } else if (character === '>') {
      return cursor + 1;
    }
  }
  return null;
}

/** @param {string} tag */
function getOpeningRawHtmlElement(tag) {
  const match = /^<(code|pre|script|style|textarea)(?:[ \t]|>|\/)/iu.exec(tag);
  if (match === null || /\/[ \t]*>$/u.test(tag)) return null;
  return /** @type {string} */ (match[1]).toLowerCase();
}

/** @param {string} value */
function escapeRegularExpression(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

const INTERRUPTING_HTML_BLOCK_TAGS =
  'address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|table|tbody|td|tfoot|th|thead|title|tr|track|ul';

/** @param {string} line */
function isInterruptingHtmlBlockStart(line) {
  const candidate = line.trimStart();
  return (
    /^<(?:script|pre|style|textarea)(?:[ \t]|>|$)/iu.test(candidate) ||
    candidate.startsWith('<!--') ||
    candidate.startsWith('<?') ||
    /^<![A-Z]/u.test(candidate) ||
    candidate.startsWith('<![CDATA[') ||
    new RegExp(
      `^</?(?:${INTERRUPTING_HTML_BLOCK_TAGS})(?:[ \\t]|/?>|$)`,
      'iu',
    ).test(candidate)
  );
}

/** @param {string} line */
function isTypeSevenHtmlBlockStart(line) {
  const candidate = line.trimStart();
  const tagEnd = findHtmlTagEnd(candidate, 0);
  if (tagEnd === null || candidate.slice(tagEnd).trim().length > 0)
    return false;
  return /^<\/?[A-Za-z][A-Za-z0-9-]*(?:[ \t]|\/?>)/u.test(
    candidate.slice(0, tagEnd),
  );
}

/**
 * Indented code cannot interrupt a CommonMark paragraph. Track the small set of
 * block prefixes relevant to deciding whether the next indented line belongs
 * to paragraph text or starts a code block.
 *
 * @param {string} line
 * @param {number | null} listItemContentStart
 * @param {boolean} paragraphWasOpen
 */
function canContinueParagraph(line, listItemContentStart, paragraphWasOpen) {
  if (line.trim().length === 0) return false;
  const content =
    listItemContentStart === null
      ? line
      : stripIndentationColumns(line, listItemContentStart);
  const contentIndentation = getLeadingIndentation(content).columns;
  const candidate = content.trimStart();
  if (candidate.length === 0) return false;
  if (
    paragraphWasOpen &&
    contentIndentation <= 3 &&
    /^(?:=+|-+)[ \t]*$/u.test(candidate)
  ) {
    return false;
  }
  if (/^#{1,6}(?:[ \t]+|$)/u.test(candidate)) return false;
  if (candidate.startsWith('>') || candidate.startsWith('<')) return false;
  return !(
    contentIndentation <= 3 &&
    /^(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/u.test(candidate)
  );
}

/**
 * Tracks the indentation that belongs to the current list item. CommonMark
 * measures fence indentation inside the list container, so a marker indented
 * four spaces may be a valid fence after a three-space ordered-list prefix,
 * while the same marker at the document root is an indented code block.
 *
 * @param {string} line
 * @param {{ listContinuationIndent: number | null }} state
 * @returns {number | null}
 */
function updateListContainer(line, state) {
  const listItem = /^([ \t]*)(?:[-+*]|\d{1,9}[.)])([ \t]+)/u.exec(line);
  const listItemIndent =
    listItem === null ? undefined : getColumnWidth(listItem[1]);
  const isDocumentListItem =
    listItemIndent !== undefined && listItemIndent <= 3;
  const isNestedListItem =
    listItemIndent !== undefined &&
    state.listContinuationIndent !== null &&
    listItemIndent >= state.listContinuationIndent &&
    listItemIndent - state.listContinuationIndent <= 3;
  if (listItem !== null && (isDocumentListItem || isNestedListItem)) {
    const contentStart = getColumnWidth(listItem[0]);
    state.listContinuationIndent = contentStart;
    return contentStart;
  }

  if (line.trim().length === 0) return null;
  const leadingIndentation = getLeadingIndentation(line).columns;
  if (
    state.listContinuationIndent !== null &&
    leadingIndentation >= state.listContinuationIndent
  ) {
    return null;
  }
  state.listContinuationIndent = null;
  return null;
}

/**
 * @param {{ character: '`' | '~', length: number } | null} activeFence
 * @param {{ canOpen: boolean, character: '`' | '~', length: number } | null} candidate
 */
function isOpeningFence(activeFence, candidate) {
  return activeFence === null && candidate !== null && candidate.canOpen;
}

/**
 * @param {{ character: '`' | '~', length: number }} activeFence
 * @param {{ canClose: boolean, character: '`' | '~', length: number } | null} candidate
 */
function isClosingFence(activeFence, candidate) {
  return (
    candidate !== null &&
    candidate.character === activeFence.character &&
    candidate.length >= activeFence.length &&
    candidate.canClose
  );
}

/**
 * Parses CommonMark fenced-code markers. Opening fences may carry an info
 * string, while closing fences may only be followed by whitespace. Backtick
 * info strings cannot themselves contain a backtick.
 *
 * @param {string} line
 * @param {number | null} listContinuationIndent
 * @param {number | null} listItemContentStart
 */
function getCodeFence(line, listContinuationIndent, listItemContentStart) {
  const leadingIndentation = getLeadingIndentation(line).columns;
  let candidate = line;
  if (listItemContentStart !== null) {
    candidate = stripIndentationColumns(line, listItemContentStart);
  } else if (
    listContinuationIndent !== null &&
    leadingIndentation >= listContinuationIndent
  ) {
    candidate = stripIndentationColumns(line, listContinuationIndent);
  }

  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(candidate);
  if (match === null) return null;

  const marker = /** @type {string} */ (match[1]);
  const trailing = /** @type {string} */ (match[2]);
  const character = /** @type {'`' | '~'} */ (marker[0]);

  return {
    canClose: trailing.trim().length === 0,
    canOpen: character === '~' || !trailing.includes('`'),
    character,
    length: marker.length,
  };
}

/**
 * Calculates display columns using CommonMark's four-column tab stops.
 *
 * @param {string} value
 */
function getColumnWidth(value) {
  let columns = 0;
  for (const character of value) {
    columns = character === '\t' ? columns + (4 - (columns % 4)) : columns + 1;
  }
  return columns;
}

/** @param {string} line */
function getLeadingIndentation(line) {
  const whitespace = /^[ \t]*/u.exec(line)?.[0] ?? '';
  return { columns: getColumnWidth(whitespace), end: whitespace.length };
}

/**
 * Removes indentation by display column, expanding any remaining part of a tab
 * to spaces so fence parsing sees its CommonMark-relative indentation.
 *
 * @param {string} line
 * @param {number} columnsToStrip
 */
function stripIndentationColumns(line, columnsToStrip) {
  const indentation = getLeadingIndentation(line);
  if (indentation.columns < columnsToStrip) return line;
  return `${' '.repeat(indentation.columns - columnsToStrip)}${line.slice(indentation.end)}`;
}

/** @param {string} line */
// fallow-ignore-next-line complexity -- delimiter matching requires a bounded nested scan and is covered by converter tests
function getInlineCodeSegments(line) {
  /** @type {{ code: boolean, value: string }[]} */
  const segments = [];
  let textStart = 0;
  let cursor = 0;

  while (cursor < line.length) {
    const openingStart = line.indexOf('`', cursor);
    if (openingStart === -1) break;

    let openingEnd = openingStart;
    while (line[openingEnd] === '`') openingEnd += 1;
    const delimiterLength = openingEnd - openingStart;
    let closingStart = openingEnd;
    let matchedClosingDelimiter = false;

    while (closingStart < line.length) {
      closingStart = line.indexOf('`', closingStart);
      if (closingStart === -1) break;

      let closingEnd = closingStart;
      while (line[closingEnd] === '`') closingEnd += 1;
      if (closingEnd - closingStart === delimiterLength) {
        if (textStart < openingStart) {
          segments.push({
            code: false,
            value: line.slice(textStart, openingStart),
          });
        }
        segments.push({
          code: true,
          value: line.slice(openingStart, closingEnd),
        });
        cursor = closingEnd;
        textStart = closingEnd;
        matchedClosingDelimiter = true;
        break;
      }
      closingStart = closingEnd;
    }

    if (!matchedClosingDelimiter) {
      // The opening run is ordinary text when no equal-length closing run
      // exists. Advance past it so an unmatched delimiter at end-of-line (or
      // after a differently sized run) cannot stall the outer scan.
      cursor = openingEnd;
    }
  }

  if (textStart < line.length) {
    segments.push({ code: false, value: line.slice(textStart) });
  }

  return segments;
}

/** @param {{ code: boolean, value: string }[]} segments */
function escapeAnglesOutsideInlineCode(segments) {
  return segments
    .map((segment) =>
      segment.code
        ? segment.value
        : segment.value.replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    )
    .join('');
}
