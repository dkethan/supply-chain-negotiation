import {
  Agent,
  buildSupplierPrompt,
  buildManufacturerBuyerPrompt,
  buildManufacturerSellerPrompt,
  buildRetailerPrompt,
} from "./agent.js";
import { initMarket } from "./market.js";
import type {
  AgentRole,
  MarketConfig,
  NegotiationEvent,
  NegotiationPair,
  NegotiationResult,
  NegotiationOutcome,
  RunConfig,
  RunOutput,
  FailureDiagnosis,
  FailureType,
} from "./types.js";

interface NegotiationSetup {
  pair: NegotiationPair;
  agentA: Agent; // seller
  agentB: Agent; // buyer
  roleA: AgentRole;
  roleB: AgentRole;
}

async function runNegotiation(
  setup: NegotiationSetup,
  runId: string,
  maxRounds: number
): Promise<NegotiationResult> {
  const { pair, agentA, agentB, roleA, roleB } = setup;
  const events: NegotiationEvent[] = [];

  let lastOfferPrice: number | undefined;
  let lastOfferFrom: AgentRole | undefined;

  // Pending message buffer — delivers on NEXT turn (1-turn delay)
  let pendingForA: string | null = null;
  let pendingForB: string | null = null;

  // Agent A goes first
  let currentAgent: "A" | "B" = "A";

  for (let round = 1; round <= maxRounds; round++) {
    const agent = currentAgent === "A" ? agentA : agentB;
    const agentRole = currentAgent === "A" ? roleA : roleB;
    const otherRole = currentAgent === "A" ? roleB : roleA;

    // Build situation update from pending messages
    let situation: string;
    const pending = currentAgent === "A" ? pendingForA : pendingForB;

    if (round === 1 && currentAgent === "A") {
      situation = `Negotiation starting. You are the ${agentRole} negotiating with the ${otherRole}. You go first. Make your opening move.`;
    } else if (pending) {
      situation = pending;
    } else {
      situation = `Round ${round}. Waiting for a response. You may check the market price or make an offer.`;
    }

    // Clear delivered message
    if (currentAgent === "A") pendingForA = null;
    else pendingForB = null;

    console.log(`  [Round ${round}] ${agentRole}'s turn...`);

    const { action, event } = await agent.takeTurn(
      round,
      situation,
      runId,
      pair
    );

    events.push(event);

    // Log the offer to both agents' history
    if (action.price != null) {
      agentA.addOfferToHistory(round, agentRole, action.price);
      agentB.addOfferToHistory(round, agentRole, action.price);
      lastOfferPrice = action.price;
      lastOfferFrom = agentRole;
    }

    console.log(
      `  [Round ${round}] ${agentRole}: ${action.action}${action.price != null ? ` @ $${action.price.toFixed(2)}` : ""} — "${action.message}"`
    );

    // Check terminal conditions
    if (action.action === "accept") {
      return {
        pair,
        events,
        outcome: "deal",
        finalPrice: lastOfferPrice,
        rounds: round,
        agentA: roleA,
        agentB: roleB,
      };
    }

    if (action.action === "walk_away") {
      return {
        pair,
        events,
        outcome: "walk_away",
        rounds: round,
        agentA: roleA,
        agentB: roleB,
      };
    }

    if (action.action === "reject") {
      // If it's a flat reject with no new offer, check if we're stuck
      const rejectCount = events.filter(
        (e) => e.action === "reject" && e.agent === agentRole
      ).length;
      if (rejectCount >= 3) {
        // This agent keeps rejecting without countering — likely deadlock
        // Let the loop continue but it'll hit timeout
      }
    }

    // Queue message for the other agent (delivered NEXT turn — 1-turn delay)
    const messageForOther = buildMessageForOther(action, agentRole);
    if (currentAgent === "A") {
      pendingForB = `Round ${round + 1}. ${messageForOther}`;
    } else {
      pendingForA = `Round ${round + 1}. ${messageForOther}`;
    }

    // Alternate turns
    currentAgent = currentAgent === "A" ? "B" : "A";
  }

  // Hit round limit
  return {
    pair,
    events,
    outcome: "timeout",
    rounds: maxRounds,
    agentA: roleA,
    agentB: roleB,
  };
}

function buildMessageForOther(
  action: { action: string; price?: number; message: string },
  fromRole: AgentRole
): string {
  switch (action.action) {
    case "make_offer":
      return `The ${fromRole} has offered $${action.price!.toFixed(2)}. They said: "${action.message}". You may accept, reject, counter with your own offer, or walk away.`;
    case "reject":
      return `The ${fromRole} rejected your offer. They said: "${action.message}". You may make a new offer, check market price, or walk away.`;
    case "check_market_price":
      return `The ${fromRole} is still deliberating. No new offer yet. You may make an offer, check market price, or wait.`;
    default:
      return `The ${fromRole} took action: ${action.action}. Message: "${action.message}"`;
  }
}

// ── Failure Diagnosis ───────────────────────────────────────

