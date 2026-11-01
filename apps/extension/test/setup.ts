import '@testing-library/jest-dom/vitest'

import { remembered } from './companion.ts'

afterEach(() => remembered.clear())
