import { installLine } from '../src/Setup.tsx'

test('Chromium store builds pass their own id; Firefox and the unpacked build are allowed already', () => {
  expect(installLine('0.3.0')).toBe('curl -fsSL https://github.com/JorrinKievit/pr-review/releases/download/v0.3.0/install.sh | sh')
  expect(installLine('0.3.0', 'abcdefghijklmnopabcdefghijklmnop')).toBe(
    'curl -fsSL https://github.com/JorrinKievit/pr-review/releases/download/v0.3.0/install.sh | sh -s -- --extension-id abcdefghijklmnopabcdefghijklmnop',
  )
})
