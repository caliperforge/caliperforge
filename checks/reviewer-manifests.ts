import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { Review } from '../runner/packet.ts'
import type { Check, Finding } from './kind.ts'
import { subdirs } from './tree.ts'

/** A reviewer manifest the schema refuses is otherwise found when a job fires, four steps in and paid for. */
export const reviewerManifests: Check = {
  name: 'reviewer-manifests',
  run: (root: string) => Promise.resolve(findings(root)),
}

function findings(root: string): Finding[] {
  return subdirs(join(root, 'reviews')).flatMap((name) => {
    const path = join('reviews', name, 'manifest.yaml')
    const read = Review.safeParse(parse(readFileSync(join(root, path), 'utf8')))
    if (read.success) return []
    return read.error.issues.map((i) => ({
      check: 'reviewer-manifests', path, line: 1,
      message: `${i.path.join('.') || 'manifest'}: ${i.message}`,
    }))
  })
}
