import { type RefObject, useEffect } from 'react'

/**
 * Focuses the element once it is in the page. `autoFocus` fires at mount, but the diff mounts its line
 * annotations before attaching them, so there it would focus nothing.
 */
export function useFocusOnMount(ref: RefObject<HTMLElement | null>, enabled = true) {
  useEffect(() => {
    if (!enabled) return
    let frame = 0
    const attempt = (tries: number) => {
      const el = ref.current
      if (el?.isConnected) return el.focus()
      if (tries > 0) frame = requestAnimationFrame(() => attempt(tries - 1))
    }
    attempt(30)
    return () => cancelAnimationFrame(frame)
  }, [ref, enabled])
}
