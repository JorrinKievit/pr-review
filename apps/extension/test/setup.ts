import '@testing-library/jest-dom/vitest'

import { fakeBrowser } from 'wxt/testing/fake-browser'
import { remembered } from './companion.ts'

// WXT's fake browser leaves getManifest out.
fakeBrowser.runtime.getManifest = () => ({ manifest_version: 3, name: 'PR Review', version: '0.3.0' })

// jsdom has no layout, so no scrolling.
if (typeof Element !== 'undefined') Element.prototype.scrollIntoView = () => {}

afterEach(() => remembered.clear())
