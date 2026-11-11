const SAFE_GIT = /^git (show|grep|log|diff|ls-tree|cat-file)( |$)/
// Anything that lets a shell run a second command, redirect, expand or escape.
const SHELL_META = /[\n\r;&|<>`$\\]/
const BALANCED_QUOTES = /^(?:[^'"]|'[^']*'|"[^"]*")*$/
// Git accepts any unambiguous prefix of a long option, so `--outp` means `--output`.
const UNSAFE_LONG = ['output', 'open-files-in-pager', 'no-index', 'ext-diff', 'textconv']

const unsafeArg = (arg: string) => {
  if (arg.startsWith('--')) {
    const name = arg.slice(2).split('=')[0]!
    return name !== '' && UNSAFE_LONG.some((o) => o.startsWith(name))
  }
  return arg.startsWith('-') && arg.includes('O') // grep -O runs a pager command; bundles like -nO too
}

/** The agent reads the repo through read-only git and nothing else; PR content is untrusted. */
export const safeGitCommand = (raw: string) => {
  const command = raw.trim()
  return (
    SAFE_GIT.test(command) &&
    !SHELL_META.test(command) &&
    BALANCED_QUOTES.test(command) &&
    !(command.match(/(?:[^\s'"]|'[^']*'|"[^"]*")+/g) ?? []).some((token) => unsafeArg(token.replace(/['"]/g, '')))
  )
}

const NAME = '[\\w.-]+'
const REF = '[\\w.\\/-]+'
const GH_PATHS = [
  new RegExp(`^repos/(${NAME}/${NAME})/contents/${REF}(?:\\?ref=${REF})?$`),
  new RegExp(`^repos/(${NAME}/${NAME})/git/trees/${REF}(?:\\?recursive=1)?$`),
  new RegExp(`^search/code\\?q=[\\w.%+-]+?\\+repo:(${NAME}/${NAME})$`),
]
const RAW = 'Accept: application/vnd.github.raw'

/** Read-only `gh api` GETs of files, trees and code search in the related repos (`host/owner/repo`) and nowhere else. */
export const safeGhCommand = (raw: string, related: ReadonlyArray<string>) => {
  const command = raw.trim()
  if (SHELL_META.test(command) || !BALANCED_QUOTES.test(command)) return false
  const tokens = (command.match(/(?:[^\s'"]|'[^']*'|"[^"]*")+/g) ?? []).map((t) => t.replace(/['"]/g, ''))
  if (tokens[0] !== 'gh' || tokens[1] !== 'api') return false
  let host = 'github.com'
  let path: string | undefined
  for (let i = 2; i < tokens.length; i++) {
    const t = tokens[i]!
    if (t === '--hostname' && i + 1 < tokens.length) host = tokens[++i]!
    else if (t === '-H' && tokens[i + 1] === RAW) i++
    else if (t.startsWith('-') || path !== undefined) return false
    else path = t
  }
  if (path === undefined || path.split(/[/?]/).includes('..')) return false
  const repo = GH_PATHS.map((r) => r.exec(path!)?.[1]).find(Boolean)
  return repo !== undefined && related.some((r) => r.toLowerCase() === `${host}/${repo}`.toLowerCase())
}

export const gitOnlyMessage =
  'Only read-only git commands (show, grep, log, diff, ls-tree, cat-file) without shell syntax, --output, --no-index or -O are allowed. Do not cd; you are already in the repo.'
