import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative } from 'node:path'
import { scoredSuite } from '../cli/bench.ts'
import { firstLine } from '../sequencer/unpolled.ts'
import { planDir } from '../sequencer/workspace.ts'
import { logged } from '../store/events.ts'
import type { Db } from '../store/index.ts'
import { unproven } from './bench.ts'
import { critic } from './critic.ts'
import { compiled, extract } from './extract.ts'
import { fixed, graded, type Phase, type Touched } from './graded.ts'
import { handoff, ranged, type Refused } from './handoff.ts'
import { drawn, suited } from './map.ts'
import { duplicated, planned } from './plan.ts'
import { readings, trackers } from './probes.ts'
import { type Item, met, misread, type ProbeReadings, reach, unlocated, unmet, written } from './reach.ts'
import { callee, rows } from './slices.ts'
import { smoke, unrun } from './smoke.ts'
import { harnessed, probed, suite } from './suite.ts'

const META = 'test/fizz/fizz_data'

const KEPT = ['handoff', 'entry-point-selection.json']

const BUILT = ['out', 'cache']

const ENTRY = 'Selected entry points '

type Row = [phase: string, check: string, result: () => string]

interface Copy { db: Db; plan: number; dir: string; skill: string; fizz: string; handoffs: string; map: string; fix: () => Touched | string }

const read = (path: string): string => existsSync(path) ? readFileSync(path, 'utf8') : ''

const guarded = ({ db, plan, dir }: Copy, needs: string[], run: () => string) => (): string => {
  const missing = needs.find((path) => !existsSync(path))
  if (missing !== undefined) return `cannot run: needs ${relative(dir, missing)}`
  try {
    return run()
  } catch (error) {
    logged(db, { plan, kind: 'swallowed', actor: 'bench', outcome: 'pass', message: firstLine(error), pointer: null, run: null })
    return `refuse throw | ${firstLine(error)}`
  }
}

const checked = (at: Copy, needs: string[], run: () => Refused[]): (() => string) => guarded(at, needs, () => {
  const refused = run()
  return refused.length === 0 ? 'pass' : `refuse ${[...new Set(refused.map((r) => r.rule))].join(', ')} | ${[...new Set(refused.map((r) => r.note))].join('; ')}`
})

const grade = (at: Copy, phase: string, kind: Phase, needs: string[]): Row => [phase, 'grade', guarded(at, needs, () => {
  const t = at.fix()
  return typeof t === 'string' ? t : graded(kind, at.dir, t)
})]

const handed = (at: Copy, phase: string): Row => {
  const path = join(at.handoffs, `${phase}.md`)
  return [phase, 'handoff', checked(at, [path], () => handoff(at.skill, phase, read(path)))]
}

function context(at: Copy): Row[] {
  const { dir, handoffs, map } = at
  const selection = join(handoffs, '../entry-point-selection.json')
  return [handed(at, 'context'), ['context', 'ast', checked(at, [], () => compiled(dir))], grade(at, 'context', 'context', []), ['context', 'map', checked(at, [selection], () => {
    const extracted = extract(dir)
    const text = drawn(extracted, readFileSync(selection, 'utf8'), read(map))
    writeFileSync(map, text)
    return ranged(dir, text, extracted)
  })]]
}

function scaffold(at: Copy): Row[] {
  const { dir, fizz, map } = at
  return [handed(at, 'scaffold'), ['scaffold', 'ast', checked(at, [], () => compiled(dir, 'scaffold'))],
    ['scaffold', 'layer', () => 'cannot run: needs the map as the phase found it'],
    ['scaffold', 'suite', checked(at, [], () => {
      const found = suite(dir)
      writeFileSync(map, suited(found, read(map)))
      return [...harnessed(found, read(map)), ...probed(found, read(map))]
    })],
    grade(at, 'scaffold', 'suite', [join(dir, 'test/fizz/handlers'), join(dir, 'test/fizz/Properties.sol')]),
    ['scaffold', 'smoke', () => {
      let note = null as string | null
      const row = checked(at, [], () => {
        const got = smoke(dir, fizz, META, read(map))
        if ('rule' in got) return [got]
        note = got.cache === null ? got.note : `slither cache ${got.cache}`
        return unrun(read(map), got.results)
      })()
      return note === null ? row : `${row} | ${note}`
    }],
    ['scaffold', 'critic.stand_in', checked(at, [], () => critic(join(fizz, 'references/critic-pass.md'), dir, 'critic.stand_in'))]]
}

