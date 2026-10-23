import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test } from 'vitest'
import { AGENT, PHP, read, snapshot, WORDPRESS, type Net } from '../snapshot.ts'

const fixture = (name: string): string => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8')
const HEADERS = { 'x-powered-by': 'PHP/8.0.30', server: 'cloudflare', 'cf-ray': '8a1b2c3d4e5f-LAX', 'strict-transport-security': 'max-age=31536000' }
const PAGES: Record<string, () => Response> = {
  'https://example.org/': () => new Response(null, { status: 301, headers: { location: 'https://www.example.org/' } }),
  'https://www.example.org/': () => new Response(fixture('wordpress.html'), { headers: HEADERS }),
  [WORDPRESS]: () => new Response(fixture('version-check.json')),
  [PHP]: () => new Response(fixture('php-active.json')),
}

function site(pages = PAGES, reachable = true) {
  const calls: { url: string; init: RequestInit | undefined }[] = []
  const tls: string[] = []
  const ns: string[] = []
  const net: Net = {
    fetch: ((url: string, init?: RequestInit) => {
      calls.push({ url, init })
      const page = pages[url]
      return page === undefined ? Promise.reject(new Error(`unreachable ${url}`)) : Promise.resolve(page())
    }) as typeof fetch,
    tls: (host) => {
      tls.push(host)
      return reachable ? Promise.resolve({ issuer: "Let's Encrypt", expires: 'Jan  1 00:00:00 2027 GMT' }) : Promise.reject(new Error('refused'))
    },
    ns: (host) => {
      ns.push(host)
      return reachable ? Promise.resolve(['ada.ns.cloudflare.com', 'bob.ns.cloudflare.com']) : Promise.reject(new Error('ENODATA'))
    },
  }
  return { net, calls, tls, ns }
}

test('D2 only the page, its redirect and the two sources are read', async () => {
  const { net, calls, tls, ns } = site()
  await snapshot('https://example.org/', net)
  expect(calls.map((c) => c.url)).toEqual(['https://example.org/', 'https://www.example.org/', WORDPRESS, PHP])
  for (const { init } of calls) expect(init).toMatchObject({ method: 'GET', redirect: 'manual', headers: { 'user-agent': AGENT } })
  expect(tls).toEqual(['www.example.org'])
  expect(ns).toEqual(['example.org'])
})

test('D3 read finds the generator, plugins, theme, PHP and headers', () => {
  expect(read(fixture('wordpress.html'), new Headers(HEADERS))).toEqual({
    generator: { name: 'WordPress', version: '6.4.2' },
    plugins: [{ name: 'contact-form-7', version: '5.8.4' }, { name: 'woocommerce', version: '8.3.1' }, { name: 'elementor', version: '3.18.0' }],
    themes: [{ name: 'astra', version: '4.5.2' }],
    php: '8.0.30',
    server: 'cloudflare',
    headers: { hsts: true, csp: false, frameOptions: false },
    cloudflare: true,
  })
  expect(read('<meta name="generator" content="WordPress 6.5" />', new Headers()).generator).toEqual({ name: 'WordPress', version: '6.5' })
  expect(read('', new Headers({ 'cf-ray': '1' })).cloudflare).toBe(true)
})

test('D3 compares against both sources and reads Cloudflare DNS', async () => {
  const s = await snapshot('https://example.org/', site().net)
  expect(s).toMatchObject({ final: 'https://www.example.org/', status: 200, latestWordpress: '6.6.1', phpSupported: false, cloudflareDns: true, unread: [] })
  expect(s.tls).toEqual({ issuer: "Let's Encrypt", expires: 'Jan  1 00:00:00 2027 GMT' })
})

test('D4 a version the site does not show stays null', () => {
  expect(read(fixture('plain.html'), new Headers())).toEqual({
    generator: null,
    plugins: [{ name: 'jetpack', version: null }],
    themes: [],
    php: null,
    server: null,
    headers: { hsts: false, csp: false, frameOptions: false },
    cloudflare: false,
  })
})

test('D5 failed sources, tls and ns give null and the run goes on', async () => {
  const pages = Object.fromEntries(Object.entries(PAGES).filter(([url]) => url !== WORDPRESS && url !== PHP))
  const s = await snapshot('https://example.org/', site(pages, false).net)
  expect(s).toMatchObject({ tls: null, nameservers: null, cloudflareDns: null, latestWordpress: null, phpSupported: null })
  expect(s.unread).toEqual(['tls: refused', 'ns: ENODATA', `${WORDPRESS}: unreachable ${WORDPRESS}`, `${PHP}: unreachable ${PHP}`])
})

test('D5 sources of another shape give null', async () => {
  const pages = { ...PAGES, [WORDPRESS]: () => Response.json({ offers: [] }), [PHP]: () => new Response('<html>busy</html>') }
  const s = await snapshot('https://example.org/', site(pages).net)
  expect(s).toMatchObject({ latestWordpress: null, phpSupported: null })
  expect(s.unread.map((u) => u.slice(0, u.indexOf(': ')))).toEqual([WORDPRESS, PHP])
})
