import { appendFileSync } from 'node:fs'

/**
 * Windows raises these while another process holds the file open - an antivirus scan, a backup copy, an operator
 * opening a log. They clear on their own (backlog 223, incident 2026-09-21T13-35).
 */
export function isSharingViolation(e: unknown): boolean {
  const code = (e as { code?: unknown } | null)?.code
  return code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
}

const sleepSync = (ms: number): void => {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/**
 * appendFileSync that rides out a sharing violation: up to `tries` attempts, 50 ms apart. Anything else - or a
 * violation that outlasts the retries - is thrown to the caller, which decides whether it is permanent. Synchronous
 * on purpose: the order journal must have the line on disk before the order leaves the process.
 */
export function appendDurably(path: string, text: string, opts: { flush?: boolean } = {}, tries = 5, append: typeof appendFileSync = appendFileSync): void {
  for (let i = 1; ; i++) {
    try {
      append(path, text, opts.flush ? { flush: true } : undefined)
      return
    } catch (e) {
      if (!isSharingViolation(e) || i >= tries) throw e
      sleepSync(50)
    }
  }
}
