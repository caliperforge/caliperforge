import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Options, query } from '@anthropic-ai/claude-agent-sdk'
import { expect, test, vi } from 'vitest'
import type { Packet } from '../../kind.ts'

const LIVE = process.env.CF_BENCH_LIVE === '1'

const sent: Options[] = []

const RESULT = { type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', modelUsage: {}, permission_denials: [], result: '',
  usage: { cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 0 } } }

vi.mock('@anthropic-ai/claude-agent-sdk', async (original) => {
  const sdk = await original<{ query: typeof query }>()
  return { ...sdk, query: (args: Parameters<typeof query>[0]) => {
    sent.push(args.options ?? {})
    return LIVE ? sdk.query(args) : { [Symbol.asyncIterator]: () => [RESULT][Symbol.iterator]() }
  } }
})

const { claudeAgentSdk } = await import('../index.ts')

function packet(cwd: string, tools: string[], prompt = 'p'): Packet {
  return { prompt, cwd, transcript: join(cwd, '..', 'run.transcript.jsonl'), model: 'claude-haiku-4-5-20251001', effort: 'low', tools, refuse: () => null }
}

const SEALED = { enabled: true, failIfUnavailable: true, allowUnsandboxedCommands: false, network: { allowedDomains: [], strictAllowlist: true } }

test('D3 D5 an offline packet seals Bash; others send neither', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cf-offline-'))
  await claudeAgentSdk.fire({ ...packet(dir, ['Read']), offline: true })
  expect(sent.at(-1)?.sandbox).toEqual(SEALED)
  const asked = sent.at(-1)?.canUseTool
  const options = { signal: new AbortController().signal, toolUseID: 't', requestId: 'r' }
  expect(await asked?.('Bash', { command: 'curl https://github.com' }, options)).toMatchObject({ behavior: 'deny' })
  await claudeAgentSdk.fire({ ...packet(dir, ['Read']), offline: true, env: { TMPDIR: '/tmp/scratch' } })
  expect(sent.at(-1)?.sandbox).toEqual({ ...SEALED, filesystem: { allowWrite: ['/tmp/scratch'] } })
  await claudeAgentSdk.fire(packet(dir, ['Read']))
  expect(sent.at(-1)).not.toHaveProperty('sandbox')
  expect(sent.at(-1)).not.toHaveProperty('canUseTool')
})

const FETCH = (marker: string) => `await fetch('https://github.com')\nimport('node:fs').then((fs) => fs.writeFileSync('${marker}', ''))\n`

const MEDUSA = { fuzzing: { targetContracts: ['Counter'], corpusDirectory: 'corpus', timeout: 10 },
  compilation: { platform: 'crytic-compile', platformConfig: { target: '.', args: ['--foundry-compile-all'] } } }

/** A one-contract foundry project, the probes that fetch, and the scripts that run locally. */
function fixture(): { cwd: string; tmp: string } {
  const root = mkdtempSync(join(tmpdir(), 'cf-offline-'))
  const cwd = join(root, 'src')
  const tmp = join(root, 'scratch')
  for (const dir of [join(cwd, 'src'), tmp]) mkdirSync(dir, { recursive: true })
  writeFileSync(join(cwd, 'foundry.toml'), '[profile.default]\nsrc = "src"\nout = "out"\n')
  writeFileSync(join(cwd, 'src/Counter.sol'), 'pragma solidity ^0.8.0;\ncontract Counter {\n  uint256 public n;\n  function up() public { n += 1; }\n}\n')
  writeFileSync(join(cwd, 'medusa.json'), JSON.stringify(MEDUSA))
  writeFileSync(join(cwd, 'probe.mjs'), FETCH('reached-1'))
  writeFileSync(join(cwd, 'probe2.mjs'), FETCH('reached-2'))
  writeFileSync(join(cwd, 'local.mjs'), "import { writeFileSync } from 'node:fs'\nwriteFileSync('local.txt', '')\n")
  writeFileSync(join(cwd, 'write.mjs'), "import { writeFileSync } from 'node:fs'\nwriteFileSync(`${process.env.TMPDIR}/written`, '')\n")
  return { cwd, tmp }
}

const TOP = ["bash -c 'curl https://github.com'", 'node probe.mjs']

const SUB = ["bash -c 'curl https://example.com'", 'node probe2.mjs']

const LOCAL = ['forge build', 'medusa fuzz --timeout 10', 'node local.mjs', 'node write.mjs']

const PROMPT = [`Run each of these Bash commands exactly as written, one per call, and go on when one fails: ${[...TOP, ...LOCAL].join(', ')}.`,
  `Then spawn one Agent sub-agent and have it run each of these Bash commands exactly as written, one per call: ${SUB.join(', ')}.`,
  'End with the word done.'].join('\n')

test.runIf(LIVE)('D1 D2 D6 an offline session cuts the network', async () => {
  const { cwd, tmp } = fixture()
  const fired = await claudeAgentSdk.fire({ ...packet(cwd, ['Bash(bash:*)', 'Bash(node:*)', 'Bash(forge:*)', 'Bash(medusa:*)', 'Agent'], PROMPT),
    offline: true, env: { TMPDIR: tmp } })
  expect(fired.offline).toEqual(expect.arrayContaining([...TOP, ...SUB]))
  for (const command of LOCAL) expect(fired.offline).not.toContain(command)
  for (const marker of ['reached-1', 'reached-2']) expect(existsSync(join(cwd, marker))).toBe(false)
  for (const made of [join(cwd, 'out/Counter.sol/Counter.json'), join(cwd, 'corpus'), join(cwd, 'local.txt'), join(tmp, 'written')]) expect(existsSync(made)).toBe(true)
}, 600_000)
