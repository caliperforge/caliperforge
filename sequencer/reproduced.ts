import { admitted } from '../providers/kind.ts'
import { seat } from '../runner/rules.ts'
import { builder, ROOT } from '../templates/pr-path.ts'
import type { Refused } from './brief.ts'
import { languageOfSpan, OUTSIDE } from './route.ts'

const COMMAND = /^\s*-\s*command:\s*`([^`]+)`\s*$/

const EXPECT = /^\s*-\s*expect:\s*(?:fails|shows)\s*$/

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
