import { Schema } from 'effect'

export const AgentRule = Schema.Struct({
  path: Schema.String.annotate({ description: 'The guidance file the rule belongs in, exactly as listed.' }),
  rule: Schema.String.annotate({ description: 'The rule, one to three lines, in the file\'s style.' }),
})
export type AgentRule = typeof AgentRule.Type

/** A `git apply`-able diff that appends `added` to the end of `path`; `old === null` creates the file. */
export const appendPatch = (path: string, old: string | null, added: string): string => {
  const add = added.replace(/\s+$/, '').split('\n')
  if (old === null || old === '') {
    const head = old === null ? [`diff --git a/${path} b/${path}`, 'new file mode 100644', '--- /dev/null'] : [`diff --git a/${path} b/${path}`, `--- a/${path}`]
    return [...head, `+++ b/${path}`, `@@ -0,0 +1,${add.length} @@`, ...add.map((l) => `+${l}`), ''].join('\n')
  }
  const lines = old.replace(/\n$/, '').split('\n')
  const noNewline = !old.endsWith('\n')
  const last = lines.at(-1)!
  const spacer = last.trim() === '' ? [] : ['']
  const ctx = lines.slice(-3, noNewline ? -1 : undefined)
  const oldCount = ctx.length + (noNewline ? 1 : 0)
  const body = [
    ...ctx.map((l) => ` ${l}`),
    ...(noNewline ? [`-${last}`, '\\ No newline at end of file', `+${last}`] : []),
    ...[...spacer, ...add].map((l) => `+${l}`),
  ]
  const newCount = ctx.length + (noNewline ? 1 : 0) + spacer.length + add.length
  const start = lines.length - oldCount + 1
  return [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -${start},${oldCount} +${start},${newCount} @@`, ...body, ''].join('\n')
}

/** The path is a guidance entry or sits under a guidance folder. */
export const inGuidance = (path: string, guidance: ReadonlyArray<string>): boolean =>
  guidance.some((g) => {
    const dir = g.replace(/\/+$/, '')
    return path === dir || path.startsWith(`${dir}/`)
  })

export const ruleBranch = (rule: string): string => `rules/${rule.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+/, '').slice(0, 40).replace(/-+$/, '')}`

export const ruleTitle = (rule: string): string => {
  const first = rule.trim().replace(/^[-*]\s+/, '').split(/(?<=[.!?])\s/)[0]!.replace(/\s+/g, ' ')
  return `Review rule: ${first.slice(0, 60)}`
}
