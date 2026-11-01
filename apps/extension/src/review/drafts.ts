import { useAtomSet, useAtomValue } from '@effect/atom-react'
import type { Draft, PrRef } from '@pr-review/domain'
import { AsyncResult } from 'effect/reactivity'
import { useAtoms } from '../atoms.ts'

/** The PR's pending review comments and the edits on them; each edit saves the whole list in the companion. */
export function useDrafts(prRef: PrRef) {
  const { draftsAtom, saveDraftsAtom } = useAtoms()
  const value = useAtomValue(draftsAtom(prRef))
  const save = useAtomSet(saveDraftsAtom)
  const drafts: ReadonlyArray<Draft> = AsyncResult.isSuccess(value) ? value.value : []
  const put = (next: ReadonlyArray<Draft>) => save({ ref: prRef, drafts: next })
  return {
    drafts,
    add: (d: Omit<Draft, 'id'>) => put([...drafts, { ...d, id: crypto.randomUUID() }]),
    edit: (id: string, body: string) => put(drafts.map((d) => (d.id === id ? { ...d, body } : d))),
    remove: (id: string) => put(drafts.filter((d) => d.id !== id)),
  }
}
