import tailwindcss from '@tailwindcss/vite'
import { EXTENSION_KEY, GECKO_ID } from '@pr-review/domain'
import { defineConfig } from 'wxt'

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  // Under WSL the browser is on Windows: point WXT_OUT_DIR at a Windows folder and load the add-on from there.
  outDir: process.env.WXT_OUT_DIR ?? '.output',
  webExt: { disabled: true },
  vite: () => ({ plugins: [tailwindcss()] }),
  // The key pins Chrome's id and the gecko id pins Firefox's; the host manifests allow only those.
  manifest: ({ browser }) => ({
    name: 'PR Review',
    version: '0.1.0',
    description: 'Decision-first pull request review.',
    ...(browser === 'firefox' ? { browser_specific_settings: { gecko: { id: GECKO_ID, strict_min_version: '115.0', data_collection_permissions: { required: ['none'] } } } } : { key: EXTENSION_KEY }),
    permissions: ['storage', 'nativeMessaging', 'scripting'],
    host_permissions: ['https://github.com/*'],
    // GitHub Enterprise hosts from the settings are asked for at runtime. Firefox builds MV2, which has no optional_host_permissions.
    ...(browser === 'firefox' ? { optional_permissions: ['https://*/*'] } : { optional_host_permissions: ['https://*/*'] }),
    web_accessible_resources: [{ resources: ['review.html'], matches: ['https://*/*'] }],
  }),
})
