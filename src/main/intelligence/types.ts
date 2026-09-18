export type IntelligenceMode = 'off' | 'shadow' | 'veto'

export interface EvidenceRef { id: string; source: string; asOf: number; text: string; url?: string }
export interface RuleSchema {
  settlementSource?: string; timezone?: string; observationText?: string
  threshold?: number; comparison?: 'gt'|'gte'|'lt'|'lte'|'between'|'binary'|'unknown'
  earlyResolution?: boolean; discretionary?: boolean; ambiguities: string[]
  confidence: number; supportingQuotes: string[]
}
export interface CandidatePacket {
  version: 1; candidateId: string; decisionTime: number; venue: string; strategy: string
  market: { id: string; question: string; rules?: string; closeTime?: number; yesBid?: number; yesAsk?: number; yesMid: number; depthAtPrice?: number }
  order: { direction: 'YES'|'NO'; maker: boolean; contracts: number; executablePrice: number; yesLimitPrice: number; feeCents: number; slippageReserveCents: number; maxLossDollars: number }
  strategyEvidence: Record<string, number|string>
  portfolio: { balance?: number; openPositions: number; dailyTradesLeft: number; stake: number }
  freshness: { packetAt: number; bookAgeMs?: number }
  evidence: EvidenceRef[]
}
export interface IntelligenceVerdict {
  action: 'ALLOW_UNCHANGED'|'VETO'|'ABSTAIN_INSUFFICIENT_EVIDENCE'
  pYesLow: number; pYesMid: number; pYesHigh: number
  confidence: number; evidenceSufficient: boolean
  ruleRisk: 'low'|'medium'|'high'|'unknown'; dataRisks: string[]; failureMode: string
  citedEvidenceIds: string[]; reason: string
}
export interface Adjudication {
  eligible: boolean; action: IntelligenceVerdict['action']; conservativeEdgeCents: number
  reason: string; errors: string[]
}
export interface IntelligenceReview {
  packet: CandidatePacket; verdict?: IntelligenceVerdict; adjudication: Adjudication
  model?: string; latencyMs: number; apiError?: string
}
