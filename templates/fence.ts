import { z } from 'zod'
import type { Item } from '../store/desk.ts'

const REF = /^(https:\/\/\S+|learnings:\d{4}-\d{2}-\d{2}|[\w-][\w./-]*:[1-9]\d*)$/

export const Fence = z.object({
  learnings: z.string().trim().min(1),
  dest: z.enum(['site', 'substack', 'note']),
  dek: z.string().trim().min(1).max(160).regex(/^[^`*_#[\]<>~]*$/),
  sources: z.array(z.object({ claim: z.string().trim().min(1), ref: z.string().regex(REF) })),
  checks: z.array(z.object({ label: z.string().trim().min(1), ok: z.boolean() })),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
})

export const Stored = Fence.extend({ learnings: z.string().optional() })

export const HEAD = /^# (.+)\n([\s\S]*)$/

export const noting = (learnings: string): Item[] => learnings.split('\n').map((l) => l.trim()).filter((l) => l !== '')
  .map((line) => ({ title: line, what: '', lesson: '', fix: '', status: 'noted' }))
