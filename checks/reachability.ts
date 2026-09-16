import { join } from 'node:path'
import type { Check, Finding } from './kind.ts'
import { manifest } from './manifest.ts'
import { subdirs } from './tree.ts'

export const reachability: Check = {
  name: 'reachability',
  run: (root: string) => Promise.resolve(findings(root)),
}

function findings(root: string): Finding[] {
  const listed = new Set(manifest(root).rails)
  const present = new Set(subdirs(join(root, 'rails')))
  return [
    ...[...present].filter((d) => !listed.has(d)).map((d) => orphan(d, 'rails/', 'rules/rails.yaml')),
    ...[...listed].filter((e) => !present.has(e)).map((e) => orphan(e, 'rules/rails.yaml', 'rails/')),
  ]
}

function orphan(rail: string, where: string, missing: string): Finding {
  return {
    check: 'reachability',
    path: `${where}${rail}`,
    line: 1,
    message: `rail "${rail}" is in ${where} and absent from ${missing}`,
  }
}
