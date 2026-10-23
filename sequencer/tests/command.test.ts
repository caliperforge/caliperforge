import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { executed } from '../command.ts'
import { tick } from '../index.ts'
import { diffOf, maybe, put, SELF } from '../workspace.ts'
import { logged, ofKind, runRows } from '../../store/events.ts'
import { dropPlan, planById } from '../../store/plans.ts'
import { CARRIED, internalPlan, ours, plan, stub, watched, world, type World } from './world.ts'

const { gh, run } = vi.hoisted(() => ({ gh: vi.fn(), run: vi.fn() }))

vi.mock('../../cli/gh.ts', async (importOriginal) => ({ ...await importOriginal<object>(), gh, run }))

const ID = 2
const URL = 'https://github.com/caliperforge/atelier/issues/5'
const FENCE = (line: string): string => `---\noutcome: command\nrun: ${line}\n---\n`
const REFILE = `cf gh refile ${SELF}#7 caliperforge/atelier`

const ECHO = 'node tools/echo/run.ts https://example.test --out .cf/echo/example.test'
const WRITES = `import { mkdirSync, writeFileSync } from 'node:fs'
const [url, , out] = process.argv.slice(2)
mkdirSync(out, { recursive: true })
writeFileSync(out + '/report.txt', url)
console.log('wrote ' + out)
`

async function commanding(line: string, setup?: (w: World) => void): Promise<World> {
  gh.mockReset().mockReturnValue({ title: 'the old title', body: 'the old body', labels: [] })
  const w = world()
  dropPlan(w.db, 1)
  ours(w.root)
  internalPlan(w.db, w.root, ID, 'misfiled', 7)
  setup?.(w)
  logged(w.db, { plan: ID, kind: 'director', actor: 'coo_lite', outcome: 'needs_ceo', message: 'block', pointer: null, run: null })
  await tick(w.db, w.root, stub(CARRIED), undefined, undefined, watched([], w.root, ID))
  await tick(w.db, w.root, stub(CARRIED, 0, undefined, undefined, FENCE(line)), undefined, undefined, watched([], w.root, ID))
  return w
}

test('D1: a refile command ends the plan done at step 1', async () => {
  run.mockReset().mockReturnValue(`${URL}\n`)
  const w = await commanding(REFILE)
  expect(plan(w.db, ID)).toMatchObject({ state: 'done', step: 1 })
  expect(runRows(w.db).filter((r) => r.plan === ID && r.step >= 2)).toHaveLength(0)
  expect(diffOf(w.root, ID)).toBe('')
  expect(maybe(w.root, ID, 'command.md')).toBe(`${REFILE}\n\n${URL}\n`)
  expect(maybe(w.root, ID, 'issue.md')).toBeNull()
})

test('D2: a refile that throws blocks the plan on the CEO', async () => {
  run.mockReset().mockImplementation(() => { throw new Error('gh exited 1') })
  const w = await commanding(REFILE)
  expect(plan(w.db, ID)).toMatchObject({ state: 'blocked_on_ceo' })
  expect(maybe(w.root, ID, 'command.md')).toBe(`${REFILE}\n\ngh exited 1\n`)
  expect(ofKind(w.db, 'command').map((e) => e.outcome)).toEqual(['escalate'])
})

test('D3: a command off the allow-list is refused with no gh call', async () => {
  run.mockReset()
  const w = await commanding('cf gh close x#1')
  expect(plan(w.db, ID).state).not.toBe('done')
  expect(maybe(w.root, ID, 'refusal.md')).toContain('cf gh close x#1 is not on the allow-list')
  expect(gh).not.toHaveBeenCalled()
  expect(run).not.toHaveBeenCalled()
})

function echo(body: string, ask = `# snapshot\n\nRun \`${ECHO}\`\n`): (w: World) => void {
  return (w) => {
    mkdirSync(join(w.root, 'tools/echo'), { recursive: true })
    writeFileSync(join(w.root, 'tools/echo/run.ts'), body)
    put(w.root, ID, 'ask.md', ask)
  }
}

test('D2: a tool line the ask carries runs at the machine root', async () => {
  const w = await commanding(ECHO, echo(WRITES))
  expect(plan(w.db, ID)).toMatchObject({ state: 'done', step: 1 })
  expect(runRows(w.db).filter((r) => r.plan === ID && r.step >= 2)).toHaveLength(0)
  expect(diffOf(w.root, ID)).toBe('')
  expect(maybe(w.root, ID, 'command.md')).toBe(`${ECHO}\n\nwrote .cf/echo/example.test\n\n`)
  expect(readFileSync(join(w.root, '.cf/echo/example.test/report.txt'), 'utf8')).toBe('https://example.test')
})

test('D3: a tool line the ask lacks is refused and not run', async () => {
  const w = await commanding(ECHO, echo(WRITES, '# snapshot\n\nRun the snapshot\n'))
  expect(plan(w.db, ID).state).not.toBe('done')
  expect(maybe(w.root, ID, 'refusal.md')).toContain(`${ECHO} is not in the ask`)
  expect(existsSync(join(w.root, '.cf/echo'))).toBe(false)
})

test('D4: an --out, url or extra word off the pattern is refused', () => {
  const w = world()
  internalPlan(w.db, w.root, ID, 'misfiled', 7)
  for (const line of [
    'node tools/echo/run.ts https://example.test --out .cf/other/x',
    'node tools/echo/run.ts https://example.test --out .cf/echo/../x',
    'node tools/echo/run.ts ftp://example.test --out .cf/echo/example.test',
    `${ECHO} --force`,
  ]) {
    echo(WRITES, `Run \`${line}\`\n`)(w)
    expect(executed(w.db, w.root, planById(w.db, ID), line)).toMatchObject({ outcome: 'refuse', note: `${line} is not on the allow-list` })
  }
  expect(['echo', 'other', 'x'].filter((dir) => existsSync(join(w.root, '.cf', dir)))).toEqual([])
})

test('D5: a tool that exits non-zero blocks the plan on the CEO', async () => {
  const w = await commanding(ECHO, echo('process.exit(2)\n'))
  expect(plan(w.db, ID)).toMatchObject({ state: 'blocked_on_ceo' })
  expect(maybe(w.root, ID, 'command.md')).toMatch(new RegExp(`^${ECHO.replace(/\./g, '\\.')}\n\nCommand failed: node tools/echo/run\\.ts`))
  expect(ofKind(w.db, 'command').map((e) => e.outcome)).toEqual(['escalate'])
})
