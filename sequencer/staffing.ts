import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { parse } from 'yaml'
import { z } from 'zod'

const Row = z.object({
  template: z.enum(['pr_path', 'comms']),
  step: z.number().int().min(0),
  key: z.string().optional(),
  seat: z.string(),
  mode: z.enum(['build', 'review', 'fix']).optional(),
})

type Row = z.infer<typeof Row>

export function staffing(root: string): Row[] {
  const rows = z.array(Row).parse(parse(readFileSync(join(root, 'rules/staffing.yaml'), 'utf8')))
  const unseated = rows.find((r) => !existsSync(join(root, 'seats', r.seat)))
  if (unseated !== undefined) throw new Error(`rules/staffing.yaml names seat "${unseated.seat}" with no seats/${unseated.seat} folder`)
  return rows
}

export function staffed(root: string, template: Row['template'], step: number, key: string | null): Pick<Row, 'seat' | 'mode'> | null {
  const row = staffing(root).find((r) => r.template === template && r.step === step && (r.key ?? null) === key)
  return row === undefined ? null : { seat: row.seat, mode: row.mode }
}
