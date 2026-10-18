import { expect, test } from 'vitest'
import { keyLock } from '../keyring.ts'

const GPG = 'gpg: Note: database_open 134217901 waiting for lock (held by 98937) ...\ngpg: keydb_search failed: Operation timed out'

test('a running holder is named running with the lock file', () => {
  const asked: number[] = []
  expect(keyLock(GPG, (pid) => { asked.push(pid); return true }))
    .toBe('gpg waited on a key database lock held by pid 98937 (running); likely ~/.gnupg/public-keys.d/pubring.db.lock')
  expect(asked).toEqual([98937])
})

test('a gone holder is named gone', () => {
  expect(keyLock(GPG, () => false)).toContain('pid 98937 (gone)')
})

test('a message with no lock line asks about no pid', () => {
  expect(keyLock('gpg: signing failed: No secret key', () => { throw new Error('asked') })).toBeNull()
})
