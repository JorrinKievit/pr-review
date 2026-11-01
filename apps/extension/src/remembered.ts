import { useAtomSet, useAtomValue } from '@effect/atom-react'
import { AsyncResult } from 'effect/reactivity'
import { useState } from 'react'
import { useAtoms } from './atoms.ts'

/**
 * useState that survives leaving the page: where a review left off, text not sent yet. Kept by the companion,
 * since a temporary Firefox add-on loses its own storage on restart. Shows `initial` until the saved value arrives.
 */
export function useRemembered<T>(key: string, initial: T): [T, (next: T) => void] {
  const { recallAtom, rememberAtom } = useAtoms()
  const saved = useAtomValue(recallAtom(key))
  const save = useAtomSet(rememberAtom)
  const [local, setLocal] = useState<{ value: T }>()
  const value = local ? local.value : AsyncResult.isSuccess(saved) && saved.value !== null ? (JSON.parse(saved.value) as T) : initial
  const set = (next: T) => {
    setLocal({ value: next })
    save({ key, value: JSON.stringify(next) })
  }
  return [value, set]
}
