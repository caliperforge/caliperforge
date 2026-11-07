import { OPERATOR } from '../sequencer/workspace.ts'
import { gh, issueComments, type Read, run, type Run } from './gh.ts'

export function reopenIssue(repo: string, no: number, read: Read = gh, exec: Run = run): void {
  exec(['issue', 'reopen', String(no), '--repo', repo])
  for (const c of issueComments(repo, no, read)) {
    if (c.author.login !== OPERATOR || !c.body.startsWith('landed on main as ')) continue
    const id = /#issuecomment-(\d+)$/.exec(c.url)?.[1]
    if (id === undefined) throw new Error(`${c.url} names no issue comment`)
    exec(['api', '-X', 'DELETE', `repos/${repo}/issues/comments/${id}`])
  }
}
