import { z } from 'zod'
import { CLOSING } from './daily.ts'
import { prose } from './prose.ts'

const Note = z.string().refine((note) => {
  const words = note.trim().split(/\s+/).length
  return words >= 31 && words <= 60 && !note.includes('?')
})

const Pack = z.object({
  topic: z.string().trim().min(1),
  notes: z.array(Note).length(14),
  replies: z.array(z.object({ to: z.string(), draft: z.string() })),
  partners: z.array(z.object({ name: z.string(), outreach: z.string() })),
})

export function packed(reply: string): z.infer<typeof Pack> | null {
  const fence = CLOSING.exec(reply)
  const got = Pack.safeParse(fence === null ? null : prose(fence[1] ?? '', ['topic']))
  return got.success ? got.data : null
}
