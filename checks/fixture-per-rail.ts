import { join } from 'node:path'
import type { Check, Finding } from './kind.ts'
import { subdirs, walk } from './tree.ts'

export const fixturePerRail: Check = {
  name: 'fixture-per-rail',
  run: (root: string) => Promise.resolve(findings(root)),
}

function findings(root: string): Finding[] {
  return subdirs(join(root, 'rails'))
    .filter((rail) => walk(join(root, 'rails', rail, 'tests'), () => true).length === 0)
    .map((rail) => ({
      check: 'fixture-per-rail',
      path: `rails/${rail}/tests`,
      line: 1,
      message: `rail "${rail}" has no fixture`,
    }))
}
