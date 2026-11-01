import { reviewUrlFor } from '../src/redirect.ts'

export default defineContentScript({
  // Other hosts from the settings are registered at runtime (src/hosts.ts).
  matches: ['https://github.com/*/*/pull/*'],
  runAt: 'document_start',
  main() {
    let seen = ''
    const go = () => {
      if (location.href === seen) return
      seen = location.href
      const target = reviewUrlFor(location.href, browser.runtime.getURL('/'))
      if (target) void browser.runtime.sendMessage({ open: target })
    }
    go()
    // GitHub switches PR tabs client-side and its events vary by version, so watch the URL instead.
    // ponytail: 300 ms poll; the Navigation API replaces it once Firefox ships it everywhere
    setInterval(go, 300)
  },
})
