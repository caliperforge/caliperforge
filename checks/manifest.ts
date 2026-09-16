import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'

const Manifest = z.object({
  ceilings: z.object({
    function_lines: z.int().positive(),
    nesting: z.int().positive(),
  }),
  rails: z.array(z.string()),
})

export type Manifest = z.infer<typeof Manifest>

export function manifest(root: string): Manifest {
  return Manifest.parse(parse(readFileSync(join(root, 'rules/rails.yaml'), 'utf8')))
}
