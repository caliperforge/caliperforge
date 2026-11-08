import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { firstLine } from '../sequencer/unpolled.ts'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import type { ProbeReadings } from './reach.ts'
import { type Suite, suite } from './suite.ts'

type Value = bigint | boolean

interface Layout { storage: { label: string; slot: string; offset: number; type: string }[]; types: Record<string, { numberOfBytes: string }> }

type Sequence = { call: { from: string; data: string } }[]

interface Entry { name: string; file: string; deployer: bigint; value: bigint }

const TEST = 'test/fizz/ProbeReadings.t.sol'
const TRACKED = /^t_(?:uint\d+|bool)$/
const LOGGED = /^\s*(\w+\.\w+)= (\d+|true|false)$/gm
const LINES = 40
const WALL = 10 * 60 * 1000
const CAP = 50
const REPLAYED = /^replayed: .*$/m
const WARNING = /^Warning \(\d+\)/
const FAILED = /\[FAIL|error|revert/i
export const COMMENT = /\/\*[\s\S]*?\*\/|\/\/.*/g
const PROBE = /\bfunction\s+(property_probe\w*)\s*\(/g
const VISIBLE = /(\bfunction\s+read_probe\w*\s*\([^)]*\)[^{;]*?)\b(?:public|external)\b/g

const bare = (tracker: string): string => tracker.slice(tracker.indexOf('.') + 1)

const larger = (a: bigint, b: bigint): bigint => a > b ? a : b

const smaller = (a: bigint, b: bigint): bigint => a < b ? a : b

function unwarned(text: string): string[] {
  let warned = false
  return text.split('\n').filter((l) => {
    warned = WARNING.test(l) || (warned && l.trim() !== '')
    return !warned && l.trim() !== ''
  })
}

function told(stdout: string, stderr: string): string {
  const lines = [...unwarned(stdout), ...unwarned(stderr)]
  const failed = lines.filter((l) => FAILED.test(l))
  return (failed.length === 0 ? lines : failed).slice(-LINES).join(' ⏎ ')
}

export function readings(probes: Suite['probes'], values: Map<string, Value>): ProbeReadings {
  const read: ProbeReadings = { limits: {}, conversions: {} }
  for (const cite of new Set(probes.flatMap((p) => p.cites ?? []))) {
    const seen = probes.filter((p) => p.cites === cite).flatMap((p) => p.trackers).flatMap((t) => { const v = values.get(t); return v === undefined ? [] : [{ t: bare(t), v }] })
    if (seen.length === 0) continue
    const ints = (prefix: string): bigint[] => seen.flatMap(({ t, v }) => typeof v === 'bigint' && t.startsWith(prefix) ? [v] : [])
    const [maxes, mins, saws] = [ints('max'), ints('min'), seen.flatMap(({ v }) => typeof v === 'boolean' ? [v] : [])]
    const max = maxes.reduce(larger, 0n)
    if (mins.length + saws.length === 0) read.limits[cite] = { max }
    else read.conversions[cite] = { min: mins.length === 0 ? 0n : mins.reduce(smaller), max, saw1Wei: saws.includes(true) }
  }
  return read
}

function forge(root: string, args: string[], held = ''): string {
  const ran = spawnSync('forge', args, { cwd: root, encoding: 'utf8', env: { ...process.env, FOUNDRY_PROFILE: 'fuzz', FOUNDRY_CODE_SIZE_LIMIT: '4294967295' }, timeout: WALL })
  if ((ran.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') throw new Error(`forge ${args.join(' ')} passed the ${String(WALL)} ms wall clock${held}`)
  if (ran.status !== 0) throw new Error(`forge ${args.join(' ')} exited ${String(ran.status)}: ${ran.error?.message ?? told(ran.stdout, ran.stderr)}`)
  return ran.stdout
}

const layout = (root: string, contract: string): Layout => JSON.parse(forge(root, ['inspect', contract, 'storageLayout', '--json'])) as Layout

function entry(root: string, config = join(root, 'medusa.json')): Entry {
  const { fuzzing: { targetContracts = [], deployerAddress = '0x30000', targetContractsBalances: [balance = 0] = [] } = {} } = JSON.parse(readFileSync(config, 'utf8')) as
    { fuzzing?: { targetContracts?: string[]; deployerAddress?: string; targetContractsBalances?: (string | number)[] } }
  if (targetContracts.length !== 1) throw new Error(`medusa.json fuzzing.targetContracts names ${String(targetContracts.length)} contracts; probe readings need exactly one`)
  const [name = ''] = targetContracts
  const dir = join(root, 'test/fizz')
  const declares = new RegExp(`\\bcontract ${name}\\b`)
  const file = readdirSync(dir, { recursive: true, encoding: 'utf8' }).find((p) => p.endsWith('.sol') && declares.test(readFileSync(join(dir, p), 'utf8')))
  if (file === undefined) throw new Error(`no .sol under test/fizz/ declares contract ${name}`)
  return { name, file, deployer: BigInt(deployerAddress), value: BigInt(balance) }
}

const replayed = (sequence: Sequence, i: number): string => `    function testSequence${String(i)}() public {\n${sequence.map(({ call }) => `        replay(address(uint160(${BigInt(call.from).toString()})), hex"${call.data.slice(2)}");\n`).join('')}        logged(address(harness));\n    }\n`

const READERS = `
    function word(address a, uint256 slot, uint256 offset, uint256 size) internal view returns (uint256) {
        uint256 w = uint256(vm.load(a, bytes32(slot))) >> (offset * 8);
        return size == 32 ? w : w & ((1 << (size * 8)) - 1);
    }

    function log(string memory key, uint256 value) internal view returns (bool ok) {
        (ok, ) = CONSOLE.staticcall(abi.encodeWithSignature("log(string,uint256)", key, value));
    }

    function log(string memory key, bool value) internal view returns (bool ok) {
        (ok, ) = CONSOLE.staticcall(abi.encodeWithSignature("log(string,bool)", key, value));
    }
`

const source = (replays: string, reads: string, { name, file, deployer, value }: Entry): string => `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {${name}} from "./${file}";

interface Vm {
    function load(address target, bytes32 slot) external view returns (bytes32);
    function startPrank(address sender) external;
    function deal(address account, uint256 newBalance) external;
    function etch(address target, bytes calldata newRuntimeBytecode) external;
}

contract Deployer { function deploy() external returns (${name} h) { h = new ${name}${value > 0n ? `{value: ${String(value)}}` : ''}(); } }

contract Readings {
    Vm constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);
    address constant CONSOLE = 0x000000000000000000636F6e736F6c652e6c6f67;
    ${name} harness;

    function setUp() public { vm.deal(address(uint160(${String(deployer)})), ${String(value)}); vm.etch(address(uint160(${String(deployer)})), type(Deployer).runtimeCode); harness = Deployer(address(uint160(${String(deployer)}))).deploy(); vm.etch(address(uint160(${String(deployer)})), ""); }

    function replay(address from, bytes memory data) internal returns (bool ok) { vm.startPrank(from); (ok, ) = address(harness).call(data); }

${replays}
    function logged(address h) internal {
        address p;
${reads}    }
${READERS}}
`

const handler = (sequence: Sequence): string => sequence.at(-1)?.call.data.slice(0, 10) ?? ''

function kept(sequences: Sequence[]): Sequence[] {
  const sorted = [...sequences].sort((a, b) => a.length - b.length)
  const firsts = new Map<string, Sequence>()
  for (const s of sorted) if (!firsts.has(handler(s))) firsts.set(handler(s), s)
  const first = new Set(firsts.values())
  return [...first, ...sorted.filter((s) => !first.has(s))].slice(0, CAP)
}

function handed(corpus: string, count: number, total: number): void {
  const file = join(corpus, '../handoff/coverage.md')
  if (!existsSync(file)) return
  const [was, line] = [readFileSync(file, 'utf8'), `replayed: ${String(count)} kept, ${String(total - count)} dropped`]
  writeFileSync(file, REPLAYED.test(was) ? was.replace(REPLAYED, line) : `${was}${/[^\n]$/.test(was) ? '\n' : ''}${line}\n`)
}

const sols = (dir: string): string[] => readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((p) => p.endsWith('.sol'))

function loaded(corpus: string): Sequence[] {
  const dir = join(corpus, 'call_sequences')
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((p) => p.endsWith('.json'))
    .map((p) => JSON.parse(readFileSync(join(dir, p), 'utf8')) as Sequence)
}

function replay(root: string, contract: Entry, sequences: Sequence[], read: (count: number) => string): string {
  const replays = kept(sequences)
  const reads = read(replays.length)
  try {
    const text = source(replays.map(replayed).join(''), reads, contract)
    writeFileSync(join(root, TEST), text)
    return forge(root, ['test', '-vv', '--match-path', TEST], ` on ${TEST}: ${String(Buffer.byteLength(text))} bytes, ${String(replays.length)} of ${String(sequences.length)} sequences`)
  } finally {
    rmSync(join(root, TEST), { force: true })
    rmSync(join(root, 'out/ProbeReadings.t.sol'), { recursive: true, force: true })
  }
}

export function trackers(root: string, corpus: string): Map<string, Value> {
  const contract = entry(root)
  const sequences = loaded(corpus)
  const out = replay(root, contract, sequences, (count) => {
    const probes = suite(root).probes.map((p) => ({ ...p, layout: layout(root, p.name) }))
    const entered = layout(root, contract.name)
    const reads = probes.flatMap((p) => entered.storage.filter((e) => e.type.startsWith(`t_contract(${p.name})`)).flatMap((held) => [
      `        p = address(uint160(word(h, ${held.slot}, ${String(held.offset)}, 20)));\n`,
      ...p.layout.storage.filter((e) => p.trackers.includes(`${p.name}.${e.label}`) && TRACKED.test(e.type)).map((e) => {
        const value = `word(p, ${e.slot}, ${String(e.offset)}, ${p.layout.types[e.type]?.numberOfBytes ?? ''})`
        return `        log("${p.name}.${e.label}=", ${e.type === 't_bool' ? `${value} != 0` : value});\n`
      }),
    ]))
    handed(corpus, count, sequences.length)
    return reads.join('')
  })
  const values = new Map<string, Value>()
  for (const [, name = '', raw = ''] of out.matchAll(LOGGED)) {
    const [was, max] = [values.get(name), bare(name).startsWith('max')]
    if (raw === 'true' || raw === 'false') values.set(name, raw === 'true' || was === true)
    else if (max || bare(name).startsWith('min')) values.set(name, typeof was !== 'bigint' ? BigInt(raw) : (max ? larger : smaller)(was, BigInt(raw)))
  }
  return values
}

/** Medusa's `testViewMethods` still assertion-tests a public view `read_probe*`, so each one is made `internal`. */
export function unprobed(from: string, into: string): void {
  cpSync(from, into, { recursive: true })
  for (const path of sols(into).map((p) => join(into, p))) writeFileSync(path, readFileSync(path, 'utf8').replaceAll('property_probe', 'read_probe').replace(VISIBLE, '$1internal'))
}

export function sampled(db: Db, plan: number, src: string, suite: string): Record<string, string> {
  const dir = join(src, suite)
  const names = [...new Set(sols(dir).flatMap((p) => [...readFileSync(join(dir, p), 'utf8').replace(COMMENT, '').matchAll(PROBE)].map(([, name = '']) => name)))]
  if (names.length === 0) return {}
  const config = join(src, existsSync(join(src, 'medusa.json')) ? '' : suite, 'medusa.json')
  const all = (why: string): Record<string, string> => Object.fromEntries(names.map((n) => [n, `dropped: ${why}`]))
  let out: string
  try {
    const at = (existsSync(config) ? JSON.parse(readFileSync(config, 'utf8')) as { fuzzing?: { corpusDirectory?: string } } : {}).fuzzing?.corpusDirectory ?? ''
    const corpus = resolve(dirname(config), at)
    const sequences = at === '' || !existsSync(join(corpus, 'call_sequences')) ? [] : loaded(corpus)
    if (sequences.length === 0) return all('no corpus')
    out = replay(src, entry(src, config), sequences, () => names.map((n) =>
      `        { (bool ok, bytes memory ret) = h.call(abi.encodeWithSignature("${n}()")); log("probe.${n}=", ok && ret.length == 32 && abi.decode(ret, (bool))); }\n`).join(''))
  } catch (error) {
    logged(db, { plan, kind: 'swallowed', actor: 'score', outcome: 'pass', message: firstLine(error), pointer: null, run: null })
    return all(firstLine(error))
  }
  return Object.fromEntries(names.map((n) => {
    const said = [...out.matchAll(LOGGED)].filter(([, name]) => name === `probe.${n}`).map(([, , raw]) => raw)
    return [n, said.length === 0 ? 'dropped: no reading in forge output' : `true on ${String(said.filter((r) => r === 'true').length)} of ${String(said.length)} sequences`]
  }))
}
