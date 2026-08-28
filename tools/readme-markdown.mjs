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
        /[A-Za-z0-9_.)\]]</u.test(line)
      ) {
        return line.replaceAll('<', '&lt;').replaceAll('>', '&gt;');
      }

      return line;
    })
    .join('\n');
}
