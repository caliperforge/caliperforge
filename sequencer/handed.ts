/** A step-3 refusal of the hand-back's text alone. `preReview` stops at the first refusing rail, so the note names one rail. */
export function handedBack(refusal: string): boolean {
  const note = refusal.split('\n')[2] ?? ''
  return refusal.startsWith('step 3 rails refused by pre_review\n')
    && (note.startsWith('identifiers: ') || (note.startsWith('completion-audit: ') && !note.includes(' open from the last review refuse, ')))
}
