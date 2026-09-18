export class HttpError extends Error {
  status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
    this.name = 'HttpError'
  }
}

/** Simple sliding-window rate limiter (requests per minute). */
export class RateLimiter {
  private timestamps: number[] = []
  private queue: { priority: number; resolve: () => void }[] = []
  private timer?: ReturnType<typeof setTimeout>

  constructor(private readonly limit: number, private readonly windowMs = 60_000) {}

  wait(priority = 0): Promise<void> {
    return new Promise((resolve) => {
      this.queue.push({ priority, resolve })
      this.drain()
    })
  }

  private drain(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined }
    const now = Date.now()
    this.timestamps = this.timestamps.filter((t) => now - t < this.windowMs)
    this.queue.sort((a, b) => b.priority - a.priority)
    while (this.queue.length && this.timestamps.length < this.limit) {
      // Reserve synchronously: waking all sleepers together used to exceed the limit.
      this.timestamps.push(now)
      this.queue.shift()!.resolve()
    }
    if (this.queue.length) this.timer = setTimeout(() => this.drain(), Math.max(1, this.windowMs - (now - this.timestamps[0]) + 10))
  }
}

export interface HttpClientOptions {
  /** Wall-clock cap per request attempt (default 45s). */
  timeoutMs?: number
  baseUrl: string
  headers?: Record<string, string>
  rateLimit?: number
  rateLimitWindowMs?: number
  /** Separate allowance for POST/PUT/DELETE. Venues meter writes in their own bucket; sharing one queue with
   *  hundreds of scanner reads made a lead-lag order wait behind them. Unset = writes share the read limiter. */
  writeRateLimit?: number
  writeRateLimitWindowMs?: number
}

/**
 * Per-request headers: a plain record, or a factory evaluated AFTER the
 * rate-limiter wait and freshly on every retry attempt — signed-timestamp
 * auth headers (Kalshi/Polymarket US) go stale if built before a limiter
 * sleep or reused across a backoff retry.
 */
export type HeaderSource = Record<string, string> | (() => Record<string, string>)

/** Statuses worth retrying on idempotent requests (Kalshi 429s carry no Retry-After). */
const RETRYABLE = new Set([429, 502, 503, 504])
const MAX_RETRIES = 3

/**
 * Minimal JSON HTTP client with optional per-minute rate limiting and
 * exponential backoff on 429/5xx — for GET/DELETE only. POSTs are never
 * auto-retried: a timed-out order POST may have succeeded server-side and a
 * blind retry risks a double fill.
 */
export class HttpClient {
  private limiter: RateLimiter | null
  private writeLimiter: RateLimiter | null

  constructor(private readonly opts: HttpClientOptions) {
    this.limiter = opts.rateLimit ? new RateLimiter(opts.rateLimit, opts.rateLimitWindowMs) : null
    this.writeLimiter = opts.writeRateLimit ? new RateLimiter(opts.writeRateLimit, opts.writeRateLimitWindowMs) : null
  }

  private async request<T>(path: string, method: string, body?: string, headerSource?: HeaderSource): Promise<T> {
    const retryable = method === 'GET' || method === 'DELETE'
    let attempt = 0
    for (;;) {
      const accountRead = /^\/(portfolio\/(balance|positions|orders)|v1\/(account\/balances|portfolio\/positions|orders))/.test(path)
      const lane = method !== 'GET' && this.writeLimiter ? this.writeLimiter : this.limiter
      if (lane) await lane.wait(method === 'GET' ? (accountRead ? 1 : 0) : 2)
      const url = this.opts.baseUrl + path
      const perRequest = typeof headerSource === 'function' ? headerSource() : (headerSource ?? {})
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        ...(this.opts.headers ?? {}),
        ...perRequest
      }
      // Hard wall-clock cap on every request. fetch() has no default
      // timeout, so one unresponsive socket would hold the scan's busy flag
      // indefinitely. Timeouts on GET/DELETE retry like a 5xx; POSTs throw.
      let res: Response
      try {
        res = await fetch(url, { method, body, headers, signal: AbortSignal.timeout(this.opts.timeoutMs ?? 45_000) })
      } catch (err) {
        if (retryable && attempt < MAX_RETRIES) {
          const delay = 300 * 3 ** attempt + Math.random() * 250
          await new Promise((r) => setTimeout(r, delay))
          attempt++
          continue
        }
        throw err
      }
      if (!res.ok) {
        if (retryable && RETRYABLE.has(res.status) && attempt < MAX_RETRIES) {
          await res.text().catch(() => '')
          const delay = 300 * 3 ** attempt + Math.random() * 250
          await new Promise((r) => setTimeout(r, delay))
          attempt++
          continue
        }
        const bodyText = await res.text().catch(() => '')
        throw new HttpError(res.status, `${method} ${path} -> ${res.status}: ${bodyText.slice(0, 300)}`)
      }
      if (res.status === 204) return undefined as T
      return (await res.json()) as T
    }
  }

  get<T>(path: string, headers?: HeaderSource): Promise<T> {
    return this.request<T>(path, 'GET', undefined, headers)
  }

  post<T>(path: string, body?: unknown, headers?: HeaderSource): Promise<T> {
    return this.request<T>(path, 'POST', body === undefined ? undefined : JSON.stringify(body), headers)
  }

  del<T>(path: string, headers?: HeaderSource): Promise<T> {
    return this.request<T>(path, 'DELETE', undefined, headers)
  }
}
