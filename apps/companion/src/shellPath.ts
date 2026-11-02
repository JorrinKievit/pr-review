import { execFile } from 'node:child_process'
import { userInfo } from 'node:os'
import { promisify } from 'node:util'

const MARK = '__pr_review_env__'

/**
 * The PATH the user's terminal has. Browsers start the host with a bare one, where `npx` or `claude` is missing
 * or, under WSL, Windows' own. Asks the login shell for its environment, the way VS Code does.
 */
export async function shellPath(shell = process.env.SHELL || userInfo().shell || '/bin/sh'): Promise<string | undefined> {
  try {
    // `env` prints PATH colon-joined in every shell, fish included; the marks skip what the rc files print.
    const { stdout } = await promisify(execFile)(shell, ['-ilc', `echo ${MARK}; command env; echo ${MARK}`], { encoding: 'utf8', timeout: 15_000 })
    const env = stdout.split(MARK)[1] ?? ''
    return env.split('\n').find((l) => l.startsWith('PATH='))?.slice(5) || undefined
  } catch {
    return undefined
  }
}

let resolved: Promise<string | undefined> | undefined
/** shellPath, asked once per host: an interactive shell can take seconds to start. */
export const loginPath = () => (resolved ??= shellPath())
