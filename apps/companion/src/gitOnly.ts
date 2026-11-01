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

export const gitOnlyMessage =
  'Only read-only git commands (show, grep, log, diff, ls-tree, cat-file) without shell syntax, --output, --no-index or -O are allowed. Do not cd; you are already in the repo.'
