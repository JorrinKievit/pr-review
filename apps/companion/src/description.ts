const MAX = 200

/** The opening paragraph of a PR body: the author's own one-line account of what the PR does. */
export function description(body: string): string | undefined {
  const paragraph = body
    .replace(/<!--[\s\S]*?-->/g, '')
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .find((block) => block && !/^(#|[-*+] |\d+\. |!\[|\||>|```)/.test(block))
    ?.replace(/^#.*\n/, '')
    .replace(/\s+/g, ' ')
  if (!paragraph) return undefined
  if (paragraph.length <= MAX) return paragraph
  const cut = paragraph.slice(0, MAX - 1)
  const sentence = cut.lastIndexOf('. ')
  return sentence > MAX / 2 ? cut.slice(0, sentence + 1) : `${cut.slice(0, cut.lastIndexOf(' '))}…`
}
