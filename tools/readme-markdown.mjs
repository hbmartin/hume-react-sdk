/**
 * Escapes type-like angle brackets that Vue could interpret as template tags
 * while preserving fenced examples and deliberate raw-HTML blocks.
 *
 * @param {string} readme
 */
export function makeReadmeVitePressSafe(readme) {
  const state = {
    /** @type {{ character: '`' | '~', length: number } | null} */
    codeFence: null,
  };
  return readme
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
  if (!/[A-Za-z0-9_.)\]]</u.test(removeInlineCode(line))) return line;
  return escapeAnglesOutsideInlineCode(line);
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
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
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
        break;
      }
      closingStart = closingEnd;
    }

    if (closingStart === -1) break;
  }

  if (textStart < line.length) {
    segments.push({ code: false, value: line.slice(textStart) });
  }

  return segments;
}

/** @param {string} line */
function removeInlineCode(line) {
  return getInlineCodeSegments(line)
    .filter((segment) => !segment.code)
    .map((segment) => segment.value)
    .join('');
}

/** @param {string} line */
function escapeAnglesOutsideInlineCode(line) {
  return getInlineCodeSegments(line)
    .map((segment) =>
      segment.code
        ? segment.value
        : segment.value.replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
    )
    .join('');
}
