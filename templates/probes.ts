import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { ProbeReadings } from './reach.ts'
import { type Suite, suite } from './suite.ts'

type Value = bigint | boolean

interface Layout { storage: { label: string; slot: string; offset: number; type: string }[]; types: Record<string, { numberOfBytes: string }> }

type Sequence = { call: { from: string; data: string } }[]

interface Entry { name: string; file: string }

const TEST = 'test/fizz/ProbeReadings.t.sol'
const TRACKED = /^t_(?:uint\d+|bool)$/
const LOGGED = /^\s*(\w+\.\w+)= (\d+|true|false)$/gm
const TAIL = 2000
const WALL = 10 * 60 * 1000
const CAP = 50
const REPLAYED = /^replayed: .*$/m

const bare = (tracker: string): string => tracker.slice(tracker.indexOf('.') + 1)

const larger = (a: bigint, b: bigint): bigint => a > b ? a : b

const smaller = (a: bigint, b: bigint): bigint => a < b ? a : b

export function readings(probes: Suite['probes'], values: Map<string, Value>): ProbeReadings {
  const read: ProbeReadings = { limits: {}, conversions: {} }
  for (const cite of new Set(probes.flatMap((p) => p.cites ?? []))) {
    const seen = probes.filter((p) => p.cites === cite).flatMap((p) => p.trackers).flatMap((t) => { const v = values.get(t); return v === undefined ? [] : [{ t: bare(t), v }] })
    const ints = (prefix: string): bigint[] => seen.flatMap(({ t, v }) => typeof v === 'bigint' && t.startsWith(prefix) ? [v] : [])
    const [maxes, mins, saws] = [ints('max'), ints('min'), seen.flatMap(({ v }) => typeof v === 'boolean' ? [v] : [])]
    const max = maxes.reduce(larger, 0n)
    if (mins.length + saws.length === 0) read.limits[cite] = { max }
    else read.conversions[cite] = { min: mins.length === 0 ? 0n : mins.reduce(smaller), max, saw1Wei: saws.includes(true) }
  }
  return read
}

function forge(root: string, args: string[], held = ''): string {
  const ran = spawnSync('forge', args, { cwd: root, encoding: 'utf8', env: { ...process.env, FOUNDRY_PROFILE: 'fuzz' }, timeout: WALL })
  if ((ran.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT') throw new Error(`forge ${args.join(' ')} passed the ${String(WALL)} ms wall clock${held}`)
  if (ran.status !== 0) throw new Error(`forge ${args.join(' ')} exited ${String(ran.status)}: ${ran.error?.message ?? ran.stderr.slice(-TAIL)}`)
  return ran.stdout
}

const layout = (root: string, contract: string): Layout => JSON.parse(forge(root, ['inspect', contract, 'storageLayout', '--json'])) as Layout

function entry(root: string): Entry {
  const { fuzzing: { targetContracts = [] } = {} } = JSON.parse(readFileSync(join(root, 'medusa.json'), 'utf8')) as { fuzzing?: { targetContracts?: string[] } }
  if (targetContracts.length !== 1) throw new Error(`medusa.json fuzzing.targetContracts names ${String(targetContracts.length)} contracts; probe readings need exactly one`)
  const [name = ''] = targetContracts
  const dir = join(root, 'test/fizz')
  const declares = new RegExp(`\\bcontract ${name}\\b`)
  const file = readdirSync(dir, { recursive: true, encoding: 'utf8' }).find((p) => p.endsWith('.sol') && declares.test(readFileSync(join(dir, p), 'utf8')))
  if (file === undefined) throw new Error(`no .sol under test/fizz/ declares contract ${name}`)
  return { name, file }
}

const replayed = (sequence: Sequence, i: number): string => `    function testSequence${String(i)}() public {\n${sequence.map(({ call }) => `        vm.prank(address(uint160(${BigInt(call.from).toString()})));\n`
  + `        address(harness).call(hex"${call.data.slice(2)}");\n`).join('')}        logged(address(harness));\n    }\n`

const source = (replays: string, reads: string, { name, file }: Entry): string => `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {${name}} from "./${file}";

interface Vm {
    function load(address target, bytes32 slot) external view returns (bytes32);
    function prank(address sender) external;
}

contract Readings {
    Vm constant vm = Vm(0x7109709ECfa91a80626fF3989D68f67F5b1DD12D);
    address constant CONSOLE = 0x000000000000000000636F6e736F6c652e6c6f67;
    ${name} harness;

    function setUp() public { harness = new ${name}(); }

${replays}
    function logged(address h) internal view {
        address p;
${reads}    }

    function word(address a, uint256 slot, uint256 offset, uint256 size) internal view returns (uint256) {
        uint256 w = uint256(vm.load(a, bytes32(slot))) >> (offset * 8);
        return size == 32 ? w : w & ((1 << (size * 8)) - 1);
    }

    function log(string memory key, uint256 value) internal view {
        CONSOLE.staticcall(abi.encodeWithSignature("log(string,uint256)", key, value));
    }

    function log(string memory key, bool value) internal view {
        CONSOLE.staticcall(abi.encodeWithSignature("log(string,bool)", key, value));
    }
}
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

export function trackers(root: string, corpus: string): Map<string, Value> {
  const contract = entry(root)
  const dir = join(corpus, 'call_sequences')
  const sequences = readdirSync(dir, { recursive: true, encoding: 'utf8' }).filter((p) => p.endsWith('.json'))
    .map((p) => JSON.parse(readFileSync(join(dir, p), 'utf8')) as Sequence)
  const replays = kept(sequences)
  const probes = suite(root).probes.map((p) => ({ ...p, layout: layout(root, p.name) }))
  const entered = layout(root, contract.name)
  const reads = probes.flatMap((p) => entered.storage.filter((e) => e.type.startsWith(`t_contract(${p.name})`)).flatMap((held) => [
    `        p = address(uint160(word(h, ${held.slot}, ${String(held.offset)}, 20)));\n`,
    ...p.layout.storage.filter((e) => p.trackers.includes(`${p.name}.${e.label}`) && TRACKED.test(e.type)).map((e) => {
      const value = `word(p, ${e.slot}, ${String(e.offset)}, ${p.layout.types[e.type]?.numberOfBytes ?? ''})`
      return `        log("${p.name}.${e.label}=", ${e.type === 't_bool' ? `${value} != 0` : value});\n`
    }),
  ]))
  handed(corpus, replays.length, sequences.length)
  let out: string
  try {
    const text = source(replays.map(replayed).join(''), reads.join(''), contract)
    writeFileSync(join(root, TEST), text)
    out = forge(root, ['test', '-vv', '--match-path', TEST], ` on ${TEST}: ${String(Buffer.byteLength(text))} bytes, ${String(replays.length)} of ${String(sequences.length)} sequences`)
  } finally {
    rmSync(join(root, TEST), { force: true })
    rmSync(join(root, 'out/ProbeReadings.t.sol'), { recursive: true, force: true })
  }
  const values = new Map<string, Value>()
  for (const [, name = '', raw = ''] of out.matchAll(LOGGED)) {
    const [was, max] = [values.get(name), bare(name).startsWith('max')]
    if (raw === 'true' || raw === 'false') values.set(name, raw === 'true' || was === true)
    else if (max || bare(name).startsWith('min')) values.set(name, typeof was !== 'bigint' ? BigInt(raw) : (max ? larger : smaller)(was, BigInt(raw)))
  }
  return values
}
