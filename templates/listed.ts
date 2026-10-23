import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { git, gitBase, maybe, planDir, remote } from '../sequencer/workspace.ts'

const LISTED = /^files:[ \t]*(?:[^\s[]|\[[ \t]*[^\s\]]|\n[ \t]+-[ \t]*\S)/m

const UNLISTED = /^files:[ \t]*(?:\[[ \t]*\])?[ \t]*$/m

/** The yml at `upstream` with its files list, or with the paths the fix in checkout.json touches written in; null when neither names one. */
export function listedIn(root: string, id: number, upstream: string): string | null {
  const yml = readFileSync(upstream, 'utf8')
  if (LISTED.test(yml)) return yml
  const files = changed(root, id)
  if (files.length === 0) return null
  const line = `files: [${files.join(', ')}]`
  const written = UNLISTED.test(yml) ? yml.replace(UNLISTED, line) : `${yml.trimEnd()}\n${line}\n`
  writeFileSync(upstream, written)
  return written
}

function changed(root: string, id: number): string[] {
  const { repo = '', fix = '', pre_fix: preFix = '' } = JSON.parse(maybe(root, id, 'checkout.json') ?? '{}') as Record<string, string | undefined>
  if (repo === '' || fix === '' || preFix === '') return []
  return inBare(planDir(root, id), remote(gitBase(root), repo), [preFix, fix],
    (bare) => git(bare, ['diff', '--name-only', preFix, fix]).split('\n').filter((path) => path !== ''))
}

/** `use` on a bare clone of `url` holding each rev that starts with a full sha, so src/ never fetches the fix step 0 refuses there. */
export function inBare<T>(plan: string, url: string, revs: string[], use: (bare: string) => T): T {
  const bare = join(plan, 'resolve.git')
  rmSync(bare, { recursive: true, force: true })
  try {
    git(plan, ['clone', '--bare', '-q', url, bare])
    for (const rev of revs) {
      const sha = /^[0-9a-f]{40}/.exec(rev)?.[0]
      if (sha !== undefined) git(bare, ['fetch', '-q', url, sha])
    }
    return use(bare)
  } finally {
    rmSync(bare, { recursive: true, force: true })
  }
}
