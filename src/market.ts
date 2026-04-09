import type { AgentRole, MarketConfig } from "./types.js";

// Each agent gets a slightly different "view" of the market price.
// This is cached per run so an agent sees consistent (but wrong) data.
const agentPriceCache = new Map<string, number>();

// Previous "stale" price — simulates delayed data
let stalePrice: number | null = null;

export function initMarket(config: MarketConfig): void {
  agentPriceCache.clear();
  // Store a stale price that's 10-25% off from base
  const staleDrift = 1 + (Math.random() * 0.15 + 0.1) * (Math.random() > 0.5 ? 1 : -1);
  stalePrice = Math.round(config.basePrice * staleDrift * 100) / 100;
}

export interface MarketPriceResult {
  success: boolean;
  price?: number;
  isStale: boolean;
  error?: string;
  actualBasePrice: number;
}

export function checkMarketPrice(
  agent: AgentRole,
  config: MarketConfig
): MarketPriceResult {
  const actual = config.basePrice;

  // Simulate tool failure
  if (Math.random() < config.failureRate) {
    return {
      success: false,
      isStale: false,
      error: "Market data service unavailable. Try again later.",
      actualBasePrice: actual,
    };
  }

  // Simulate stale data
  if (Math.random() < config.staleDataRate && stalePrice !== null) {
    return {
      success: true,
      price: stalePrice,
      isStale: true,
      actualBasePrice: actual,
    };
  }

  // Return noisy price per agent (consistent within a run)
  const cacheKey = agent;
  if (!agentPriceCache.has(cacheKey)) {
    const noise = 1 + (Math.random() * 2 - 1) * config.noiseRange;
    agentPriceCache.set(cacheKey, Math.round(actual * noise * 100) / 100);
  }

  return {
    success: true,
    price: agentPriceCache.get(cacheKey)!,
    isStale: false,
    actualBasePrice: actual,
  };
}
