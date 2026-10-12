import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { git } from '../sequencer/workspace.ts'
import { overall } from './card.ts'
import { scan, type Net, type Scanned } from './scan.ts'

const REPO = 'https://github.com/solana-foundation/pay-skills.git'
const PASS = /^live-(\d{4}-\d{2}-\d{2})\.jsonl$/

export interface Diffed { failing: string[]; passing: string[]; gone: string[] }

const verdict = (s: Scanned): string => ('crash' in s ? 'crash' : overall(s))
const passes = (s: Scanned): boolean => verdict(s) === 'pass'

export function providers(into: string): string[] {
  git(into, ['clone', '--depth', '1', '--branch', 'main', REPO, '.'])
  return git(into, ['ls-files', '*/PAY.md']).split('\n').filter((p) => p !== '').map((p) => join(into, dirname(p)))
}

export function diffed(last: Scanned[], now: Scanned[]): Diffed {
  const passed = new Map(last.map((s) => [s.fqn, passes(s)]))
  const kept = new Set(now.map((s) => s.fqn))
  const turned = (to: boolean): string[] => now.filter((s) => passes(s) === to && passed.get(s.fqn) !== to).map((s) => s.fqn)
  return { failing: turned(false), passing: turned(true), gone: last.filter((s) => !kept.has(s.fqn)).map((s) => s.fqn) }
}

export async function live(dir: string, date: string, dirs: string[], net: Net): Promise<Diffed> {
  mkdirSync(dir, { recursive: true })
  const prev = readdirSync(dir).flatMap((f) => PASS.exec(f)?.[1] ?? []).filter((d) => d < date).sort().at(-1)
  const last = prev === undefined ? [] : readFileSync(join(dir, `live-${prev}.jsonl`), 'utf8').split('\n').filter((l) => l !== '').map((l) => JSON.parse(l) as Scanned)
  const now = await scan(dirs, undefined, join(dir, `live-${date}`), net)
  writeFileSync(join(dir, `live-${date}.jsonl`), now.map((row) => `${JSON.stringify(row)}\n`).join(''))
  const diff = diffed(last, now)
  const failing = now.filter((s) => diff.failing.includes(s.fqn)).map((s) => `${s.fqn}: ${verdict(s)}`)
  const list = (items: string[]): string[] => (items.length === 0 ? ['- none'] : items.map((i) => `- ${i}`))
  writeFileSync(join(dir, `live-${date}.md`), [
    `# pay-skills live ${date} against ${prev ?? 'no earlier pass'}`,
    '',
    '## Newly failing', ...list(failing),
    '## Newly passing', ...list(diff.passing),
    '## Gone', ...list(diff.gone),
    '',
  ].join('\n'))
  return diff
}
