import { expect, test } from 'vitest'
import type { Read } from '../../cli/gh.ts'
import { hardware } from '../hardware.ts'

const KEYCHAIN = 'solana-foundation/solana-keychain'

const ISSUE_307 = {
  title: 'Ledger: two attached devices cannot be used concurrently — the device actor caches one session',
  body: 'The actor keeps `host_device_path` and `verify_or_reject` runs once, so '
    + '`a_swapped_device_is_caught_as_a_verification_failure` cannot hold. `hidapi` opens one `DEVICE_THREAD`.',
  url: `https://github.com/${KEYCHAIN}/issues/307`,
  comments: [],
}

const SIGN = '#[test]\n#[ignore = "needs two Ledger devices"]\nfn two_devices_sign() {}\n'

function repo(issue: object, files: Record<string, string> = {}): Read {
  return (args) => {
    if (args[0] === 'issue') return issue
    const path = String(args[1])
    if (path.startsWith('search/code')) {
      return { items: Object.keys(files).filter((f) => files[f]?.includes(path.slice(14, path.indexOf('+'))) === true).map((f) => ({ path: f })) }
    }
    const file = files[path.slice(path.indexOf('/contents/') + 10)] ?? ''
    return { content: Buffer.from(file).toString('base64').replace(/(.{60})/g, '$1\n') }
  }
}

const RIG = 'caliperforge/ledger-rig (action: caliperforge/ledger-rig@v0); limits: Linux hidraw only; not physical USB or macOS IOKit'

test('an issue naming a Ledger passes with the ledger-rig line', () => {
  expect(hardware(KEYCHAIN, 307, repo(ISSUE_307))).toEqual({ park: null, lines: `- hardware: ledger — ${RIG} — https://github.com/${KEYCHAIN}/issues/307\n` })
})

test('an issue naming a Trezor is refused with its url', () => {
  const issue = { ...ISSUE_307, title: 'Trezor: signing hangs' }
  expect(hardware(KEYCHAIN, 307, repo(issue))).toEqual({ park: `hardware: Trezor — https://github.com/${KEYCHAIN}/issues/307`, lines: '' })
})

test('a pure-software issue whose names find no code passes', () => {
  const issue = { title: 'Parse the config once', body: 'Cache `load_config` instead.', url: 'https://github.com/acme/widget/issues/1', comments: [] }
  expect(hardware('acme/widget', 1, repo(issue))).toEqual({ park: null, lines: '' })
})

test('an owned device is not refused', () => {
  expect(hardware(KEYCHAIN, 307, repo(ISSUE_307), ['Ledger'])).toEqual({ park: null, lines: '' })
})

test('a test ignored for a Ledger gets its stand-in, or none', () => {
  const issue = { title: 'Signing twice fails', body: 'See `two_devices_sign`.', url: 'https://github.com/acme/widget/issues/2', comments: [] }
  const read = repo(issue, { 'tests/ledger.rs': SIGN })
  expect(hardware('acme/widget', 2, read)).toEqual({ park: null, lines: `- hardware: ledger — ${RIG} — \`two_devices_sign\` in tests/ledger.rs\n` })
  expect(hardware('acme/widget', 2, read, [], [])).toEqual({ park: 'hardware: Ledger — `two_devices_sign` in tests/ledger.rs', lines: '' })
})
