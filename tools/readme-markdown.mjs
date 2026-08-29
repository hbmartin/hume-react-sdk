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
  };
  return rewriteSiblingDocumentLinks(readme)
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map((line) => transformReadmeLine(line, state))
    .join('\n');
}

/**
 * @param {string} line
 * @param {{ codeFence: { character: '`' | '~', length: number } | null }} state
 */
// fallow-ignore-next-line complexity -- explicit branches model CommonMark fence state and escaping
function transformReadmeLine(line, state) {
  const fence = getCodeFence(line);
  if (isOpeningFence(state.codeFence, fence)) {
    state.codeFence = {
      character: fence.character,
      length: fence.length,
    };
    return line;
  }
  if (state.codeFence !== null) {
    if (isClosingFence(state.codeFence, fence)) state.codeFence = null;
    return line;
  }
  if (line.trimStart().startsWith('<')) return line;
  const inlineCodeSegments = getInlineCodeSegments(line);
  if (
    !inlineCodeSegments.some(
      (segment) => !segment.code && /[A-Za-z0-9_.)\]]</u.test(segment.value),
    )
  ) {
    return line;
  }
  return escapeAnglesOutsideInlineCode(inlineCodeSegments);
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
 */
function getCodeFence(line) {
  // Accept arbitrary indentation because this line-oriented sanitizer does not
  // parse the surrounding list container that makes a four-space-indented
  // fence valid CommonMark.
  const match = /^[\t ]*(`{3,}|~{3,})(.*)$/u.exec(line);
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
