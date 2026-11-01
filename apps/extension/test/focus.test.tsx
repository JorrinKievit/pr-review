import { render, waitFor } from '@testing-library/react'
import { useRef } from 'react'
import { useFocusOnMount } from '../src/ui/focus.ts'

function Box() {
  const ref = useRef<HTMLTextAreaElement>(null)
  useFocusOnMount(ref)
  return <textarea ref={ref} aria-label="box" />
}

test('focuses an input that is attached to the page after it mounts, like a diff annotation', async () => {
  const detached = document.createElement('div')
  const { getByLabelText } = render(<Box />, { container: detached })
  setTimeout(() => document.body.append(detached), 0)
  await waitFor(() => expect(document.activeElement).toBe(getByLabelText('box')))
})
