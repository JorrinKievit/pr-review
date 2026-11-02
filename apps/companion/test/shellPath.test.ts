import { expect, test } from 'vitest'
import { chmodSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { shellPath } from '../src/shellPath.ts'
import { tmp } from './helpers.ts'

const fakeShell = (body: string) => {
  const path = join(tmp(), 'shell')
  writeFileSync(path, `#!/bin/sh\n${body}\n`)
  chmodSync(path, 0o755)
  return path
}

test("reads the PATH from the user's shell, past whatever its startup files print", async () => {
  // Like `bash -ilc <command>`: the rc files run (and may print), then the command.
  const shell = fakeShell('echo "welcome back"; shift; PATH=/home/u/.nvm/bin:/usr/bin exec /bin/sh -c "$1"')
  expect(await shellPath(shell)).toBe('/home/u/.nvm/bin:/usr/bin')
})

test('a shell that fails leaves the PATH as it was', async () => {
  expect(await shellPath(fakeShell('exit 1'))).toBeUndefined()
  expect(await shellPath('/no/such/shell')).toBeUndefined()
})
