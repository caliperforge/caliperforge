import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'

export const Profile = z.strictObject({
  /** Per language, the `Gate.script` names `gates()` returns for it, in order. */
  checks: z.record(z.string(), z.array(z.string())).optional(),
  commit: z.string().optional(),
  pr: z.string().optional(),
  intake: z.string().optional(),
  notes: z.array(z.string()).optional(),
  sources: z.array(z.string()).optional(),
  subject: z.enum(['conventional', 'package']).optional(),
  issue_ref: z.literal('Fixes').optional(),
  ai_trailer: z.boolean().optional(),
  trailer: z.string().optional(),
  disclosure: z.string().optional(),
})

export type Profile = z.infer<typeof Profile>

/** An outside repo's rules: its owner's `_org.yml` with each field its own file sets laid over whole. */
export function profile(root: string, repo: string): Profile | null {
  const [owner = '', name = ''] = repo.split('/')
  const org = read(join(root, 'profiles', owner, '_org.yml'))
  const own = read(join(root, 'profiles', owner, `${name}.yml`))
  return org === null && own === null ? null : { ...org, ...own }
}

function read(path: string): Profile | null {
  if (!existsSync(path)) return null
  const found = Profile.safeParse(parse(readFileSync(path, 'utf8')))
  if (!found.success) throw new Error(`${path}: ${found.error.message}`)
  return found.data
}
