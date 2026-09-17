/**
 * The one verdict shape. A rail and a review both end in a `verdicts` row, so
 * they end in the same type — `rails/record.ts` and `reviews/verdict.ts` each
 * used to declare their own `Verdict`, and the sequencer had to know both.
 *
 * The first five fields are the row (`schema/0001_init.sql`). The last two are
 * carried to the caller and not persisted: a rail explains itself in `message`
 * and takes its defect class from its manifest; a review names a
 * `defect_class` and lets the sequencer word the note.
 */
export interface Verdict {
  outcome: 'pass' | 'refuse' | 'needs_ceo'
  subject_digest: string
  spans: string[]
  origin_kind: 'rail' | 'ruling' | 'incident' | null
  origin_ref: string | null
  message: string
  defect_class: string | null
}
