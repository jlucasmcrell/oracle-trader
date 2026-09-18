export interface IbkrInstrument {
  conId: number
  symbol: string
  name: string
  description: string
  exchange: string
  currency: string
  securityType: string
  outcome?: 'YES' | 'NO'
  strike?: number
  expiry: string
  lastTradeTime: string
}
export interface IbkrSnapshot {
  at: string
  port: number
  mode: 'live' | 'paper'
  accounts: { account: string; tag: string; value: string; currency: string }[]
  positions: { account: string; instrument: IbkrInstrument; quantity: number; averageCost?: number }[]
  orders: { id: number; clientId?: number; orderRef?: string; permId?: number; account: string; instrument: IbkrInstrument; action: string; quantity: number; limitPrice?: number; status: string }[]
}
export interface IbkrPreview {
  account: string
  conId: number
  quantity: number
  limitPrice: number
  maxCost: number
  commission?: number
  feeReserve: number
  feeSource: 'broker' | 'published schedule'
  warning?: string
}
export interface IbkrWatch {
  id: string
  request: import('./types').OrderRequest
  expiresAt: number
  state: 'watching' | 'submitting' | 'submitted' | 'stopped' | 'expired' | 'uncertain'
  message: string
  orderId?: string
}
export interface IbkrQuote {
  conId: number
  at: string
  bid?: number
  ask?: number
  bidSize?: number
  askSize?: number
  bidAt?: number
  askAt?: number
  error?: string
  dataType: string
}
