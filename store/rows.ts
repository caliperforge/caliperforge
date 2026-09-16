import { z } from 'zod'

export const RuleRow = z.object({
  id: z.string(),
  kind: z.enum(['roster', 'rail', 'card']),
  path: z.string(),
  content_hash: z.string().length(64),
  loaded_at: z.string(),
})

export type RuleRow = z.infer<typeof RuleRow>
