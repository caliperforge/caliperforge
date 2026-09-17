/** The one verdict shape: a rail and a review both end in a `verdicts` row. */
export interface Verdict {
  outcome: 'pass' | 'refuse' | 'needs_ceo'
  subject_digest: string
  spans: string[]
  origin_kind: 'rail' | 'ruling' | 'incident' | null
  origin_ref: string | null
  message: string
  defect_class: string | null
}
