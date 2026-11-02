import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { critic, criticCheck, section } from '../../../templates/critic.ts'
import { type Check, fixed } from '../../../templates/fixturn.ts'
import { type Fire, START } from '../../../templates/phases.ts'

const CHECKS: [string, string][] = [['Share-Converted Comparisons', "grep -rn 'assertEq(.*convertToAssets' {SUITE_DIR}"],
  ['Unbounded Stand-ins', 'for f in $(grep -rl \'contract Mock\' {SUITE_DIR}); do grep -q \'// stand-in limits:\' "$f" || echo "$f"; done']]
const block = ([heading, sh]: [string, string]): string => `## ${heading}\n\n\`\`\`sh\n${sh}\n\`\`\`\n`
const CONVERTED = 'assertEq(vault.convertToAssets(s), a);\n'
const MOCK = 'contract MockOracle {}\n'
const CLEAN = { 'Suite.sol': 'assertApproxEqAbs(vault.convertToAssets(s), a, 2);\n', 'Mock.sol': 'contract MockOracle {} // stand-in limits: 1e6 of start\n' }
const OUTSIDE = '- MockOracle.price | at: src/Oracle.sol L1-L4'
const LIMITS = '- maxDeposit | at: src/Vault.sol L8-L9'
const GUARDS = '- Vault.deposit | reverts: zero shares'
const MAP = `## Guards\n\n${GUARDS}\n\n## Outside dependencies\n\n${OUTSIDE}\n\n## Limits\n\n${LIMITS}\n`

function bench(suite: Record<string, string>, fix: (dir: string) => void = () => undefined) {
  const dir = mkdtempSync(join(tmpdir(), 'cf-fizz-fixturn-'))
  const handoffs = join(dir, 'handoff')
  mkdirSync(join(dir, 'test/fizz'), { recursive: true })
  mkdirSync(handoffs)
  for (const [name, text] of Object.entries(suite)) writeFileSync(join(dir, 'test/fizz', name), text)
  const pass = join(dir, 'critic-pass.md')
  writeFileSync(pass, CHECKS.map(block).join('\n'))
  const fires: { phase: string; issue: string }[] = []
  const fire: Fire = (...args) => {
    const [, issue, sum, phase = ''] = args
    fires.push({ phase, issue })
    fix(dir)
    return Promise.resolve({ ...sum, tokens: sum.tokens + 3, usd: sum.usd + 0.25 })
  }
  const run = (check: Check) => fixed({ fire, dir, handoffs }, check, 'invariants', START)
  const check = (rule: string) => criticCheck(pass, dir, rule, MAP)
  return { dir, handoffs, pass, fires, run, check }
}

test('D1: a converted assertEq is fixed in one turn', async () => {
  const { fires, run, check } = bench({ 'Suite.sol': CONVERTED }, (dir) => { writeFileSync(join(dir, 'test/fizz/Suite.sol'), CLEAN['Suite.sol']) })
  expect(await run(check('critic.share_converted'))).toMatchObject({ not_clean: null })
  expect(fires).toHaveLength(1)
  const issue = fires[0]?.issue ?? ''
  expect(issue).toContain(`test/fizz/Suite.sol L1-L1\n${CONVERTED}`)
  expect(issue).toContain(block(CHECKS[0] ?? ['', '']))
  for (const absent of ['## Unbounded Stand-ins', OUTSIDE, LIMITS, GUARDS]) expect(issue).not.toContain(absent)
})

test('D2: an unfixed MockOracle stops after 2 turns, not_clean', async () => {
  const { handoffs, fires, run, check } = bench({ 'Mock.sol': MOCK })
  expect(await run(check('critic.stand_in'))).toMatchObject({ not_clean: 'not_clean: critic' })
  expect(fires).toHaveLength(2)
  expect(fires[0]?.issue).toContain(`${OUTSIDE}\n\n## Limits\n\n${LIMITS}`)
  expect(fires[0]?.issue).not.toContain(GUARDS)
  expect(readFileSync(join(handoffs, 'critic.md'), 'utf8')).toBe('critic.stand_in: test/fizz/Mock.sol\n')
})

test('D3: a clean suite fires no turn and keeps its sum', async () => {
  const { fires, run, check } = bench(CLEAN)
  const result = await run(check('critic.stand_in'))
  expect(result).toEqual({ sum: START, turns: [], not_clean: null })
  expect(fires).toHaveLength(0)
})

test('D4: each turn fires its phase and holds its cost', async () => {
  const { handoffs, fires, run, check } = bench({ 'Mock.sol': MOCK })
  expect(await run(check('critic.stand_in'))).toMatchObject({ sum: { tokens: 6, usd: 0.5 },
    turns: [{ turn: 1, tokens: 3, usd: 0.25 }, { turn: 2, tokens: 3, usd: 0.25 }] })
  expect(fires.map((f) => f.phase)).toEqual(['invariants-fix-critic-1', 'invariants-fix-critic-2'])
  expect(fires[1]?.issue).toContain(`Write your reply to ${join(handoffs, 'invariants-fix-critic-2.md')}.`)
})

test('D5: six hits cleared one a turn stop at turn 5', async () => {
  let left = 6
  const { handoffs, fires, run } = bench({}, () => { left -= 1 })
  const result = await run({ name: 'six', rules: '', facts: '', run: () => [...Array(left).keys()].map((i) => ({ rule: 'six.hit', note: `hit ${String(i)}` })) })
  expect(fires).toHaveLength(5)
  expect(result).toMatchObject({ not_clean: 'not_clean: six' })
  expect(readFileSync(join(handoffs, 'six.md'), 'utf8')).toBe('six.hit: hit 0\n')
})

test('D6: a hit at line 30 of 60 carries lines 10 to 50', async () => {
  const long = [...Array(60).keys()].map((i) => `line ${String(i + 1)}\n`).join('')
  const { fires, run } = bench({ 'Long.sol': long })
  await run({ name: 'long', rules: '', facts: '', run: () => [{ rule: 'long.hit', note: 'test/fizz/Long.sol:30:line 30' }] })
  const lines = fires[0]?.issue.split('\n') ?? []
  expect(lines).toContain('test/fizz/Long.sol L10-L50')
  expect(lines).toContain('line 10')
  expect(lines).toContain('line 50')
  expect(lines).not.toContain('line 9')
  expect(lines).not.toContain('line 51')
})

test('D7: one rule runs one check, a missing heading throws', () => {
  const { dir, pass } = bench({ 'Suite.sol': CONVERTED, 'Mock.sol': MOCK })
  expect(critic(pass, dir, 'critic.stand_in')).toEqual([{ rule: 'critic.stand_in', note: 'test/fizz/Mock.sol' }])
  expect(critic(pass, dir).map((r) => r.rule)).toEqual(['critic.share_converted', 'critic.stand_in'])
  writeFileSync(pass, block(CHECKS[0] ?? ['', '']))
  expect(() => section(pass, 'critic.stand_in')).toThrow(`${pass} has no heading for critic.stand_in`)
})
