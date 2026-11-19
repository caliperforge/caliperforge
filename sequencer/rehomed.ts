import { cloned, drop, FORK, git, gitBase, maybe, planDir, PR_BRANCH, remote, repoName, srcDir, tried } from './workspace.ts'

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

/** A plan not yet cut whose fork lists no heads; a missing or unreachable fork reads as not empty, and `checkout` meets it as before. */
export function empty(root: string, plan: number, repo: string): boolean {
  return maybe(root, plan, 'base.sha') === null
    && tried(planDir(root, plan), ['ls-remote', '--heads', remote(gitBase(root), `${FORK}/${repoName(repo)}`)]) === ''
}
