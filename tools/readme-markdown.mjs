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
  };
  return readme
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map((line) => transformReadmeLine(line, state))
    .join('\n');
}

/**
 * @param {string} line
 * @param {{ codeFence: { character: '`' | '~', length: number } | null, indentedCodeIndent: number | null, listContinuationIndent: number | null, paragraphOpen: boolean }} state
 */
// fallow-ignore-next-line complexity -- explicit branches model CommonMark fence state and escaping
function transformReadmeLine(line, state) {
  if (state.indentedCodeIndent !== null) {
    if (line.trim().length === 0) {
      state.paragraphOpen = false;
      return line;
    }
    if (getLeadingIndentation(line).columns >= state.indentedCodeIndent) {
      state.paragraphOpen = false;
      return line;
    }
    state.indentedCodeIndent = null;
  }

  const listItemContentStart =
    state.codeFence === null ? updateListContainer(line, state) : null;
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
    state.paragraphOpen = false;
    return line;
  }
  if (line.trimStart().startsWith('<')) {
    state.paragraphOpen = false;
    return rewriteSiblingDocumentLinksInRawHtml(line);
  }
  const inlineCodeSegments = getInlineCodeSegments(line);
  const rewrittenSegments = inlineCodeSegments.map((segment) =>
    segment.code
      ? segment
      : { ...segment, value: rewriteSiblingDocumentLinks(segment.value) },
  );
  state.paragraphOpen = canContinueParagraph(line, listItemContentStart);
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
 */
function rewriteSiblingDocumentLinksInRawHtml(line) {
  return line.replace(
    /(\bhref[ \t]*=[ \t]*)(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/giu,
    (_attribute, prefix, doubleQuoted, singleQuoted, unquoted) => {
      if (doubleQuoted !== undefined) {
        return `${prefix}"${rewriteSiblingDocumentLinks(doubleQuoted)}"`;
      }
      if (singleQuoted !== undefined) {
        return `${prefix}'${rewriteSiblingDocumentLinks(singleQuoted)}'`;
      }
      return `${prefix}${rewriteSiblingDocumentLinks(unquoted)}`;
    },
  );
}

/**
 * Indented code cannot interrupt a CommonMark paragraph. Track the small set of
 * block prefixes relevant to deciding whether the next indented line belongs
 * to paragraph text or starts a code block.
 *
 * @param {string} line
 * @param {number | null} listItemContentStart
 */
function canContinueParagraph(line, listItemContentStart) {
  if (line.trim().length === 0) return false;
  const candidate =
    listItemContentStart === null
      ? line.trimStart()
      : stripIndentationColumns(line, listItemContentStart).trimStart();
  if (candidate.length === 0) return false;
  if (/^#{1,6}(?:[ \t]+|$)/u.test(candidate)) return false;
  if (candidate.startsWith('>') || candidate.startsWith('<')) return false;
  return !/^(?:(?:\*[ \t]*){3,}|(?:_[ \t]*){3,}|(?:-[ \t]*){3,})$/u.test(
    candidate,
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
