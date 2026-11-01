import { describe, expect, it } from 'vitest'
import { description } from '../src/description.ts'

describe('description', () => {
  it('takes the first paragraph under the headings', () => {
    const body = "## What and why\n\nBackend for the console's Suppliers screen: list, get, create,\nupdate and delete a supplier.\n\nPart of the console Suppliers port."
    expect(description(body)).toBe("Backend for the console's Suppliers screen: list, get, create, update and delete a supplier.")
  })

  it('skips comments, lists, images and tables', () => {
    expect(description('<!-- template -->\n- [ ] tests\n\n![shot](x.png)\n\n| a | b |\n\nAdds the groups section.')).toBe('Adds the groups section.')
  })

  it('shortens a long paragraph at a sentence or word', () => {
    const long = `${'word '.repeat(40)}end.`
    expect(description(long)!.length).toBeLessThanOrEqual(200)
    expect(description(long)).toMatch(/…$/)
  })

  it('returns undefined for an empty body', () => {
    expect(description('')).toBeUndefined()
    expect(description('## Only a heading')).toBeUndefined()
  })
})
