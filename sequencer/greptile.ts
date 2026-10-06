import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { profile } from '../store/profile.ts'
import { repoName } from './workspace.ts'

/** A rehearsal's `greptile.json`: reviews on request only, read against the target's documents and the findings learned on it. */
export function config(root: string, repo: string): string {
  const files = (profile(root, repo)?.greptile_files ?? []).map((path) => ({ path, scope: ['**'] }))
  const rules = [join(root, 'reviews', 'examples'), join(root, '.cf', 'examples')]
    .flatMap((dir) => existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith('.md')).sort().map((f) => readFileSync(join(dir, f), 'utf8')) : [])
    .flatMap((text) => text.split('\n').filter((line) => line.startsWith(`- ${repoName(repo)}#`)))
    .map((line) => ({ rule: line.slice(2), scope: ['**'] }))
  return `${JSON.stringify({ autoReview: [], strictness: 1, customContext: { rules, files } }, null, 2)}\n`
}
