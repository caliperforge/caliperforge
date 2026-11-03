import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Outcome } from '../sequencer/kind.ts'
import { lineCount } from './extract.ts'
import type { Refused } from './handoff.ts'
import type { Fire, Sum } from './phases.ts'
import type { Turn } from './report.ts'

export const FIX = { model: 'claude-sonnet-5', write_paths: ['test/fizz'], tools: ['Read', 'Glob', 'Grep', 'Write', 'Edit', 'Bash(forge build)'] }

export interface Check { name: string; rules: string; facts: string; run: () => Refused[] }

export interface Suite { fire: Fire; dir: string; handoffs: string }

export interface Fixed { sum: Sum; turns: Turn[]; not_clean: string | null }

const PROMPT = 'Repair each hit the issue lists, the way its rules say. Write only under test/fizz. '
  + 'Never run forge build --force or forge clean: the machine builds before it checks. Then write the reply the issue names, holding '
  + '`## Fixed`, one row per hit you repaired: file, line, what changed; and `## Not fixed`, each hit you left and why.'

const NOTE = /^([^:\s]+)(?::(\d+):)?/

const AROUND = 20

const TURNS = 5

const STALE = 2

function excerpt(dir: string, note: string): string[] {
  const [, file = '', at = '1'] = NOTE.exec(note) ?? []
  const path = join(dir, file)
  if (file === '' || !existsSync(path)) return []
  const source = readFileSync(path)
  const [start, end] = [Math.max(1, Number(at) - AROUND), Math.min(Number(at) + AROUND, lineCount(source))]
  return [`${file} L${String(start)}-L${String(end)}\n${source.toString('utf8').split('\n').slice(start - 1, end).join('\n')}`]
}

export function fixTurn(suite: Suite, check: Check, hits: Refused[], phase: string, turn: number, sum: Sum): Promise<Sum | Outcome> {
  const name = `${phase}-fix-${check.name}-${String(turn)}`
  const issue = [`${check.name} found:`, ...hits.map((h) => `- ${h.note}`), ...hits.flatMap((h) => excerpt(suite.dir, h.note)), check.rules,
    ...(check.facts === '' ? [] : [check.facts]), `Write your reply to ${join(suite.handoffs, `${name}.md`)}.`]
  return suite.fire(PROMPT, issue.join('\n'), sum, name)
}

export async function fixed(suite: Suite, check: Check, phase: string, sum: Sum): Promise<Fixed | Outcome> {
  const turns: Turn[] = []
  let [hits, at, stale] = [check.run(), sum, 0]
  while (hits.length > 0 && stale < STALE && turns.length < TURNS && at.wall === null) {
    const turn = turns.length + 1
    const ran = await fixTurn(suite, check, hits, phase, turn, at)
    if ('outcome' in ran) return ran
    const left = check.run()
    turns.push({ turn, tokens: ran.tokens - at.tokens, usd: ran.usd - at.usd })
    stale = left.length < hits.length ? 0 : stale + 1
    ;[hits, at] = [left, ran]
  }
  if (hits.length === 0) return { sum: at, turns, not_clean: null }
  writeFileSync(join(suite.handoffs, `${check.name}.md`), hits.map((r) => `${r.rule}: ${r.note}\n`).join(''))
  return { sum: at, turns, not_clean: `not_clean: ${check.name}` }
}
