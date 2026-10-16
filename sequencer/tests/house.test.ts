import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import type { Read } from '../../cli/gh.ts'
import { targetRow } from '../../store/targets.ts'
import { kernel } from '../steps.ts'
import { plan, world } from './world.ts'

const URL = 'https://github.com/acme/widget/issues/12'
const OLD = 'a'.repeat(40)
const KEPT = 'b'.repeat(40)
const NEW = 'c'.repeat(40)
const RULES = '- One fix per PR\n'
const SOURCED = `sources:\n- acme/widget CONTRIBUTING.md ${OLD}\n- acme/widget docs/style.md ${KEPT}\n\n${RULES}`

function housed(root: string, text: string): void {
  mkdirSync(join(root, 'house', 'acme'), { recursive: true })
  writeFileSync(join(root, 'house', 'acme', 'widget.md'), text)
}

function gh(contributing: string, asked: string[] = []): Read {
  return (args) => {
    if (args[0] === 'api' && String(args[1]).includes('/contents/')) {
      asked.push(String(args[1]))
      return { sha: String(args[1]).endsWith('CONTRIBUTING.md') ? contributing : KEPT }
    }
    if (args[0] === 'issue') {
      return { number: 12, title: 'hello', body: 'b', state: 'OPEN', url: URL, author: { login: 'keeper' },
        assignees: [], comments: [], closedByPullRequestsReferences: [], projectItems: [] }
    }
    if (args[0] === 'search' || !args.includes('merged')) return []
    return [{ url: 'https://github.com/acme/widget/pull/2', author: { login: 'outsider' }, mergedBy: { login: 'keeper' },
      body: 'b', additions: 1, deletions: 0, files: [{ path: 'src/a.ts' }] }]
  }
}

test('D1: unchanged source shas pass step 0', () => {
  const w = world()
  housed(w.root, SOURCED)
  expect(kernel(w.db, w.root, plan(w.db, 1), undefined, gh(OLD))).toMatchObject({ outcome: 'pass', note: 'acme/widget#12 warm' })
})

test('D2: a changed sha refuses with house-source-changed', () => {
  const w = world()
  housed(w.root, SOURCED)
  expect(kernel(w.db, w.root, plan(w.db, 1), undefined, gh(NEW))).toEqual({ outcome: 'refuse', spans: ['house/acme/widget.md'],
    note: `house-source-changed: Update house/acme/widget.md: source changed\n- acme/widget CONTRIBUTING.md ${OLD} -> ${NEW}` })
  expect(targetRow(w.db, 1).state).toBe('ready')
})

test('D3: no house file makes no api call and passes', () => {
  const w = world()
  const asked: string[] = []
  expect(kernel(w.db, w.root, plan(w.db, 1), undefined, gh(NEW, asked))).toMatchObject({ outcome: 'pass' })
  expect(asked).toEqual([])
})

test('D3: a house file without sources makes no api call', () => {
  const w = world()
  housed(w.root, RULES)
  const asked: string[] = []
  expect(kernel(w.db, w.root, plan(w.db, 1), undefined, gh(NEW, asked))).toMatchObject({ outcome: 'pass' })
  expect(asked).toEqual([])
})

test('D5: a lap with no Read skips the house check', () => {
  const w = world()
  housed(w.root, SOURCED)
  expect(kernel(w.db, w.root, plan(w.db, 1))).toMatchObject({ outcome: 'pass', note: 'acme/widget#12 warm' })
})
