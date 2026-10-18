import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { admitted } from '../providers/kind.ts'
import { seat } from '../runner/rules.ts'
import { builder, ROOT } from '../templates/pr-path.ts'
import { files, section, type Refused } from './brief.ts'
import { npm, type Ran } from './checks.ts'
import { languageOfSpan, OUTSIDE } from './route.ts'
import { git } from './workspace.ts'

const COMMAND = /^\s*-\s*command:\s*`([^`]+)`\s*$/

const EXPECT = /^\s*-\s*expect:\s*(fails|shows)\s*$/

const TAIL = 20

const RAN = /^(?:- base: |- exit: |> )/

/** An outside brief's `## Reproduced`: one command a builder of its files' language may run, and whether it `fails` or `shows`. */
export function reproduced(said: string, paths: string[]): Refused | null {
  const lines = said.split('\n')
  const [command, ...more] = lines.flatMap((l) => COMMAND.exec(l)?.[1]?.trim() ?? [])
  if (command === undefined || more.length > 0) return { span: '## Reproduced', reason: '## Reproduced holds no single `- command: `<command>`` row' }
  if (lines.filter((l) => EXPECT.test(l)).length !== 1) return { span: '## Reproduced', reason: '## Reproduced holds no single `- expect: fails` or `- expect: shows` row' }
  const found = [...new Set(paths.flatMap((p) => languageOfSpan(p) ?? []))]
  const seats = [...new Set((found.length === 0 ? [OUTSIDE] : found).flatMap((l) => builder(l) ?? []))]
  if (seats.some((name) => admitted(seat(ROOT, name).manifest.tools, command))) return null
  return { span: command, reason: `${command} is on the Bash(...) list of none of ${seats.join(', ')}` }
}

/** The brief with what its command did at `base` under its `- expect:` row, and `fixed` where a `fails` exited 0; null where {@link reproduced} refuses. */
export function rerun(brief: string, src: string, base: string): { brief: string; fixed: string | null } | null {
  const said = section(brief, '## Reproduced')
  const [command] = said.split('\n').flatMap((l) => COMMAND.exec(l)?.[1]?.trim() ?? [])
  if (command === undefined || reproduced(said, files(brief).map((f) => f.path)) !== null) return null
  const ran = atBase(src, base, command)
  const tail = ran.output.trimEnd().split('\n').slice(-TAIL).map((l) => `> ${l}`)
  const lines = brief.split('\n')
  const from = lines.findIndex((l) => l.trimEnd() === '## Reproduced')
  lines.splice(lines.findIndex((l, i) => i > from && EXPECT.test(l)) + 1, 0, `- base: \`${base}\``, `- exit: ${ran.ok ? '0' : ran.code}`, ...tail)
  const fails = said.split('\n').some((l) => EXPECT.exec(l)?.[1] === 'fails')
  return { brief: lines.join('\n'), fixed: fails && ran.ok ? [`already fixed at ${base}: \`${command}\` exited 0`, ...tail].join(' ') : null }
}

/** The brief as its writer wrote it: {@link rerun}'s rows dropped from `## Reproduced` and nowhere else. */
export function unran(brief: string): string {
  const lines = brief.split('\n')
  const from = lines.findIndex((l) => l.trimEnd() === '## Reproduced')
  const to = lines.findIndex((l, i) => i > from && l.startsWith('## '))
  return lines.filter((l, i) => from === -1 || i <= from || (to !== -1 && i >= to) || !RAN.test(l)).join('\n')
}

function atBase(src: string, base: string, command: string): Ran {
  const dir = mkdtempSync(join(tmpdir(), 'cf-reproduced-'))
  const tree = join(dir, 'tree')
  try {
    git(src, ['worktree', 'add', '--detach', tree, base])
    return npm(['-c', command], tree, 'sh')
  } finally {
    if (existsSync(tree)) git(src, ['worktree', 'remove', '--force', tree])
    rmSync(dir, { recursive: true, force: true })
  }
}
