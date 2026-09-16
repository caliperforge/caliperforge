import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parse } from 'yaml'
import { z } from 'zod'
import type { Check, Finding } from './kind.ts'
import { walk } from './tree.ts'

const StepList = z.array(z.object({
  step: z.int().min(0).max(9),
  seat: z.string(),
  gate: z.boolean(),
  writes_verdict: z.boolean(),
})).min(1)

const Roster = z.object({ seats: z.array(z.string()) })

export const templateValidity: Check = {
  name: 'template-validity',
  run: (root: string) => findings(root),
}

async function findings(root: string): Promise<Finding[]> {
  const files = walk(join(root, 'templates'), (f) => f.endsWith('.ts'))
  const seats = new Set(roster(root))
  const out: Finding[] = []
  for (const file of files) out.push(...await inFile(root, file, seats))
  return out
}

async function inFile(root: string, file: string, seats: Set<string>): Promise<Finding[]> {
  const path = file.slice(root.length + 1)
  const module = await import(pathToFileURL(file).href) as { steps?: unknown }
  const parsed = StepList.safeParse(module.steps)
  if (!parsed.success) return [finding(path, parsed.error.issues.map((i) => i.message).join('; '))]
  return [...unknownSeats(parsed.data, seats, path), ...gateless(parsed.data, path), ...order(parsed.data, path)]
}

function unknownSeats(steps: z.infer<typeof StepList>, seats: Set<string>, path: string): Finding[] {
  return steps.filter((s) => !seats.has(s.seat)).map((s) => finding(path, `step ${String(s.step)} names seat "${s.seat}", absent from the roster`))
}

function gateless(steps: z.infer<typeof StepList>, path: string): Finding[] {
  return steps.filter((s) => s.gate && !s.writes_verdict).map((s) => finding(path, `gate step ${String(s.step)} writes no verdict`))
}

function order(steps: z.infer<typeof StepList>, path: string): Finding[] {
  if (!path.includes('pr_path')) return []
  const want = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].join(',')
  return steps.map((s) => s.step).join(',') === want ? [] : [finding(path, 'pr_path steps are not 0-9 in order')]
}

function roster(root: string): string[] {
  const path = join(root, 'rules/roster.yaml')
  return existsSync(path) ? Roster.parse(parse(readFileSync(path, 'utf8'))).seats : []
}

function finding(path: string, message: string): Finding {
  return { check: 'template-validity', path, line: 1, message }
}
