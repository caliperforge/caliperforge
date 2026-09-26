import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import { bare, type Packet, type Refusal } from '../providers/kind.ts'
import { refuse } from './index.ts'
import { tight, WRITERS } from './rules.ts'

const OUTSIDE = /(^|\/)(crypto-contributor|agents|ops|knowledge|plans|escalations)(\/|$)|(^|\/)T-[A-Z][A-Z0-9-]*\.md$/

/** #84: a reviewer judges the packet it was handed. Browsing the checkout is what re-reads the repository it already has. */
export const BROWSE = new Set(['Glob', 'Grep'])

export const Review = z.object({
  review: z.string(),
  gate: z.enum(['review', 'senior_review']),
  step: z.int().min(4).max(5),
  model: z.string(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
  tools: z.array(z.string()).min(1)
    .refine((t) => !t.some((name) => WRITERS.has(bare(name))), {
      message: `a reviewer may not hold ${[...WRITERS].join(', ')}`,
    })
    .refine((t) => !t.some((name) => BROWSE.has(bare(name))), {
      message: `a reviewer judges what it was handed and may not hold ${[...BROWSE].join(', ')}`,
    }),
  write_paths: z.tuple([]),
  reads_verdict: z.boolean(),
}).strict()

export type Review = z.infer<typeof Review>

/** git's account of the plan's diff against the tree a reviewer judged: what it must re-read, and what it may not re-open. */
export const Narrowing = z.object({
  changed: z.array(z.string()),
  merged: z.array(z.string()),
  unchanged: z.array(z.tuple([z.string(), z.string()])),
}).strict()

export type Narrowing = z.infer<typeof Narrowing>

export const Bench = z.object({
  repo: z.string(),
  issue: z.string(),
  diff: z.string(),
  tree: z.string().optional(),
  context: z.string().optional(),
  map: z.string().optional(),
  checks: z.string().optional(),
  verdict: z.string().optional(),
  prior: z.string().optional(),
  refusal: z.string().optional(),
  since: z.string().optional(),
  narrowing: Narrowing.optional(),
}).strict().refine((b) => b.since === undefined || b.prior !== undefined, { path: ['since'] })
  .refine((b) => b.refusal === undefined || b.prior !== undefined, { path: ['refusal'] })

export type Bench = z.infer<typeof Bench>

export function reviewManifest(root: string, name: string): Review {
  return Review.parse(parse(readFileSync(join(root, 'reviews', name, 'manifest.yaml'), 'utf8')))
}

export function spec(root: string, name: string): string {
  return readFileSync(join(root, 'reviews', name, 'spec.md'), 'utf8')
}

export function admits(path: string): Refusal | null {
  if (!OUTSIDE.test(path)) return null
  return { origin_kind: 'ruling', origin_ref: 'reviewers.maintainers_view', path }
}

export const STEP_CAP = 8

/** Past this many changed lines a reviewer gets one more turn per `PER` lines, up to `CAP_MAX`. */
const SMALL = 300
const PER = 100
export const CAP_MAX = 16

/** A reviewer's turns grow with the diff it judges: 8 read a small diff, a 777-line one ran out before its verdict. */
export function stepsFor(diff: string): number {
  const changed = diff.split('\n').filter((l) => /^[+-]/.test(l) && !/^(\+\+\+|---) /.test(l)).length
  return Math.min(CAP_MAX, STEP_CAP + Math.floor(Math.max(0, changed - SMALL) / PER))
}

export function benchPacket(
  root: string,
  name: string,
  input: unknown,
  transcript: string,
): { packet: Packet; bench: Bench } | { refusal: Refusal } {
  const manifest = reviewManifest(root, name)
  const bench = Bench.safeParse(input)
  if (!bench.success) return { refusal: shape(named(bench.error)) }
  if ((bench.data.verdict !== undefined) !== manifest.reads_verdict) return { refusal: shape('verdict') }
  const outside = admits(bench.data.repo)
  if (outside !== null) return { refusal: outside }
  return { packet: assembled(root, name, manifest, bench.data, transcript), bench: bench.data }
}

const MAP = 'The whole diff, for the map. Judge what changed since your last verdict, handed below.'

export function assembled(root: string, name: string, manifest: Review, bench: Bench, transcript: string): Packet {
  const sections: [string, string | undefined][] = [
    ['Changed code in context', framed(bench.context, 'Each hunk inside the function that encloses it. Judge from this and the diff; open a file only for what neither holds.')],
    ['Checks', bench.checks],
    ['Files around the change', framed(bench.map, 'Every file in each touched directory, its length and its head comment; * marks a changed file.')],
    ['First verdict', bench.verdict],
    ['Your last verdict', bench.prior],
    ['Refusal that sent the build back', bench.refusal],
    ['Changed since your last verdict', bench.since],
    ['Paths since your last verdict', statement(bench.narrowing)],
  ]
  const tail = sections.map(([head, body]) => (body === undefined ? '' : `\n\n# ${head}\n\n${body}`)).join('')
  const diff = (bench.since === undefined ? undefined : framed(bench.diff, MAP)) ?? bench.diff
  return {
    prompt: `${tight(root)}\n\n${spec(root, name)}\n\n# Issue\n\n${bench.issue}\n\n# Diff\n\n${diff}${tail}`,
    cwd: bench.repo,
    transcript,
    model: manifest.model,
    effort: manifest.effort,
    tools: manifest.tools,
    steps: stepsFor(bench.diff),
    refuse: (path) => refuse(bench.repo, manifest.write_paths, path),
  }
}

function framed(body: string | undefined, lead: string): string | undefined {
  return body === undefined ? undefined : `${lead}\n\n${body}`
}

function statement(n: Narrowing | undefined): string | undefined {
  if (n === undefined) return undefined
  const lists: [string, string[]][] = [
    ['changed since the tree you judged', n.changed],
    ["merged from main, not the builder's", n.merged],
    ['unchanged since you judged it, at the blob it had then', n.unchanged.map(([path, blob]) => `${path} ${blob}`)],
  ]
  return lists.map(([head, paths]) => `${head}:\n${listed(paths)}`).join('\n\n')
}

function listed(paths: string[]): string {
  return paths.length === 0 ? '  - none' : paths.map((path) => `  - ${path}`).join('\n')
}

function named(error: z.ZodError): string {
  return error.issues.map((i) => (i.code === 'unrecognized_keys' ? i.keys.join(', ') : i.path.join('.'))).join(', ')
}

function shape(field: string): Refusal {
  return { origin_kind: 'ruling', origin_ref: 'reviewers.maintainers_view', path: field }
}
