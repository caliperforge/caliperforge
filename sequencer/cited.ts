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

const RULED = /^## (?:Ruling|Answer from the director)/

const VALUED = new Set(['--features', '-F', '-p', '-D'])

/** The cargo test then clippy commands the last step-3 ruling of issue.md names outside its `verify:` line, as the words after `cargo`. */
export function stepRuled(issue: string): string[][] | undefined {
  const section = issue.split(/^(?=## )/m).findLast((s) => RULED.test(s) && /^applies to:.*\bstep 3\b/m.test(s)) ?? ''
  const found = section.split('\n').filter((l) => !l.startsWith('verify:'))
    .flatMap((l) => [...l.matchAll(/\bcargo[ \t]+(test|clippy)\b/g)].map((m) => command(m[1] ?? '', l.slice(m.index + m[0].length))))
    .filter((c) => c !== undefined)
  const tests = found.filter((c) => c[0] === 'test')
  const lints = found.filter((c) => c[0] === 'clippy').flatMap((c) => (c.includes('...') ? tests.map((t) => c.flatMap((a) => (a === '...' ? flags(t, c) : [a]))) : [c]))
  const all = [...tests, ...lints]
  return all.length === 0 ? undefined : all
}

/** `sub` and the flags, flag values and `...` after it in `rest`; none when it names no flag or needs a shell. */
function command(sub: string, rest: string): string[] | undefined {
  const args = [sub]
  let stop = ''
  for (const word of rest.trim().split(/[ \t]+/)) {
    const cut = word.split(/[;`]/)[0] ?? ''
    const token = cut === '...' ? cut : cut.replace(/[,.]$/, '')
    if (token === '' || !(token === '...' || token.startsWith('-') || VALUED.has(args.at(-1) ?? ''))) { stop = token; break }
    args.push(token)
    if (token !== word) break
  }
  return args.some((a) => a.startsWith('-')) && !SHELL.test([...args, stop].join(' ')) ? args : undefined
}

/** The test's flags with their values, less those `lint` already names. */
function flags(test: string[], lint: string[]): string[] {
  return test.slice(1).filter((a, at, all) => !lint.includes(VALUED.has(all[at - 1] ?? '') ? all[at - 1] ?? '' : a))
}

/** The plan's ruled commands, from its step-3 ruling, else its ask, brief and rulings' `verify:` line, as `Outside.tests`. */
export function ruled(root: string, plan: number): { tests?: string[][] } {
  const issue = get(root, plan, 'issue.md')
  const test = ruledTest([maybe(root, plan, 'ask.md') ?? '', issue, maybe(root, plan, 'rulings.md') ?? ''].join('\n'))
  const tests = stepRuled(issue) ?? (test === undefined ? undefined : [test])
  return tests === undefined ? {} : { tests }
}
