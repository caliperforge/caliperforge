import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { alive } from '../../../store/leases.ts'
import { selected } from '../../../templates/map.ts'
import { packed, smoke, type Smoked, smoked, unrun } from '../../../templates/smoke.ts'

const fixtures = join(import.meta.dirname, 'fixtures')
const REPORT = join(fixtures, 'revert_report.json')
const SELECTION = readFileSync(join(fixtures, 'entry-point-selection.json'), 'utf8')
const MAP = `## Selected entry points\n\n${selected(SELECTION).map((r) => `- ${r}\n`).join('')}\n`
  + '## Unclamped\n\n- V.withdraw | reason: any amount the vault holds is valid\n\n'
  + '## Handlers\n\n- Harness.v_deposit | target: V.deposit\n- Harness.v_deposit_clamped | target: V.deposit\n- Harness.v_withdraw | target: V.withdraw\n'
const WITHDRAWN = { contractRevertMetrics: { Harness: { functionRevertMetrics: { v_withdraw: { totalCalls: 3, totalReverts: 2, revertReasonMetrics: {} } } } } }
const [DEPOSIT, WITHDRAW, CONVERT] = ['V.deposit(uint256 assets)', 'V.withdraw(uint256 assets)', 'V.convertToAssets(uint256 shares)']
const META = 'test/fizz/fizz_data'
const MEDUSA = { fuzzing: { targetContracts: ['Harness'], corpusDirectory: `${META}/corpus_medusa` },
  compilation: { platform: 'crytic-compile', platformConfig: { target: '.', args: ['--foundry-compile-all'] } } }

test('6/9 D4: smoked reads successes per entry point', () => {
  const results = smoked(MAP, REPORT)
  expect(results).toEqual([{ name: DEPOSIT, calls: 40, successes: 40 }, { name: WITHDRAW, calls: 25, successes: 0 }, { name: CONVERT, calls: 0, successes: 0 }])
  expect(packed(results)).toBe(`- ${DEPOSIT} | calls: 40 | successes: 40\n- ${WITHDRAW} | calls: 25 | successes: 0\n- ${CONVERT} | calls: 0 | successes: 0\n`)
})

test('6/9 D5: unrun flags only an Unclamped row with no success', () => {
  expect(unrun(MAP, smoked(MAP, REPORT))).toEqual([
    { rule: 'smoke.unclamped', note: `smoke: ${WITHDRAW} is raw-only and made 0 successful calls in 25; it needs a clamped handler` },
  ])
  const report = join(mkdtempSync(join(tmpdir(), 'cf-fizz-smoke-')), 'revert_report.json')
  writeFileSync(report, JSON.stringify(WITHDRAWN))
  expect(unrun(MAP, smoked(MAP, report))).toEqual([])
})

function medusa(script: string): { root: string; fizz: string; config: string } {
  const [root, fizz] = [mkdtempSync(join(tmpdir(), 'cf-fizz-smoke-')), mkdtempSync(join(tmpdir(), 'cf-fizz-skill-'))]
  mkdirSync(join(fizz, 'scripts'))
  writeFileSync(join(fizz, 'scripts/run_medusa.js'), script)
  const config = JSON.stringify(MEDUSA)
  writeFileSync(join(root, 'medusa.json'), config)
  return { root, fizz, config }
}

const HANGS = "const { spawn } = require('node:child_process')\nconst { writeFileSync } = require('node:fs')\n"
  + 'for (let i = 1; i <= 50; i++) console.log(`line ${i}`)\n'
  + "writeFileSync('pid', String(spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'inherit' }).pid))\n"
  + 'setInterval(() => {}, 1000)\n'

test('a never-exiting medusa is killed and refused as smoke.hung', async () => {
  const { root, fizz, config } = medusa(HANGS)
  const lines = [...Array(40).keys()].map((i) => `line ${String(i + 11)}`).join('\n')
  expect(smoke(root, fizz, META, MAP, 2)).toEqual({ rule: 'smoke.hung',
    note: `smoke: medusa ran past --timeout 120 + 60 s and its process group was killed; last 40 lines:\n${lines}` })
  const pid = Number(readFileSync(join(root, 'pid'), 'utf8'))
  await expect.poll(() => alive(pid)).toBe(false)
  expect(readFileSync(join(root, 'medusa.json'), 'utf8')).toBe(config)
}, 10_000)

test('a medusa that exits without a report still throws', () => {
  const { root, fizz } = medusa('process.exit(3)\n')
  expect(() => smoke(root, fizz, META, MAP, 2)).toThrow('run_medusa.js exited 3 and wrote no ')
})

test.runIf(process.env.CF_BENCH_LIVE === '1')('6/9 D8: smoke runs medusa, restores medusa.json', () => {
  const root = mkdtempSync(join(tmpdir(), 'cf-fizz-smoke-'))
  for (const dir of ['src', META]) mkdirSync(join(root, dir), { recursive: true })
  copyFileSync(join(fixtures, 'V.sol'), join(root, 'src/V.sol'))
  copyFileSync(join(fixtures, 'Harness.sol'), join(root, 'test/fizz/Harness.sol'))
  writeFileSync(join(root, 'foundry.toml'), '[profile.default]\n')
  const config = JSON.stringify(MEDUSA)
  writeFileSync(join(root, 'medusa.json'), config)
  const results = smoke(root, join(homedir(), '.claude/skills/fizz'), META, MAP) as Smoked[]
  expect(results.map((r) => [r.name, r.calls > 0, r.successes > 0])).toEqual([[DEPOSIT, true, true], [WITHDRAW, true, true], [CONVERT, false, false]])
  expect(readFileSync(join(root, 'medusa.json'), 'utf8')).toBe(config)
}, 300_000)
