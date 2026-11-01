import { ext } from './settings/store.ts'

const ID = 'pr-pages'

/**
 * github.com is in the manifest; other hosts get the content script once the browser granted them.
 * Called at startup and whenever the settings change.
 */
export async function registerHosts(hosts: ReadonlyArray<string>) {
  const granted: string[] = []
  for (const h of hosts) if (h !== 'github.com' && (await ext().permissions.contains({ origins: [`https://${h}/*`] }))) granted.push(h)
  const registered = await ext().scripting.getRegisteredContentScripts({ ids: [ID] })
  if (registered.length) await ext().scripting.unregisterContentScripts({ ids: [ID] })
  if (granted.length)
    await ext().scripting.registerContentScripts([
      { id: ID, matches: granted.map((h) => `https://${h}/*/*/pull/*`), js: ['content-scripts/content.js'], runAt: 'document_start', persistAcrossSessions: false },
    ])
}
