import { z } from 'zod'

export interface Offer { proto: 'x402' | 'mpp'; scheme: string | null; network: string; coin: string; usd: number | null; payTo: string | null }
export interface Offers { offers: Offer[]; x402Source: 'header' | 'body' | null; x402Version: number | null; resourceUrl: string | null }
interface Response { status: number; headers: Record<string, string | string[]>; body: string }

const SOLANA = 'solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp'

const NETWORKS: Record<string, string> = {
  base: 'eip155:8453',
  'base-sepolia': 'eip155:84532',
  solana: SOLANA,
  'solana-devnet': 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
}

const COINS: Record<string, string> = {
  '0x833589fCD6eDb6E08f4c7C32D4f71b54bda02913': 'USDC',
  '0x036CbD53842c5426634e7929541eC2318f3dCF7e': 'USDC',
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 'USDC',
  '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU': 'USDC',
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 'USDT',
  '2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo': 'PYUSD',
}

const Accept = z.object({
  scheme: z.string().optional(),
  network: z.string(),
  amount: z.unknown().optional(),
  maxAmountRequired: z.unknown().optional(),
  asset: z.string(),
  payTo: z.string().optional(),
})

const X402 = z.object({
  x402Version: z.number().optional(),
  resource: z.object({ url: z.string() }).optional(),
  accepts: z.array(Accept),
})

const Challenge = z.object({ method: z.string(), intent: z.string().optional(), request: z.string().optional() })

const Request = z.object({
  amount: z.unknown().optional(),
  currency: z.string(),
  recipient: z.string().optional(),
  methodDetails: z.object({ network: z.string().optional(), decimals: z.int().optional() }).optional(),
})

const PARAM = /(\w+)="([^"]*)"/g

export function offersOf(res: Response): Offers {
  const [raw = ''] = [...values(res.headers, 'payment-required'), ...values(res.headers, 'x-payment-required')]
  const header = X402.safeParse(b64json(raw)).data
  const body = X402.safeParse(json(res.body)).data
  const found = header ?? body
  return {
    offers: [...(found?.accepts.map(accepted) ?? []), ...values(res.headers, 'www-authenticate').flatMap(mpp)],
    x402Source: header ? 'header' : body ? 'body' : null,
    x402Version: found?.x402Version ?? null,
    resourceUrl: found?.resource?.url ?? null,
  }
}

function values(headers: Response['headers'], name: string): string[] {
  return Object.entries(headers).filter(([key]) => key.toLowerCase() === name).flatMap(([, value]) => value)
}

function json(text: string): unknown {
  try {
    return JSON.parse(text) as unknown
  } catch {
    return null
  }
}

function b64json(text: string): unknown {
  const padded = text.padEnd(Math.ceil(text.length / 4) * 4, '=')
  for (const encoding of ['base64', 'base64url'] as const) {
    const value = json(Buffer.from(padded, encoding).toString('utf8'))
    if (typeof value === 'object' && value !== null) return value
  }
  return null
}

function accepted(accept: z.infer<typeof Accept>): Offer {
  return {
    proto: 'x402',
    scheme: accept.scheme ?? null,
    network: NETWORKS[accept.network] ?? accept.network,
    coin: coinOf(accept.asset),
    usd: usd(accept.amount ?? accept.maxAmountRequired, 6),
    payTo: accept.payTo ?? null,
  }
}

function mpp(value: string): Offer[] {
  return value.split(/(?=\bPayment\s)/).filter((s) => s.startsWith('Payment')).flatMap(challenge)
}

function challenge(segment: string): Offer[] {
  const params = Challenge.safeParse(Object.fromEntries([...segment.matchAll(PARAM)]
    .map(([, key = '', value = '']): [string, string] => [key, value]))).data
  const request = Request.safeParse(b64json(params?.request ?? '')).data
  if (params === undefined || request === undefined) return []
  return [{
    proto: 'mpp',
    scheme: params.intent ?? null,
    network: params.method === 'solana' ? solana(request.methodDetails?.network) : `mpp:${params.method}`,
    coin: coinOf(request.currency),
    usd: usd(request.amount, request.methodDetails?.decimals ?? 6),
    payTo: request.recipient ?? null,
  }]
}

function solana(network: string | undefined): string {
  return network === undefined || network === 'mainnet' || network === 'mainnet-beta' ? SOLANA : `solana:${network}`
}

function coinOf(asset: string): string {
  return COINS[asset] ?? asset.slice(0, 10)
}

function usd(amount: unknown, decimals: number): number | null {
  return typeof amount === 'string' && /^\d+$/.test(amount) ? Number(amount) / 10 ** decimals : null
}
