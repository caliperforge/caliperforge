import type { Fired } from './kind.ts'

export interface Usage {
  // https://platform.openai.com/docs/api-reference/chat/object
  prompt_tokens: number
  // https://platform.openai.com/docs/api-reference/chat/object
  completion_tokens: number
  // https://platform.openai.com/docs/api-reference/chat/object
  prompt_tokens_details?: { cached_tokens?: number }
  // https://platform.openai.com/docs/api-reference/chat/object
  completion_tokens_details?: { reasoning_tokens?: number }
  // https://api-docs.deepseek.com/api/create-chat-completion
  prompt_cache_hit_tokens?: number
  // https://api-docs.deepseek.com/api/create-chat-completion
  prompt_cache_miss_tokens?: number
}

export function usage(payload: Usage): Fired['usage'] {
  const { prompt_tokens: prompt, prompt_cache_hit_tokens: hit, prompt_cache_miss_tokens: miss } = payload
  const split = hit !== undefined || miss !== undefined
  if (split && (hit ?? 0) + (miss ?? 0) !== prompt) {
    throw new Error(
      `prompt_cache_hit_tokens ${String(hit)} + prompt_cache_miss_tokens ${String(miss)} is not prompt_tokens ${String(prompt)}`,
    )
  }
  const field = split ? 'prompt_cache_hit_tokens' : 'prompt_tokens_details.cached_tokens'
  const cache = split ? (hit ?? 0) : (payload.prompt_tokens_details?.cached_tokens ?? 0)
  if (cache > prompt) throw new Error(`${field} ${String(cache)} exceeds prompt_tokens ${String(prompt)}`)
  return { input: prompt - cache, cache, write: 0, write_1h: 0, output: payload.completion_tokens }
}
