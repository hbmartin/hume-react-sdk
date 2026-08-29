/**
 * Escapes type-like angle brackets that Vue could interpret as template tags
 * while preserving fenced examples and deliberate raw-HTML blocks.
 *
 * @param {string} readme
 */
export function makeReadmeVitePressSafe(readme) {
  let insideCodeFence = false;
  return readme
    .replaceAll('\r\n', '\n')
    .split('\n')
    .map((line) => {
      if (/^\s*`{3,}/u.test(line)) {
        insideCodeFence = !insideCodeFence;
        return line;
      }

      const isRawHtmlLine = line.trimStart().startsWith('<');
      if (
        !insideCodeFence &&
        !isRawHtmlLine &&
        /[A-Za-z0-9_.)\]]</u.test(removeInlineCode(line))
      ) {
        return escapeAnglesOutsideInlineCode(line);
      }

      return line;
    })
    .join('\n');
}

/** @param {string} line */
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
