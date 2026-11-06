import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test, vi } from 'vitest'
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

afterEach(() => { vi.unstubAllEnvs() })

function medusa(script: string, forge = 'mkdir -p out/build-info', crytic = 'exit 0'): { root: string; fizz: string; config: string } {
  const [root, fizz, bin] = [mkdtempSync(join(tmpdir(), 'cf-fizz-smoke-')), mkdtempSync(join(tmpdir(), 'cf-fizz-skill-')), mkdtempSync(join(tmpdir(), 'cf-fizz-bin-'))]
  writeFileSync(join(bin, 'forge'), `#!/bin/sh\necho "$@" >> forge.log\n${forge}\n`, { mode: 0o755 })
  writeFileSync(join(bin, 'crytic-compile'), `#!/bin/sh\n${crytic}\n`, { mode: 0o755 })
  vi.stubEnv('PATH', `${bin}:${process.env.PATH ?? ''}`)
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

const SEES = "const { copyFileSync, mkdirSync } = require('node:fs')\ncopyFileSync('medusa.json', 'seen.json')\n"
  + `mkdirSync('${META}/corpus_medusa/coverage', { recursive: true })\ncopyFileSync(${JSON.stringify(REPORT)}, '${META}/corpus_medusa/coverage/revert_report.json')\n`

test('medusa reuses the build and medusa.json is restored', () => {
  const { root, fizz, config } = medusa(SEES)
  expect(smoke(root, fizz, META, MAP, 30)).toEqual(smoked(MAP, REPORT))
  const seen = JSON.parse(readFileSync(join(root, 'seen.json'), 'utf8')) as typeof MEDUSA
  expect(seen.compilation).toEqual({ ...MEDUSA.compilation, platformConfig: { target: '.', args: ['--foundry-ignore-compile'] } })
  expect(readFileSync(join(root, 'medusa.json'), 'utf8')).toBe(config)
})

const STARTS = "require('node:fs').writeFileSync('started', '')\n"

test('a slow forge build refuses before medusa starts', () => {
  const { root, fizz, config } = medusa(STARTS, 'exec sleep 5')
  expect(smoke(root, fizz, META, MAP, 30, 1)).toEqual({ rule: 'smoke.compile_slow',
    note: 'smoke: forge build --ast --build-info --force ran past its 1 s limit and was stopped after 1 s; medusa did not run' })
  expect(existsSync(join(root, 'started'))).toBe(false)
  expect(readFileSync(join(root, 'medusa.json'), 'utf8')).toBe(config)
}, 10_000)

test('partial build-info is rebuilt once with --force, then reused', () => {
  const forge = 'case "$*" in *--force*) touch out/build-info/a.json out/build-info/a.output.json;; esac'
  const { root, fizz } = medusa(SEES, forge, 'test -f out/build-info/a.output.json')
  mkdirSync(join(root, 'out/build-info'), { recursive: true })
  writeFileSync(join(root, 'out/build-info/a.json'), '{}')
  writeFileSync(join(root, 'V.sol'), 'contract V {}\n')
  const forced = 'build --ast --build-info --force\n'
  expect(smoke(root, fizz, META, MAP, 30)).toEqual(smoked(MAP, REPORT))
  expect(smoke(root, fizz, META, MAP, 30)).toEqual(smoked(MAP, REPORT))
  expect(readFileSync(join(root, 'forge.log'), 'utf8')).toBe(forced)
  writeFileSync(join(root, 'V.sol'), 'contract V { uint x; }\n')
  smoke(root, fizz, META, MAP, 30)
  expect(readFileSync(join(root, 'forge.log'), 'utf8')).toBe(forced.repeat(2))
})

test('a failing crytic-compile refuses as smoke.compile_failed', () => {
  const { root, fizz, config } = medusa(STARTS, undefined, 'for i in $(seq 1 30); do echo "line $i" >&2; done\nexit 1')
  const lines = [...Array(20).keys()].map((i) => `line ${String(i + 11)}`).join('\n')
  expect(smoke(root, fizz, META, MAP, 30)).toEqual({ rule: 'smoke.compile_failed',
    note: `smoke: crytic-compile . --foundry-ignore-compile --export-format solc exited 1; last 20 lines:\n${lines}` })
  expect(existsSync(join(root, 'started'))).toBe(false)
  expect(readFileSync(join(root, 'medusa.json'), 'utf8')).toBe(config)
})

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
  const info = (): [string, string][] => readdirSync(join(root, 'out/build-info')).sort().map((f) => [f, readFileSync(join(root, 'out/build-info', f), 'utf8')])
  smoke(root, join(homedir(), '.claude/skills/fizz'), META, MAP)
  const built = info()
  const results = smoke(root, join(homedir(), '.claude/skills/fizz'), META, MAP) as Smoked[]
  expect(results.map((r) => [r.name, r.calls > 0, r.successes > 0])).toEqual([[DEPOSIT, true, true], [WITHDRAW, true, true], [CONVERT, false, false]])
  expect(info()).toEqual(built)
  expect(readFileSync(join(root, 'medusa.json'), 'utf8')).toBe(config)
}, 300_000)
