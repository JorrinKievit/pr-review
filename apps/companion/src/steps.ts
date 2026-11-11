import { Effect, PubSub, Stream } from 'effect'

const basename = (path: string) => path.split('/').filter(Boolean).at(-1) ?? path
const unquote = (s: string) => s.replace(/^(['"])(.*)\1$/, '$2')
// Arguments with quoted strings kept whole; options dropped.
const args = (command: string) => (command.match(/'[^']*'|"[^"]*"|\S+/g) ?? []).slice(2).filter((a) => !a.startsWith('-')).map(unquote)
// Basic-regex alternation (`a\|b`) reads as a list of searches.
const searching = (pattern: string) => `Searching for ${pattern.split('\\|').map((p) => `"${p}"`).join(' or ')}`
const afterDashes = (command: string) => command.split(/\s--\s/)[1]?.trim().split(/\s+/)[0]

/** A short line for the loading indicator: what Claude is looking at right now. */
export function describeTool(name: string, input: Record<string, unknown>): string {
  const str = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '')
  if (name === 'Read') return `Reading ${basename(str('file_path'))}`
  if (name === 'Grep') return searching(str('pattern'))
  if (name === 'StructuredOutput') return 'Writing up the decisions'
  if (name === 'Glob') return `Listing ${str('pattern')}`
  if (name !== 'Bash') return `Using ${name}`
  const command = str('command')
  const sub = command.split(/\s+/)[1]
  const path = afterDashes(command)
  const [first] = args(command)
  switch (sub) {
    case 'show':
      return first?.includes(':') ? `Reading ${basename(first.split(':').slice(1).join(':'))}` : `Reading commit ${first ?? ''}`.trim()
    case 'grep':
      return searching(first ?? '')
    case 'log':
      return path ? `Reading the history of ${basename(path)}` : 'Reading the history'
    case 'diff':
      return path ? `Comparing ${basename(path)}` : 'Comparing changes'
    case 'ls-tree':
      return `Listing ${args(command).at(-1) ?? 'files'}`
    default:
      return `Running git ${sub ?? ''}`.trim()
  }
}

/** Steps of runs by key: `report(key)` publishes a run's steps; `follow(key)` streams its current step, then each new one, and never ends. */
export const makeSteps = Effect.gen(function* () {
  const published = yield* PubSub.unbounded<{ key: string; step: string }>()
  const latest = new Map<string, string>()
  return {
    report: (key: string) => (step: string) => Effect.andThen(Effect.sync(() => void latest.set(key, step)), PubSub.publish(published, { key, step })),
    follow: (key: string) =>
      Stream.unwrap(
        Effect.gen(function* () {
          // Subscribe before reading the current step, so no step falls between the two.
          const sub = yield* PubSub.subscribe(published)
          const current = latest.get(key)
          return Stream.concat(
            Stream.fromIterable(current ? [current] : []),
            Stream.fromSubscription(sub).pipe(Stream.filter((e) => e.key === key), Stream.map((e) => e.step)),
          )
        }),
      ),
  }
})
