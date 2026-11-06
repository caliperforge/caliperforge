import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'
import { planDir } from '../sequencer/workspace.ts'
import { LANES } from './lanes.ts'

export const Profile = z.strictObject({
  /** Per language, the `Gate.script` names `gates()` returns for it, in order. */
  checks: z.record(z.string(), z.array(z.string())).optional(),
  commit: z.string().optional(),
  signed: z.boolean().optional(),
  pr: z.string().optional(),
  intake: z.strictObject({
    claim_first: z.boolean().default(false),
    max_open_prs: z.int().optional(),
    pace: z.strictObject({ prs: z.int(), days: z.int() }).optional(),
  }).optional(),
  notes: z.array(z.string()).optional(),
  sources: z.array(z.string()).optional(),
  subject: z.enum(['conventional', 'package']).optional(),
  issue_ref: z.literal('Fixes').optional(),
  ai_trailer: z.boolean().optional(),
  trailer: z.string().optional(),
  disclosure: z.string().optional(),
  builder: z.string().optional(),
  lane: z.enum(LANES).optional(),
  rails: z.strictObject({
    digests: z.boolean().default(false),
    ratchet: z.boolean().default(false),
    fence: z.boolean().default(false),
    tight_code: z.boolean().default(false),
    checks: z.enum(['ci', 'local']).optional(),
  }).optional(),
  commands: z.strictObject({
    node: z.array(z.string()).optional(),
    npm: z.array(z.string()).optional(),
    xcodebuild: z.array(z.string()).optional(),
    forge: z.array(z.string()).optional(),
    python3: z.array(z.string()).optional(),
    tsc: z.array(z.string()).optional(),
    json: z.boolean().optional(),
    node_test: z.boolean().optional(),
    excused: z.array(z.string()).optional(),
  }).optional(),
  finish: z.record(z.string(), z.array(z.string()).min(1)).optional(),
  finish_minutes: z.int().positive().optional(),
  greptile_files: z.array(z.string()).optional(),
})

export type Profile = z.infer<typeof Profile>

/** An outside repo's rules: the plan's step 0 `profile.yml`, then its owner's `_org.yml`, then its own file, each field laid over whole. */
export function profile(root: string, repo: string, plan?: number): Profile | null {
  const [owner = '', name = ''] = repo.split('/')
  const planned = plan === undefined ? null : read(join(planDir(root, plan), 'profile.yml'))
  const org = read(join(root, 'profiles', owner, '_org.yml'))
  const own = read(join(root, 'profiles', owner, `${name}.yml`))
  return planned === null && org === null && own === null ? null : { ...planned, ...org, ...own }
}

function read(path: string): Profile | null {
  if (!existsSync(path)) return null
  const found = Profile.safeParse(parse(readFileSync(path, 'utf8')))
  if (!found.success) throw new Error(`${path}: ${found.error.message}`)
  return found.data
}
