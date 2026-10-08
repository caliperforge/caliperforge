import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { fresh } from '../../../checks/sqlite.ts'
import { claudeAgentSdk } from '../../../providers/claude-agent-sdk/index.ts'
import { planRow } from '../../../runner/index.ts'
import { load } from '../../../runner/rules.ts'
import { judge, loadReviews } from '../../bench.ts'

const root = join(import.meta.dirname, '../../..')

interface Fixture { repo: string; base: string; head: string; expected: string[] }

function at(span: string): [string, number] {
  const colon = span.lastIndexOf(':')
  return [span.slice(0, colon), Number.parseInt(span.slice(colon + 1), 10)]
}

test.runIf(process.env.CF_BENCH_LIVE === '1').each(['899', '632'])('blind review finds what Greptile found on plan %s', async (id) => {
  const { repo, base, head, expected } = JSON.parse(readFileSync(join(root, 'reviews/blind_review/fixtures', `${id}.json`), 'utf8')) as Fixture
  const cwd = mkdtempSync(join(tmpdir(), 'cf-backtest-'))
  const git = (...args: string[]): string => execFileSync('git', args, { cwd, encoding: 'utf8' })
  git('init', '-q')
  git('fetch', '-q', repo, base, head)
  git('checkout', '-q', head)
  const diff = git('diff', `${base}...${head}`)
  const db = fresh(join(root, 'schema'))
  load(db, root)
  loadReviews(db, root)
  const { outcome } = await judge(db, root, 'blind_review', planRow(db), { repo: cwd, diff }, claudeAgentSdk, `${cwd}.transcript.jsonl`)
  const found = outcome.spans.map(at)
  const missed = expected.filter((g) => {
    const [path, line] = at(g.slice(g.indexOf(' ') + 1))
    return !found.some(([p, l]) => p === path && Math.abs(l - line) <= 3)
  })
  expect(missed).toEqual([])
}, 3_600_000)
