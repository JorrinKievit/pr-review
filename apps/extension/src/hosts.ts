const ID = 'pr-pages'

/**
 * github.com is in the manifest; other hosts get the content script once the browser granted them.
 * Called at startup and whenever the settings change.
 */
export async function registerHosts(hosts: ReadonlyArray<string>) {
  const granted: string[] = []
  for (const h of hosts) if (h !== 'github.com' && (await chrome.permissions.contains({ origins: [`https://${h}/*`] }))) granted.push(h)
  const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [ID] })
  if (registered.length) await chrome.scripting.unregisterContentScripts({ ids: [ID] })
  if (granted.length)
    await chrome.scripting.registerContentScripts([
      { id: ID, matches: granted.map((h) => `https://${h}/*/*/pull/*`), js: ['content-scripts/content.js'], runAt: 'document_start', persistAcrossSessions: false },
    ])
}
