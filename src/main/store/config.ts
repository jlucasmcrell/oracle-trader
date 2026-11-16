import { app, safeStorage } from 'electron'
import { join } from 'node:path'
import { loadJsonOrQuarantine, writeFileAtomic } from './json'
import type { ExecutionMode, VenueId } from '../../shared/types'
import type { RiskLimits } from '../../shared/ipc'

export interface AppConfig {
  executionMode: ExecutionMode
  kalshiApiKeyId: string
  kalshiPrivateKey: string
  /** Point the Kalshi adapter at the DEMO exchange (separate creds, mock funds). */
  kalshiDemo: boolean
  /**
   * Demo-exchange credentials, stored SEPARATELY from production. Demo keys
   * authenticate only against demo hosts and vice versa, so sharing one slot
   * would mean overwriting the production key every time you switch — and
   * losing it. Both pairs persist; kalshiDemo just selects which is used.
   */
  kalshiDemoApiKeyId: string
  kalshiDemoPrivateKey: string
  polymarketUsApiKeyId: string
  polymarketUsPrivateKey: string
  /** Paper-account starting balance per venue (mirrors the user's live stakes). */
  paperStartingBalances: Partial<Record<VenueId, number>>
  riskLimits: RiskLimits
}

const DEFAULTS: AppConfig = {
  executionMode: 'paper',
  kalshiApiKeyId: '',
  kalshiPrivateKey: '',
  kalshiDemo: false,
  kalshiDemoApiKeyId: '',
  kalshiDemoPrivateKey: '',
  polymarketUsApiKeyId: '',
  polymarketUsPrivateKey: '',
  paperStartingBalances: { 'polymarket-us': 45, kalshi: 72 },
  riskLimits: { maxStakePerBet: 0, maxOpenPositions: 0 }
}

const SECRET_FIELDS = [
  'kalshiApiKeyId',
  'kalshiPrivateKey',
  'kalshiDemoApiKeyId',
  'kalshiDemoPrivateKey',
  'polymarketUsApiKeyId',
  'polymarketUsPrivateKey'
] as const
type SecretField = (typeof SECRET_FIELDS)[number]

/** Persists settings to userData/config.json, encrypting the API key when possible. */
export class ConfigStore {
  private path: string
  private data: AppConfig = { ...DEFAULTS }
  /**
   * Secrets this Windows account cannot decrypt (saved by another account, e.g. after a profile move). In memory
   * they read as '' so every caller sees "no key"; the old ciphertext handed to the venue as a PEM failed every
   * request and left the live portfolio on "Loading..." forever (2026-11-16). On disk the ciphertext is kept
   * until the field is set again, so a transient decrypt failure still never destroys the credential.
   */
  private undecryptable = new Map<SecretField, string>()

  constructor() {
    this.path = join(app.getPath('userData'), 'config.json')
    this.load()
  }

  load(): void {
    try {
      // An unparseable file is moved aside and replaced from its last-good copy; it used to be read as "no file",
      // and the next settings save then overwrote the only copy of the keys (review 2026-11-10).
      const parsed = loadJsonOrQuarantine<Partial<AppConfig>>(this.path, (m) => console.error(m))
      if (parsed) {
        this.data = {
          ...DEFAULTS,
          ...parsed,
          // deep-merge nested configs so newly added fields get defaults
          riskLimits: { ...DEFAULTS.riskLimits, ...(parsed.riskLimits ?? {}) }
        }
        this.normalize()
        this.undecryptable.clear()
        for (const field of SECRET_FIELDS) {
          const stored = this.data[field]
          if (!stored) continue
          const plain = this.decrypt(stored)
          if (plain.startsWith('enc:')) {
            this.undecryptable.set(field, stored)
            this.data[field] = ''
          } else {
            this.data[field] = plain
          }
        }
        if (this.undecryptable.size) {
          console.warn(
            `[config] cannot decrypt ${[...this.undecryptable.keys()].join(', ')} on this Windows account ` +
              '(saved by another account?). Treating as not set; re-enter them in Settings.'
          )
        }
      }
    } catch (err) {
      console.warn('[config] failed to load, using defaults:', err)
    }
  }

  save(): void {
    try {
      const toWrite: AppConfig = { ...this.data }
      for (const field of SECRET_FIELDS) {
        const kept = this.undecryptable.get(field)
        if (toWrite[field]) toWrite[field] = this.encrypt(toWrite[field])
        else if (kept) toWrite[field] = kept
      }
      writeFileAtomic(this.path, JSON.stringify(toWrite, null, 2))
    } catch (err) {
      console.warn('[config] failed to save:', err)
    }
  }

  get(): AppConfig {
    return { ...this.data }
  }

  update(patch: Partial<AppConfig>): AppConfig {
    // A new non-empty value replaces the undecryptable ciphertext for good. An empty one (e.g. saving the key ID
    // alone) leaves it on disk: clearing a field must not silently destroy the only copy of a key.
    for (const field of SECRET_FIELDS) if (patch[field]) this.undecryptable.delete(field)
    this.data = { ...this.data, ...patch }
    this.normalize()
    this.save()
    return this.get()
  }

  /**
   * `executionMode` was never validated on load or on the IPC write. A `null` or `'Paper'` in a hand-edited
   * config.json matches neither `mode === 'paper'` nor `mode === 'live'`, so orders took the live submission
   * path while the paper-only and live-only guards (liveArmed, the boot reconcile) both fell through
   * (audit 2026-09-19, B-40). Anything unrecognised is paper: the safe end.
   */
  private normalize(): void {
    if (this.data.executionMode !== 'paper' && this.data.executionMode !== 'live') {
      console.warn(`[config] executionMode ${JSON.stringify(this.data.executionMode)} is not 'paper' or 'live'; forcing 'paper'`)
      this.data.executionMode = 'paper'
    }
  }

  private encrypt(value: string): string {
    // Already ciphertext (a decrypt failed earlier and we kept it): pass it
    // through untouched rather than encrypting the ciphertext again.
    if (value.startsWith('enc:')) return value
    if (safeStorage.isEncryptionAvailable()) {
      return 'enc:' + safeStorage.encryptString(value).toString('base64')
    }
    return 'plain:' + value
  }

  private decrypt(value: string): string {
    if (value.startsWith('enc:')) {
      try {
        return safeStorage.decryptString(Buffer.from(value.slice(4), 'base64'))
      } catch (err) {
        // Returning '' here was persisted by the next save() and DESTROYED
        // the credential. Keep the ciphertext: auth fails loudly instead.
        console.warn('[config] decrypt failed; keeping ciphertext:', err)
        return value
      }
    }
    if (value.startsWith('plain:')) return value.slice(6)
    return value
  }
}
