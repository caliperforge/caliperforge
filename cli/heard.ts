import { z } from 'zod'
import { gh, WINDOW, type Read } from './gh.ts'

const Posts = z.array(z.object({ user: z.object({ login: z.string() }).nullable(), created_at: z.string() }))

export function heard(fork: string, read: Read = gh): string | null {
  return Posts.parse(read(['api', `repos/${fork}/issues/comments?sort=created&direction=desc&per_page=${String(WINDOW)}`]))
    .find((p) => p.user?.login === 'greptile-apps[bot]')?.created_at ?? null
}
