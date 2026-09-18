import type { VenueAdapter } from '../../shared/venue'
import type { VenueId } from '../../shared/types'
import { PolymarketUsAdapter } from './polymarketUs'
import { KalshiAdapter } from './kalshi'
import { IbkrAdapter } from './ibkrAdapter'

/**
 * Central registry of venue adapters. Adding a venue is a single `register`
 * call here — the engine, strategies, and UI all read from this registry.
 * (The legacy Gamma-based Polymarket adapter is no longer registered — the
 * region-blocked .com venue is superseded by Polymarket US.)
 */
export class VenueRegistry {
  private adapters = new Map<VenueId, VenueAdapter>()

  constructor() {
    this.register(new PolymarketUsAdapter())
    this.register(new KalshiAdapter())
    this.register(new IbkrAdapter())
  }

  register(adapter: VenueAdapter): void {
    this.adapters.set(adapter.id, adapter)
  }

  get(id: VenueId): VenueAdapter | undefined {
    return this.adapters.get(id)
  }

  list(): VenueAdapter[] {
    return [...this.adapters.values()]
  }
}
