import { HOST_NAME, type PrRef } from '@pr-review/domain'
import { Effect, Layer } from 'effect'
import { prepareDebounce } from '../src/prepare.ts'
import { registerHosts } from '../src/hosts.ts'
import { relay } from '../src/relay.ts'
import { storedSettings } from '../src/settings/store.ts'

export default defineBackground(() => {
  const native = () => {
    let lastError: string | undefined
    const port = chrome.runtime.connectNative(HOST_NAME)
    // Chrome reports why in runtime.lastError, Firefox in port.error.
    port.onDisconnect.addListener((p) => (lastError = chrome.runtime.lastError?.message ?? (p as { error?: { message?: string } }).error?.message))
    return { port, lastError: () => lastError }
  }
  const allow = prepareDebounce()
  const prepares = {
    addListener: (f: (ref: PrRef) => void) =>
      chrome.runtime.onMessage.addListener((msg: { prepare?: PrRef }) => {
        if (msg.prepare && allow(msg.prepare)) f(msg.prepare)
      }),
  }
  Effect.runFork(Layer.launch(relay(native, chrome.runtime.onConnect, storedSettings, chrome.runtime.getManifest().version, prepares)))

  const syncHosts = () => void Effect.runPromise(storedSettings).then((s) => registerHosts(s?.hosts ?? []))
  syncHosts()
  chrome.storage.onChanged.addListener((changes) => 'settings' in changes && syncHosts())

  // The content script asks; the tab is navigated from here because Firefox can block a page navigating itself to an extension URL.
  const reviewPage = chrome.runtime.getURL('/review.html')
  chrome.runtime.onMessage.addListener((msg: { open?: unknown }, sender) => {
    if (typeof msg.open === 'string' && msg.open.startsWith(reviewPage) && sender.tab?.id !== undefined) void chrome.tabs.update(sender.tab.id, { url: msg.open })
  })
})
