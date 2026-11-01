import { useAtom, useAtomValue } from '@effect/atom-react'
import { type AskTarget, type ChatTurn, type PrRef, targetKey } from '@pr-review/domain'
import { AsyncResult } from 'effect/reactivity'
import { useAtoms } from '../atoms.ts'

export type Turn = ChatTurn & { readonly streaming?: boolean }

/** A target's saved turns plus the one being answered, and how to ask the next question. */
export function useConversation(prRef: PrRef, headSha: string, target: AskTarget) {
  const { askAtom, chatsAtom } = useAtoms()
  const key = targetKey(target)
  const [answer, ask] = useAtom(askAtom(`${headSha} ${key}`))
  const chats = useAtomValue(chatsAtom(prRef, headSha))
  const saved = (AsyncResult.isSuccess(chats) ? chats.value.find((c) => targetKey(c.target) === key)?.turns : undefined) ?? []
  const live = AsyncResult.isSuccess(answer) ? answer.value : undefined
  const last = saved.at(-1)
  const settled = live?.done && last?.question === live.question && last.answer === live.text
  const turns: ReadonlyArray<Turn> = live && !settled ? [...saved, { question: live.question, answer: live.text, streaming: !live.done }] : saved
  const busy = AsyncResult.isWaiting(answer) || (live !== undefined && !live.done)
  const send = (question: string) => {
    if (!question.trim() || busy) return false
    ask({ ref: prRef, headSha, target, question, followUp: turns.length > 0 })
    return true
  }
  return { turns, busy, failed: AsyncResult.isFailure(answer), send }
}
