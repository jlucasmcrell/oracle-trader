import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { IntelligenceReview } from './types'
export class IntelligenceAuditStore {
  constructor(private path:string) { mkdirSync(dirname(path),{recursive:true}) }
  append(review:IntelligenceReview):void {
    appendFileSync(this.path,JSON.stringify({...review,loggedAt:Date.now()})+'\n','utf8')
  }
}
