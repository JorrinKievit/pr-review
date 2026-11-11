import { prepareOncePerLoad } from '../src/prepare.ts'
import { reviewUrlFor } from '../src/redirect.ts'

export default defineContentScript({
  // Other hosts from the settings are registered at runtime (src/hosts.ts).
  matches: ['https://github.com/*/*/pull/*'],
  runAt: 'document_start',
  main() {
    let seen = ''
    const nextPrepare = prepareOncePerLoad()
    const go = () => {
      if (location.href === seen) return
      seen = location.href
      const target = reviewUrlFor(location.href, browser.runtime.getURL('/'))
      if (target) return void browser.runtime.sendMessage({ open: target })
      const ref = nextPrepare(location.href)
      if (ref) void browser.runtime.sendMessage({ prepare: ref })
    }
    go()
    // GitHub switches PR tabs client-side and its events vary by version, so watch the URL instead.
    // ponytail: 300 ms poll; the Navigation API replaces it once Firefox ships it everywhere
    setInterval(go, 300)
  },
})
