import type { Method, Param } from './rpc.ts'

export interface Given {
  pubkey: string, signature: string, unknownPubkey: string, unknownSignature: string, transaction: string,
  slot: number, tip: number, versioned: { signature: string, slot: number },
}

export interface Case { method: string, name: string, params: unknown[] }

interface Config { commitment: string, minContextSlot?: true, encoding?: string, version?: true }

type Kind = 'pubkey' | 'signature' | 'data' | 'slot' | 'number' | 'config'

type Typed = Param & { at: number, kind: Kind, list: boolean }

type Named = [string, unknown[]]

const COMMITMENT: Config = { commitment: 'commitment' }

const SLOTTED: Config = { ...COMMITMENT, minContextSlot: true }

const ENCODED: Config = { ...SLOTTED, encoding: 'json' }

const VERSIONED: Config = { ...COMMITMENT, encoding: 'base64+zstd', version: true }

const CONFIG = new Map<string, Config>([
  ['RpcAccountInfoConfig', ENCODED], ['RpcProgramAccountsConfig', ENCODED],
  ['RpcSendTransactionConfig', { ...ENCODED, commitment: 'preflightCommitment' }], ['RpcSimulateTransactionConfig', ENCODED],
  ['RpcTransactionConfig', VERSIONED], ['RpcBlockConfig', VERSIONED],
  ['RpcContextConfig', SLOTTED], ['RpcSignaturesForAddressConfig', SLOTTED], ['RpcEpochConfig', SLOTTED],
  ['CommitmentConfig', COMMITMENT], ['RpcSupplyConfig', COMMITMENT], ['RpcLargestAccountsConfig', COMMITMENT],
  ['RpcGetVoteAccountsConfig', COMMITMENT],
])

const NUMBER = new Map<string, Kind>([['Slot', 'slot'], ['u64', 'number'], ['usize', 'number']])

// Agave's documented maximums.
const LIMITS = new Map([['getMultipleAccounts', 100], ['getSignatureStatuses', 256]])

const kindOf = ({ name, type }: Param): Kind | undefined =>
  type === 'String' || type === 'Vec<String>' ? name.includes('sig') ? 'signature' : /data|message|tx/.test(name) ? 'data' : 'pubkey'
    : CONFIG.has(type) ? 'config' : NUMBER.get(type)

const element = (kind: Kind, given: Given): unknown =>
  ({ pubkey: given.pubkey, signature: given.signature, data: given.transaction, slot: given.slot, number: 1, config: {} })[kind]

const held = (p: Typed, value: unknown): unknown => p.list ? [value] : value

const at = (base: unknown[], index: number, value: unknown): unknown[] =>
  [...base.slice(0, index), ...Array<null>(Math.max(0, index - base.length)).fill(null), value, ...base.slice(index + 1)]

const configOf = (typed: Typed[]) => typed.flatMap((p) => {
  const fields = CONFIG.get(p.type)
  return fields === undefined ? [] : [{ at: p.at, fields }]
})[0]

function keyed(typed: Typed[], valid: unknown[], given: Given): Named[] {
  const keys = typed.filter((p) => !p.optional && (p.kind === 'pubkey' || p.kind === 'signature'))
  const swap = (value: (p: Typed) => unknown) => keys.reduce((params, p) => at(params, p.at, held(p, value(p))), valid)
  return keys.length === 0 ? [] : [
    ['unknown', swap((p) => p.kind === 'pubkey' ? given.unknownPubkey : given.unknownSignature)],
    ['base58', swap(() => '0OIl')],
  ]
}

function configured(typed: Typed[], valid: unknown[], given: Given): Named[] {
  const config = configOf(typed)
  if (config === undefined) return []
  const put = (name: string, value: object): Named => [name, at(valid, config.at, value)]
  return [
    ...(config.fields.encoding === undefined ? [] : [put('encoding', { encoding: config.fields.encoding })]),
    put('commitment', { [config.fields.commitment]: 'unknown' }),
    ...(config.fields.minContextSlot ? [put('minContextSlot', { minContextSlot: given.tip + 1_000_000 })] : []),
  ]
}

function limited(method: string, typed: Typed[], valid: unknown[], given: Given): Named[] {
  const limit = LIMITS.get(method)
  const list = typed.find((p) => p.list)
  if (limit === undefined || list === undefined) return []
  return [['limit', at(valid, list.at, Array<unknown>(limit + 1).fill(element(list.kind, given)))]]
}

function versioned(typed: Typed[], valid: unknown[], given: Given): Named[] {
  const config = configOf(typed)
  const target = typed.find((p) => p.kind === 'signature' || p.kind === 'slot')
  if (config?.fields.version === undefined || target === undefined) return []
  const swapped = at(valid, target.at, held(target, target.kind === 'slot' ? given.versioned.slot : given.versioned.signature))
  return [['version-absent', at(swapped, config.at, {})], ['version-0', at(swapped, config.at, { maxSupportedTransactionVersion: 0 })]]
}

export function cases(method: Method, given: Given): Case[] {
  if (method.params.some((p) => !p.optional && kindOf(p) === undefined)) return []
  const typed = method.params.flatMap((p, index): Typed[] => {
    const kind = kindOf(p)
    return kind === undefined ? [] : [{ ...p, at: index, kind, list: p.type.startsWith('Vec<') }]
  })
  const valid = typed.filter((p) => !p.optional).reduce<unknown[]>((params, p) => at(params, p.at, held(p, element(p.kind, given))), [])
  const named: Named[] = [
    ['valid', valid],
    ...keyed(typed, valid, given),
    ...typed.map((p): Named => [`type:${p.name}`, at(valid, p.at, p.type === 'String' ? 1 : 'x')]),
    ...(valid.length === 0 ? [] : [['missing', valid.slice(0, -1)] satisfies Named]),
    ['extra', at(valid, method.params.length, 'extra')],
    ...configured(typed, valid, given),
    ...limited(method.name, typed, valid, given),
    ...versioned(typed, valid, given),
  ]
  return named.map(([name, params]) => ({ method: method.name, name, params }))
}
