import type { CompanionUnavailable } from '@pr-review/domain'
import { Cause, Result } from 'effect'
import { AsyncResult } from 'effect/reactivity'

/** The typed error in a cause, if it failed with one. */
export function errorOf<E>(cause: Cause.Cause<E>): E | undefined {
  const found = Cause.findError(cause)
  return Result.isSuccess(found) ? found.success : undefined
}

export const failureOf = <E>(r: AsyncResult.AsyncResult<unknown, E>): E | undefined => (AsyncResult.isFailure(r) ? errorOf(r.cause) : undefined)

export const isUnavailable = (e: unknown): e is { _tag: 'CompanionUnavailable'; reason: CompanionUnavailable['reason'] } =>
  typeof e === 'object' && e !== null && (e as { _tag?: unknown })._tag === 'CompanionUnavailable'