function diagnoseFailure(
  negotiations: NegotiationResult[],
  config: RunConfig
): FailureDiagnosis {
  const allSucceeded = negotiations.every((n) => n.outcome === "deal");
  if (allSucceeded) {
    return { type: null, description: "All negotiations succeeded." };
  }

  const failed = negotiations.find((n) => n.outcome !== "deal");
  if (!failed) return { type: null, description: "No failure." };

  const events = failed.events;

  // Check for tool failures causing breakdown
  const toolErrors = events.filter((e) => !e.toolSuccess);
  if (toolErrors.length >= 2) {
    return {
      type: "tool_failure",
      description: `${toolErrors.length} tool failures occurred during ${failed.pair}. Market data was unavailable, preventing informed decision-making.`,
    };
  }

  // Check if market conditions made deal impossible (systemic)
  const sellerReservation = events.find(
    (e) => e.agent === failed.agentA
  )?.reservationPrice;
  const buyerReservation = events.find(
    (e) => e.agent === failed.agentB
  )?.reservationPrice;

  if (
    sellerReservation != null &&
    buyerReservation != null &&
    sellerReservation > buyerReservation
  ) {
    return {
      type: "systemic",
      description: `No deal was possible: ${failed.agentA}'s minimum ($${sellerReservation.toFixed(2)}) exceeds ${failed.agentB}'s maximum ($${buyerReservation.toFixed(2)}). The price gap of $${(sellerReservation - buyerReservation).toFixed(2)} makes any deal impossible.`,
      priceGap: sellerReservation - buyerReservation,
    };
  }

  // Check for walk-away (single agent decision)
  const walkAway = events.find((e) => e.action === "walk_away");
  if (walkAway) {
    // Was it premature?
    const offers = events.filter((e) => e.action === "make_offer");
    const lastOffer = offers[offers.length - 1];
    const couldHaveDealt =
      lastOffer &&
      buyerReservation != null &&
      sellerReservation != null &&
      lastOffer.price != null &&
      lastOffer.price >= sellerReservation &&
      lastOffer.price <= buyerReservation;

    return {
      type: "single_agent_decision",
      description: `${walkAway.agent} walked away in round ${walkAway.round}. ${couldHaveDealt ? "A deal was still possible — this may have been premature." : "The offers were trending away from agreement."}`,
      agent: walkAway.agent,
    };
  }

  // Check market price divergence
  const marketPrices = events
    .filter((e) => e.marketPriceSeen != null)
    .map((e) => ({ agent: e.agent, seen: e.marketPriceSeen! }));

  if (marketPrices.length >= 2) {
    const prices = marketPrices.map((p) => p.seen);
    const divergence = Math.max(...prices) - Math.min(...prices);
    const avgPrice =
      prices.reduce((a, b) => a + b, 0) / prices.length;
    const divergencePct = (divergence / avgPrice) * 100;

    if (divergencePct > 15) {
      return {
        type: "interaction_mismatch",
        description: `Agents saw significantly different market prices (${divergencePct.toFixed(1)}% divergence). This information asymmetry prevented convergence.`,
        marketDivergence: divergencePct,
      };
    }
  }

  // Default: interaction mismatch
  return {
    type: "interaction_mismatch",
    description: `Agents couldn't converge within ${failed.rounds} rounds. Offers did not trend toward agreement.`,
  };
}

// ── Main Orchestrator ───────────────────────────────────────

export interface OrchestratorConfig {
  product: string;
  marketBasePrice: number;
  supplierReservation: number;      // supplier's min sell price
  manufacturerBuyMax: number;       // max mfg will pay for raw materials
  manufacturerSellMin: number;      // min mfg will sell finished goods for (set after deal 1)
  manufacturerMarkup: number;       // percentage markup over raw material cost
  retailerMaxPrice: number;         // retailer's max buy price
  maxRoundsPerNegotiation: number;
  marketNoiseRange: number;         // e.g., 0.1 = ±10%
  toolFailureRate: number;          // e.g., 0.1 = 10%
  staleDataRate: number;
}