function coverage(at: Copy): Row[] {
  const { dir, handoffs, map } = at
  const corpus = join(handoffs, '../corpus_medusa')
  const [sequences, lcov, report] = [join(corpus, 'call_sequences'), join(corpus, 'coverage/lcov.info'), join(corpus, 'coverage/revert_report.json')]
  let [probes, items]: [ProbeReadings | undefined, Item[] | undefined] = [undefined, undefined]
  const probing = (): ProbeReadings => probes ??= readings(suite(dir).probes, trackers(dir, corpus))
  const reached = (): Item[] => items ??= reach(dir, read(map), lcov, report, probing())
  return [handed(at, 'coverage'), ['coverage', 'probe readings', checked(at, [sequences], () => { probing(); return [] })],
    ['coverage', 'reach', checked(at, [lcov, report, sequences], () => {
      writeFileSync(map, written(read(map), reached()))
      return [...unlocated(reached()), ...misread(reached()), ...unmet(read(map), reached()).map((i) => ({ rule: 'reach.unmet', note: i.note }))]
    })],
    ['coverage', 'boundary', checked(at, [lcov, report, sequences], () => [...unlocated(reached()), ...misread(reached()),
      ...met(read(map), reached()).reasons.map((note) => ({ rule: 'reach.boundary', note }))])],
    grade(at, 'coverage', 'coverage', [join(handoffs, 'coverage.md'), lcov])]
}

function invariants(at: Copy): Row[] {
  const { dir, fizz, handoffs, map } = at
  const [plan, reports] = [join(handoffs, 'plan.md'), join(handoffs, '../reports')]
  const [global, specific] = [join(reports, 'invariants-global-property-implementer.md'), join(reports, 'invariants-specific-property-implementer.md')]
  return [handed(at, 'invariants'), ['invariants', 'plan', checked(at, [plan], () => {
    const found = suite(dir)
    const unreached = (rows(read(map)).get('Reach') ?? []).filter((r) => r.name.startsWith(ENTRY) && r.cells.get('met') === 'no').map((r) => callee(r.name.slice(ENTRY.length)))
    return planned(read(plan), read(map), [...found.trackers, ...found.handlers].map((t) => t.name), unreached).refused
  })],
  ['invariants', 'duplicate', checked(at, [global, specific], () => duplicated(read(global), read(specific)))],
  ['invariants', 'critic.share_converted', checked(at, [], () => critic(join(fizz, 'references/critic-pass.md'), dir, 'critic.share_converted'))]]
}

function counted(dir: string): Refused[] {
  const proven = unproven(join(dir, 'test/fizz'), 'dry')
  return typeof proven === 'number' ? [] : proven.spans.map((rule) => ({ rule, note: proven.note }))
}

function laid(src: string, dir: string, suites: string): void {
  const kept = join(suites, 'root')
  rmSync(join(dir, 'test/fizz'), { recursive: true, force: true })
  cpSync(suites, join(dir, 'test/fizz'), { recursive: true, filter: (from) => from !== kept })
  if (existsSync(kept)) cpSync(kept, dir, { recursive: true })
  for (const name of KEPT.filter((name) => existsSync(join(src, META, name)))) {
    rmSync(join(dir, META, name), { recursive: true, force: true })
    cpSync(join(src, META, name), join(dir, META, name), { recursive: true })
  }
}

function cleared(dir: string): void {
  for (const name of readdirSync(dir).filter((name) => !BUILT.includes(name))) rmSync(join(dir, name), { recursive: true, force: true })
}

export function dried(db: Db, root: string, plan: number, fizz: string, scored?: number): string {
  const suites = scored === undefined ? null : scoredSuite(db, root, scored).suites
  const src = [`${join(planDir(root, plan), 'src')}.stopped`, join(planDir(root, plan), 'src')].find((path) => existsSync(path))
  if (src === undefined) throw new Error(`plan ${String(plan)} has no checkout`)
  const dir = join(root, '.cf/dry', String(plan))
  mkdirSync(dir, { recursive: true })
  cleared(dir)
  try {
    cpSync(src, dir, { recursive: true, filter: (from) => !BUILT.some((name) => from === join(src, name) && existsSync(join(dir, name))) })
    if (suites !== null) laid(src, dir, suites)
    const handoffs = join(dir, META, 'handoff')
    let t: Touched | string | undefined
    const at = { db, plan, dir, skill: join(root, 'seats/fizz_lean_generator/skill'), fizz, handoffs, map: join(handoffs, 'map.md'), fix: () => t ??= fixed(root, plan, dir) }
    const table = [...context(at), ...scaffold(at), ...coverage(at), ...invariants(at), ['end', 'count', checked(at, [], () => counted(dir))] satisfies Row]
      .map(([phase, check, result]) => [phase, check, result()] as const)
    const heading = scored === undefined ? `plan ${String(plan)}` : `plan ${String(plan)} with plan ${String(scored)}'s suite`
    logged(db, { plan, kind: 'bench.dry', actor: 'bench', outcome: table.some(([, , result]) => result.startsWith('refuse')) ? 'refuse' : 'pass', message: heading, pointer: null, run: null })
    return `${heading}\n${table.map((row) => `${row.join('\t')}\n`).join('')}`
  } finally {
    cleared(dir)
  }
}
