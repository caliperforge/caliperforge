import { fixturePerRail } from './fixture-per-rail.ts'
import type { Check, Finding } from './kind.ts'
import { originOnRefuse } from './origin-on-refuse.ts'
import { reachability } from './reachability.ts'
import { reviewerNotBuilder } from './reviewer-not-builder.ts'
import { ruleHashes } from './rule-hashes.ts'
import { templateValidity } from './template-validity.ts'
import { tight } from './tight.ts'

export const CHECKS: Check[] = [
  reachability,
  originOnRefuse,
  ruleHashes,
  tight,
  templateValidity,
  reviewerNotBuilder,
  fixturePerRail,
]

export async function runAll(root: string, only?: string): Promise<Finding[]> {
  const selected = only === undefined ? CHECKS : CHECKS.filter((c) => c.name === only)
  const results = await Promise.all(selected.map((c) => c.run(root)))
  return results.flat()
}
