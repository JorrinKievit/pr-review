import { reviewUrlFor } from '../src/redirect.ts'

const ext = 'chrome-extension://abc/'

test('files URL maps to review page', () => {
  expect(reviewUrlFor('https://github.com/acme/core/pull/2926/files', ext)).toBe('chrome-extension://abc/review.html#/open/github.com/acme/core/2926')
})

test('changes URL with a fragment maps too', () => {
  expect(reviewUrlFor('https://github.com/acme/core/pull/2926/changes#diff-abc', ext)).toBe('chrome-extension://abc/review.html#/open/github.com/acme/core/2926')
})

test('native=1 is left alone', () => {
  expect(reviewUrlFor('https://github.com/acme/core/pull/2926/files?native=1', ext)).toBeNull()
})

test('conversation and commits tabs are left alone', () => {
  expect(reviewUrlFor('https://github.com/acme/core/pull/2926', ext)).toBeNull()
  expect(reviewUrlFor('https://github.com/acme/core/pull/2926/commits', ext)).toBeNull()
})
