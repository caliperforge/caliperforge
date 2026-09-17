import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import type { Packet, Refusal } from '../providers/kind.ts'
import { refuse } from './index.ts'
import { tight } from './rules.ts'

const WRITERS = new Set(['Write', 'Edit', 'NotebookEdit', 'Bash', 'MultiEdit'])

const OUTSIDE = /(^|\/)(crypto-contributor|agents|ops|knowledge|plans|escalations)(\/|$)|(^|\/)T-[A-Z][A-Z0-9-]*\.md$/

/** `Bash(gradle:*)` is still Bash: a tool's permission pattern does not change which tool it is. */
function bare(tool: string): string {
  return tool.split('(')[0] ?? tool
}

export const Review = z.object({
  review: z.string(),
  gate: z.enum(['review', 'senior_review']),
  step: z.int().min(4).max(5),
  model: z.string(),
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max']),
  tools: z.array(z.string()).min(1).refine((t) => !t.some((name) => WRITERS.has(bare(name))), {
    message: `a reviewer may not hold ${[...WRITERS].join(', ')}`,
  }),
  write_paths: z.tuple([]),
  reads_verdict: z.boolean(),
}).strict()

export type Review = z.infer<typeof Review>

export const Bench = z.object({
  repo: z.string(),
  issue: z.string(),
  diff: z.string(),
  verdict: z.string().optional(),
}).strict()

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

export function benchPacket(
  root: string,
  name: string,
  input: unknown,
  transcript: string,
): { packet: Packet } | { refusal: Refusal } {
  const manifest = reviewManifest(root, name)
  const bench = Bench.safeParse(input)
  if (!bench.success) return { refusal: shape(named(bench.error)) }
  if ((bench.data.verdict !== undefined) !== manifest.reads_verdict) return { refusal: shape('verdict') }
  const outside = admits(bench.data.repo)
  if (outside !== null) return { refusal: outside }
  return { packet: assembled(root, name, manifest, bench.data, transcript) }
}

function assembled(root: string, name: string, manifest: Review, bench: Bench, transcript: string): Packet {
  const prior = bench.verdict === undefined ? '' : `\n\n# First verdict\n\n${bench.verdict}`
  return {
    prompt: `${tight(root)}\n\n${spec(root, name)}\n\n# Issue\n\n${bench.issue}\n\n# Diff\n\n${bench.diff}${prior}`,
    cwd: bench.repo,
    transcript,
    model: manifest.model,
    effort: manifest.effort,
    tools: manifest.tools,
    refuse: (path) => refuse(bench.repo, manifest.write_paths, path),
  }
}

function named(error: z.ZodError): string {
  return error.issues.map((i) => (i.code === 'unrecognized_keys' ? i.keys.join(', ') : i.path.join('.'))).join(', ')
}

function shape(field: string): Refusal {
  return { origin_kind: 'ruling', origin_ref: 'reviewers.maintainers_view', path: field }
}
