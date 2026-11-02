import { SHELL } from './gates.ts'
import { get, maybe } from './workspace.ts'

const SKIP = /stays|must not|no builder touches|not this job's|do not/i

/** The paths the newest ruling block of `rulings.md` names, leaving out its lines that say not to touch them. */
export function cited(rulings: string): string[] {
  return [...newest(rulings).split('\n').filter((l) => !SKIP.test(l)).join('\n').matchAll(/`([^`\s]+)`/g)]
    .map((m) => (m[1] ?? '').replace(/:\d+(?:-\d+)?$/, '')).filter((t) => (t.includes('/') || /\.\w+$/.test(t)) && !/[<>]/.test(t))
}

/** The newest ruling block of `rulings.md`: from its last `**Ruling` or `## ` line, else the whole file. */
export function newest(rulings: string): string {
  const lines = rulings.split('\n')
  return lines.slice(Math.max(0, lines.findLastIndex((l) => l.startsWith('**Ruling') || l.startsWith('## ')))).join('\n')
}

/** The words after `cargo` on the last `verify:` line naming `cargo test`, unless it needs a shell. */
export function ruledTest(text: string): string[] | undefined {
  const command = [...text.matchAll(/^verify:[ \t]*`?cargo[ \t]+(test\b.*)$/gm)].at(-1)?.[1]?.replace(/`[ \t]*$/, '').trim()
  return command === undefined || SHELL.test(command) ? undefined : command.split(/\s+/)
}

/** The plan's ruled test from its ask, brief and rulings, as `Outside.test`. */
export function ruled(root: string, plan: number): { test?: string[] } {
  const test = ruledTest([maybe(root, plan, 'ask.md') ?? '', get(root, plan, 'issue.md'), maybe(root, plan, 'rulings.md') ?? ''].join('\n'))
  return test === undefined ? {} : { test }
}
