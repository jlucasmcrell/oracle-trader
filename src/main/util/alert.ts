/**
 * Minimal push alerting: one webhook, no dependencies. Supports Discord
 * webhooks (JSON) and ntfy/Pushover-style plain-text POST endpoints.
 * Alerting must never break trading — every failure is swallowed.
 */
export async function sendAlert(url: string, title: string, message: string): Promise<void> {
  if (!url || !/^https:\/\//.test(url)) return
  try {
    if (/discord\.com\/api\/webhooks/.test(url)) {
      await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content: `**${title}**\n${message}`.slice(0, 1900) })
      })
    } else {
      const u = new URL(url)
      const topic = u.pathname.replace(/^\/+|\/+$/g, '')
      if (topic && !topic.includes('/')) {
        // An ntfy topic URL: publish as JSON to the origin. Node's fetch rejects
        // non-ASCII header values, and alert titles carry arrows and dashes —
        // the first ladder push (2026-09-08 12:48Z, "disabled → tiny-live") was
        // lost that way while a plain-ASCII test had gone through.
        await fetch(u.origin, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ topic, title: title.slice(0, 120), message: message.slice(0, 3900) })
        })
      } else {
        await fetch(url, {
          method: 'POST',
          headers: { Title: title.replace(/[^\x20-\x7e]/g, '-').slice(0, 120) },
          body: message.slice(0, 3900)
        })
      }
    }
  } catch {
    // never let alerting take the trader down
  }
}