export async function orchestrate(cfg: OrchestratorConfig): Promise<RunOutput> {
  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const startedAt = new Date();
  console.log(`\n═══ Run ${runId} ═══`);
  console.log(`Product: ${cfg.product}`);
  console.log(
    `Market base: $${cfg.marketBasePrice} | Noise: ±${(cfg.marketNoiseRange * 100).toFixed(0)}% | Tool fail: ${(cfg.toolFailureRate * 100).toFixed(0)}%`
  );

  const runConfig: RunConfig = {
    product: cfg.product,
    marketBasePrice: cfg.marketBasePrice,
    agents: [
      { role: "supplier", reservationPrice: cfg.supplierReservation },
      { role: "manufacturer", reservationPrice: cfg.manufacturerBuyMax },
      { role: "retailer", reservationPrice: cfg.retailerMaxPrice },
    ],
    maxRoundsPerNegotiation: cfg.maxRoundsPerNegotiation,
    marketNoiseRange: cfg.marketNoiseRange,
    toolFailureRate: cfg.toolFailureRate,
  };

  const negotiations: NegotiationResult[] = [];

  // ── Negotiation 1: Supplier ↔ Manufacturer ────────────────
  console.log(`\n─── Negotiation 1: Supplier ↔ Manufacturer ───`);

  const rawMarketConfig: MarketConfig = {
    product: cfg.product,
    basePrice: cfg.marketBasePrice,
    noiseRange: cfg.marketNoiseRange,
    failureRate: cfg.toolFailureRate,
    staleDataRate: cfg.staleDataRate,
  };
  initMarket(rawMarketConfig);

  const supplier = new Agent(
    {
      role: "supplier",
      reservationPrice: cfg.supplierReservation,
      systemPrompt: buildSupplierPrompt(cfg.product, cfg.supplierReservation),
    },
    rawMarketConfig
  );

  const manufacturerBuyer = new Agent(
    {
      role: "manufacturer",
      reservationPrice: cfg.manufacturerBuyMax,
      systemPrompt: buildManufacturerBuyerPrompt(
        cfg.product,
        cfg.manufacturerBuyMax
      ),
    },
    rawMarketConfig
  );

  const neg1 = await runNegotiation(
    {
      pair: "supplier_manufacturer",
      agentA: supplier,
      agentB: manufacturerBuyer,
      roleA: "supplier",
      roleB: "manufacturer",
    },
    runId,
    cfg.maxRoundsPerNegotiation
  );
  negotiations.push(neg1);

  console.log(
    `\n  Result: ${neg1.outcome}${neg1.finalPrice != null ? ` @ $${neg1.finalPrice.toFixed(2)}` : ""} (${neg1.rounds} rounds)`
  );

  // ── Negotiation 2: Manufacturer ↔ Retailer ────────────────
  // (only runs if deal 1 succeeded, but we run it anyway to show cascade)
  console.log(`\n─── Negotiation 2: Manufacturer ↔ Retailer ───`);

  let mfgCostBasis: number;
  let mfgSellReservation: number;

  if (neg1.outcome === "deal" && neg1.finalPrice != null) {
    // Cascading: manufacturer's cost basis = what they paid the supplier
    mfgCostBasis = neg1.finalPrice;
    mfgSellReservation = mfgCostBasis * (1 + cfg.manufacturerMarkup);
  } else {
    // Deal 1 failed — manufacturer uses their expected cost
    mfgCostBasis = cfg.marketBasePrice;
    mfgSellReservation = cfg.manufacturerSellMin;
    console.log(
      `  (Deal 1 failed — manufacturer using estimated cost basis $${mfgCostBasis.toFixed(2)})`
    );
  }

  // Finished goods market is higher than raw materials
  const finishedGoodsMarketConfig: MarketConfig = {
    product: `${cfg.product} (finished goods)`,
    basePrice: cfg.marketBasePrice * (1 + cfg.manufacturerMarkup + 0.15),
    noiseRange: cfg.marketNoiseRange,
    failureRate: cfg.toolFailureRate,
    staleDataRate: cfg.staleDataRate,
  };
  initMarket(finishedGoodsMarketConfig);

  const manufacturerSeller = new Agent(
    {
      role: "manufacturer",
      reservationPrice: mfgSellReservation,
      systemPrompt: buildManufacturerSellerPrompt(
        cfg.product,
        mfgCostBasis,
        mfgSellReservation
      ),
    },
    finishedGoodsMarketConfig
  );

  const retailer = new Agent(
    {
      role: "retailer",
      reservationPrice: cfg.retailerMaxPrice,
      systemPrompt: buildRetailerPrompt(cfg.product, cfg.retailerMaxPrice),
    },
    finishedGoodsMarketConfig
  );

  const neg2 = await runNegotiation(
    {
      pair: "manufacturer_retailer",
      agentA: manufacturerSeller,
      agentB: retailer,
      roleA: "manufacturer",
      roleB: "retailer",
    },
    runId,
    cfg.maxRoundsPerNegotiation
  );
  negotiations.push(neg2);

  console.log(
    `\n  Result: ${neg2.outcome}${neg2.finalPrice != null ? ` @ $${neg2.finalPrice.toFixed(2)}` : ""} (${neg2.rounds} rounds)`
  );

  // ── Overall outcome ───────────────────────────────────────
  const overallOutcome =
    neg1.outcome === "deal" && neg2.outcome === "deal" ? "success" : "failure";

  const diagnosis = diagnoseFailure(negotiations, runConfig);

  const finishedAt = new Date();

  const output: RunOutput = {
    runId,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    config: runConfig,
    negotiations,
    overallOutcome,
    failureDiagnosis: diagnosis,
  };

  console.log(`\n═══ Overall: ${overallOutcome.toUpperCase()} ═══`);
  if (diagnosis.type) {
    console.log(`  Diagnosis: [${diagnosis.type}] ${diagnosis.description}`);
  }

  return output;
}
