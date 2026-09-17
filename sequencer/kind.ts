export interface Outcome {
  outcome: 'pass' | 'refuse' | 'needs_ceo'
  spans: string[]
  note: string
}

export interface Fired {
  pipe: string
  plan: number
  step: number
  name: string
  outcome: 'pass' | 'refuse' | 'needs_ceo'
  state: string
  note: string
}
