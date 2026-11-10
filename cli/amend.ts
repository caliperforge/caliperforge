import { z } from 'zod'
import { gh, run, type Read, type Run } from './gh.ts'

export function amendIssue(repo: string, no: number, line: string, read: Read = gh, exec: Run = run): void {
  const path = `repos/${repo}/issues/${String(no)}`
  const body = z.object({ body: z.string().nullable() }).parse(read(['api', path])).body ?? ''
  if (!body.includes(line)) exec(['api', '-X', 'PATCH', path, '-f', `body=${body}\n\n${line}`])
}
