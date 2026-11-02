import '@testing-library/jest-dom/vitest'

import { remembered } from './companion.ts'

// jsdom has no layout, so no scrolling.
if (typeof Element !== 'undefined') Element.prototype.scrollIntoView = () => {}

afterEach(() => remembered.clear())
