import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parseDocument } from 'yaml'
import { z } from 'zod'

export function workflows(src: string): string[] {
  const dir = join(src, '.github', 'workflows')
  return existsSync(dir) ? readdirSync(dir).filter((f) => /\.ya?ml$/.test(f)).sort().map((f) => readFileSync(join(dir, f), 'utf8')) : []
}

const Step = z.object({
  run: z.string().optional(),
  uses: z.string().optional(),
  with: z.object({ repository: z.string().optional(), path: z.string().optional(), ref: z.string().optional() }).optional(),
})

const Workflow = z.object({ jobs: z.record(z.string(), z.object({ steps: z.array(Step).default([]) })) })

export function steps(src: string): z.infer<typeof Step>[] {
  return workflows(src).flatMap((text) => {
    const doc = parseDocument(text)
    const found = Workflow.safeParse(doc.errors.length === 0 ? doc.toJS() : null)
    return found.success ? Object.values(found.data.jobs).flatMap((job) => job.steps) : []
  })
}

export interface Checkout { repository: string; path: string; ref?: string }

/** Each `actions/checkout` step that puts another repository at a path, once per path. */
export function checkouts(src: string): Checkout[] {
  const found = steps(src).flatMap(({ uses, with: given }) => uses?.startsWith('actions/checkout@') === true && given?.repository !== undefined && given.path !== undefined
    ? [{ repository: given.repository, path: given.path, ...(given.ref === undefined ? {} : { ref: given.ref }) }] : [])
  return found.filter((c, at) => found.findIndex((d) => d.path === c.path) === at)
}
