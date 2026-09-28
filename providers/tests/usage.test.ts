import { describe, expect, it } from 'vitest'
import { usage } from '../usage.ts'

const COMBINED = { prompt_tokens: 100, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 60 } }
const SPLIT = { prompt_tokens: 100, completion_tokens: 7, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40 }

describe('usage', () => {
  it('maps a combined cached count onto the four columns', () => {
    expect(usage(COMBINED)).toEqual({ input: 40, cache: 60, write: 0, output: 7 })
  })

  it('maps a hit/miss split onto the four columns', () => {
    expect(usage(SPLIT)).toEqual({ input: 40, cache: 60, write: 0, output: 7 })
  })

  it('gives the same columns for both shapes', () => {
    expect(usage(COMBINED)).toEqual(usage(SPLIT))
  })

  it('counts every prompt token as input when nothing was cached', () => {
    expect(usage({ prompt_tokens: 100, completion_tokens: 7 })).toEqual({ input: 100, cache: 0, write: 0, output: 7 })
  })

  it('throws, naming the fields, when hit and miss do not add up to the prompt', () => {
    expect(() => usage({ ...SPLIT, prompt_cache_miss_tokens: 50 }))
      .toThrow('prompt_cache_hit_tokens 60 + prompt_cache_miss_tokens 50 is not prompt_tokens 100')
    expect(() => usage({ prompt_tokens: 100, completion_tokens: 7, prompt_cache_miss_tokens: 40 }))
      .toThrow('prompt_cache_hit_tokens undefined + prompt_cache_miss_tokens 40 is not prompt_tokens 100')
  })

  it('throws, naming the fields, when more tokens were cached than prompted', () => {
    expect(() => usage({ ...COMBINED, prompt_tokens_details: { cached_tokens: 120 } }))
      .toThrow('prompt_tokens_details.cached_tokens 120 exceeds prompt_tokens 100')
  })

  it('leaves reasoning tokens inside output', () => {
    expect(usage({ prompt_tokens: 0, completion_tokens: 7, completion_tokens_details: { reasoning_tokens: 5 } }).output).toBe(7)
  })
})
