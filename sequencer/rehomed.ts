import { cloned, drop, FORK, git, gitBase, maybe, PR_BRANCH, remote, repoName, srcDir, tried } from './workspace.ts'

/** A clone on any branch but `pr.branch` loses its `base.sha`, so `checkout` moves it aside and clones the fork again. */
export function rebranched(root: string, plan: number): void {
  const src = srcDir(root, plan)
  if (cloned(src) && git(src, ['rev-parse', '--abbrev-ref', 'HEAD']).trim() !== maybe(root, plan, PR_BRANCH)?.trim()) drop(root, plan, 'base.sha')
}

/** A clone whose `origin` is missing or not our fork of the plan's repo loses its `base.sha`, so `checkout` moves it aside and clones that fork. */
export function rehomed(root: string, plan: number, repo: string): void {
  const src = srcDir(root, plan)
  if (cloned(src) && tried(src, ['remote', 'get-url', 'origin'])?.trim() !== remote(gitBase(root), `${FORK}/${repoName(repo)}`)) drop(root, plan, 'base.sha')
}
