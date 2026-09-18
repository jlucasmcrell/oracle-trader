import { useCallback, useEffect, useState } from 'react'
import type { ResearchResult } from '../../shared/ipc'

interface Props {
  seed: string
  log: (line: string) => void
}

export default function ResearchPanel({ seed, log }: Props) {
  const [topic, setTopic] = useState('')
  const [result, setResult] = useState<ResearchResult | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  const run = useCallback(
    async (t: string) => {
      if (!t.trim()) return
      setBusy(true)
      setError('')
      try {
        const r = await window.api.research.run(t.trim())
        setResult(r)
        log(`Research "${t}": ${r.news.length} news, ${r.opportunities.length} cross-venue match(es)`)
      } catch (err) {
        setError(String(err))
      } finally {
        setBusy(false)
      }
    },
    [log]
  )

  useEffect(() => {
    if (seed) {
      setTopic(seed)
      run(seed)
    }
  }, [seed, run])

  return (
    <div className="research">
      <form
        className="research-form"
        onSubmit={(e) => {
          e.preventDefault()
          run(topic)
        }}
      >
        <input value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="Topic or question (e.g. Fed rate cut)..." />
        <button type="submit" disabled={busy}>
          {busy ? 'Researching...' : 'Research'}
        </button>
      </form>

      {error && <div className="bt-error">{error}</div>}

      {result && result.opportunities.length > 0 && (
        <div className="opps">
          <div className="section-label">Arbitrage candidates</div>
          {result.opportunities.slice(0, 6).map((o, i) => (
            <div key={i} className="opp">
              <div className="opp-spread">{Math.round(o.spread * 100)}%</div>
              <div className="opp-body">
                <div className="opp-line">
                  <span className="opp-venue">{o.venueA}</span>
                  <span className="opp-prob">{(o.probA * 100).toFixed(0)}%</span>
                  <span className="opp-q" title={o.questionA}>{o.questionA}</span>
                </div>
                <div className="opp-line">
                  <span className="opp-venue">{o.venueB}</span>
                  <span className="opp-prob">{(o.probB * 100).toFixed(0)}%</span>
                  <span className="opp-q" title={o.questionB}>{o.questionB}</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {result && result.byVenue.length > 0 && (
        <div className="consensus">
          <div className="section-label">Cross-venue consensus</div>
          {result.byVenue.map((v) => (
            <div key={v.venue} className="venue-block">
              <div className="venue-name">{v.venue}</div>
              {v.markets.slice(0, 3).map((m, i) => (
                <div key={i} className="vmarket">
                  <span className="opp-prob">{((m.probability ?? 0) * 100).toFixed(0)}%</span>
                  <span className="opp-q" title={m.question}>{m.question}</span>
                </div>
              ))}
              {v.markets.length === 0 && <div className="muted">no open markets</div>}
            </div>
          ))}
        </div>
      )}

      {result && result.news.length > 0 && (
        <div className="news">
          <div className="section-label">Recent news</div>
          <ul>
            {result.news.slice(0, 8).map((n, i) => (
              <li key={i}>
                <button className="news-title" onClick={() => window.api.shell.openExternal(n.url)} title="Open article">
                  {n.title}
                </button>
                <span className="news-meta">
                  {n.source} - {fmtTime(n.publishedAt)}
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function fmtTime(ms: number): string {
  const d = Date.now() - ms
  const m = Math.floor(d / 60000)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}
