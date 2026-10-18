const WAIT = /waiting for lock \(held by (\d+)\)/

/** What a person needs to clear a key database lock gpg waited on, or null when the message has no lock line; gpg does not name the lock file. */
export function keyLock(message: string, running = alive): string | null {
  const pid = WAIT.exec(message)?.[1]
  if (pid === undefined) return null
  return `gpg waited on a key database lock held by pid ${pid} (${running(Number(pid)) ? 'running' : 'gone'}); ` +
    'likely ~/.gnupg/public-keys.d/pubring.db.lock'
}

/** Signal 0 only asks whether the pid exists: EPERM is a pid that exists, ESRCH one that is gone. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === 'EPERM') return true
    if (code === 'ESRCH') return false
    throw error
  }
}
