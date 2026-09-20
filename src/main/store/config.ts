import { app, safeStorage } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { writeFileAtomic } from './json'
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

/** Persists settings to userData/config.json, encrypting the API key when possible. */
export class ConfigStore {
  private path: string
  private data: AppConfig = { ...DEFAULTS }

  constructor() {
    this.path = join(app.getPath('userData'), 'config.json')
    this.load()
  }

  load(): void {
    try {
      if (existsSync(this.path)) {
        const raw = readFileSync(this.path, 'utf-8')
        const parsed = JSON.parse(raw) as Partial<AppConfig>
        this.data = {
          ...DEFAULTS,
          ...parsed,
          // deep-merge nested configs so newly added fields get defaults
          riskLimits: { ...DEFAULTS.riskLimits, ...(parsed.riskLimits ?? {}) }
        }
        this.normalize()
        if (this.data.kalshiApiKeyId) {
          this.data.kalshiApiKeyId = this.decrypt(this.data.kalshiApiKeyId)
        }
        if (this.data.kalshiPrivateKey) {
          this.data.kalshiPrivateKey = this.decrypt(this.data.kalshiPrivateKey)
        }
        if (this.data.kalshiDemoApiKeyId) {
          this.data.kalshiDemoApiKeyId = this.decrypt(this.data.kalshiDemoApiKeyId)
        }
        if (this.data.kalshiDemoPrivateKey) {
          this.data.kalshiDemoPrivateKey = this.decrypt(this.data.kalshiDemoPrivateKey)
        }
        if (this.data.polymarketUsApiKeyId) {
          this.data.polymarketUsApiKeyId = this.decrypt(this.data.polymarketUsApiKeyId)
        }
        if (this.data.polymarketUsPrivateKey) {
          this.data.polymarketUsPrivateKey = this.decrypt(this.data.polymarketUsPrivateKey)
        }
      }
    } catch (err) {
      console.warn('[config] failed to load, using defaults:', err)
    }
  }

  save(): void {
    try {
      const toWrite: AppConfig = { ...this.data }
      if (toWrite.kalshiApiKeyId) {
        toWrite.kalshiApiKeyId = this.encrypt(toWrite.kalshiApiKeyId)
      }
      if (toWrite.kalshiPrivateKey) {
        toWrite.kalshiPrivateKey = this.encrypt(toWrite.kalshiPrivateKey)
      }
      if (toWrite.kalshiDemoApiKeyId) {
        toWrite.kalshiDemoApiKeyId = this.encrypt(toWrite.kalshiDemoApiKeyId)
      }
      if (toWrite.kalshiDemoPrivateKey) {
        toWrite.kalshiDemoPrivateKey = this.encrypt(toWrite.kalshiDemoPrivateKey)
      }
      if (toWrite.polymarketUsApiKeyId) {
        toWrite.polymarketUsApiKeyId = this.encrypt(toWrite.polymarketUsApiKeyId)
      }
      if (toWrite.polymarketUsPrivateKey) {
        toWrite.polymarketUsPrivateKey = this.encrypt(toWrite.polymarketUsPrivateKey)
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
