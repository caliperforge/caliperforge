import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { git, gitBase, maybe, planDir, remote } from '../sequencer/workspace.ts'
import { fields } from './bench.ts'
import { type At, type Extracted, extract } from './extract.ts'
import { inBare } from './listed.ts'
import { covered } from './reach.ts'

export interface Touched { functions: (At & { name: string })[]; state: string[] }

export type Phase = 'context' | 'suite' | 'coverage'

type Half = [kind: 'functions' | 'state', names: string[], hit: string[]]

interface Changed { ranges: [number, number][]; text: string[] }

const HANDOFF = 'test/fizz/fizz_data/handoff'
const LCOV = 'test/fizz/fizz_data/corpus_medusa/coverage/lcov.info'
const HUNK = /^@@ -(\d+)(?:,(\d+))? /
const GETTER = /\bfunction\s+(\w+)([\s\S]*?)(?=\bfunction\b|$)/g
const BLOCK = /^files:[ \t]*\n((?:[ \t]+-[ \t]*\S.*(?:\n|$))+)/m
const INERT = /\/\*[\s\S]*?\*\/|\/\/.*|"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g

const read = (path: string): string => existsSync(path) ? readFileSync(path, 'utf8') : ''

const bare = (name: string): string => name.slice(name.lastIndexOf('.') + 1)

const named = (text: string, names: string[]): string[] => names.filter((name) => new RegExp(`\\b${bare(name)}\\b`).test(text))

const called = (text: string, name: string): boolean => new RegExp(`\\.${bare(name)}\\s*(?:\\{[^{}]*\\}\\s*)?\\(`).test(text)

function range(hunk: string): [number, number] {
  const [, a = '0', b = '1'] = HUNK.exec(hunk) ?? []
  return [Number(a), Number(a) + Math.max(Number(b), 1) - 1]
}

function changes(diff: string): Map<string, Changed> {
  return new Map(diff.split(/^diff --git /m).slice(1).map((chunk): [string, Changed] => {
    const lines = chunk.split('\n')
    const body = lines.findIndex((line) => line.startsWith('@@'))
    const [head, hunks] = body === -1 ? [lines, []] : [lines.slice(0, body), lines.slice(body)]
    const [pre = '', post = ''] = ['--- ', '+++ '].map((side) => head.find((line) => line.startsWith(side))?.slice(4) ?? '')
    return [(pre === '/dev/null' ? post : pre).slice(2), { ranges: hunks.filter((line) => line.startsWith('@@')).map(range), text: hunks.filter((line) => /^[+-]/.test(line)).map((line) => line.slice(1)) }]
  }))
}

export function touched(diff: string, extracted: Extracted): Touched {
  const files = changes(diff)
  const hit = ({ file, start, end }: At): boolean => files.get(file)?.ranges.some(([from, to]) => from <= end && to >= start) === true
  return {
    functions: extracted.signatures.filter(hit).map(({ file, start, end, name }) => ({ file, start, end, name })),
    state: extracted.state.filter((v) => !v.constant && files.has(v.file) && (hit(v) || named(files.get(v.file)?.text.join('\n') ?? '', [v.name]).length > 0)).map((v) => v.name),
  }
}

export function listed(yml: string): string[] {
  const block = BLOCK.exec(yml)?.[1]
  const items = block === undefined ? (fields(yml).files ?? '').replace(/^\[(.*)\]$/, '$1').split(',') : block.split('\n').map((line) => line.replace(/^\s*-/, ''))
  return items.map((item) => item.trim()).filter((item) => item !== '')
}

export function fixed(root: string, plan: number, dir: string): Touched | string {
  const yml = maybe(root, plan, 'target.yml') ?? ''
  const { repo = '', fix = '', pre_fix: preFix = '' } = fields(yml)
  if (fix === '' || preFix === '') return 'cannot run: target.yml has no fix'
  const files = listed(yml)
  if (repo === '') return 'cannot run: target.yml has no repo'
  if (files.length === 0) return 'cannot run: target.yml has no files'
  return touched(inBare(planDir(root, plan), remote(gitBase(root), repo), [preFix, fix], (bare) => git(bare, ['diff', '-U0', preFix, fix, '--', ...files])), extract(dir))
}

function halves(phase: Phase, dir: string, { functions, state }: Touched): Half[] {
  const names = functions.map((f) => f.name)
  if (phase === 'context') {
    const text = `${read(join(dir, HANDOFF, 'context.md'))}\n${read(join(dir, HANDOFF, 'map.md'))}`
    return [['functions', names, named(text, names)], ['state', state, named(text, state)]]
  }
  if (phase === 'coverage') {
    const hits = covered(read(join(dir, LCOV)))
    return [['functions', names, functions.filter((f) => [...hits(f.file)].some(([line, n]) => n > 0 && line >= f.start && line <= f.end)).map((f) => f.name)]]
  }
  const handlers = join(dir, 'test/fizz/handlers')
  const texts = readdirSync(handlers, { recursive: true, encoding: 'utf8' }).filter((p) => p.endsWith('.sol')).map((p) => readFileSync(join(handlers, p), 'utf8'))
  const properties = read(join(dir, 'test/fizz/Properties.sol'))
  const getters = texts.flatMap((text) => [...text.matchAll(GETTER)]).filter(([, name = '']) => named(properties, [name]).length > 0).map(([, , body = '']) => body)
  const stripped = texts.map((text) => text.replace(INERT, ''))
  return [['functions', names, names.filter((name) => stripped.some((text) => called(text, name)))], ['state', state, named([properties, ...getters].join('\n'), state)]]
}

export function graded(phase: Phase, dir: string, t: Touched): string {
  const split = halves(phase, dir, t)
  const kept = split.filter(([, names]) => names.length > 0)
  if (kept.length === 0) return `cannot run: the fix touches no ${split.map(([kind]) => kind).join(' or ')}`
  const missed = kept.find(([, , hit]) => hit.length === 0)
  return missed === undefined ? `hit ${kept.flatMap(([, , hit]) => hit).join(', ')}` : `miss: ${phase} names none of ${missed[1].join(', ')}`
}
