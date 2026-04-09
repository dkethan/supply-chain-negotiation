// ── Agent Roles ──────────────────────────────────────────────
export type AgentRole = "supplier" | "manufacturer" | "retailer";

export type NegotiationPair = "supplier_manufacturer" | "manufacturer_retailer";

// ── Actions ─────────────────────────────────────────────────
export type ActionType =
  | "make_offer"
  | "counter_offer"
  | "accept"
  | "reject"
  | "walk_away"
  | "check_market_price";

// ── Agent Config ────────────────────────────────────────────
export interface AgentConfig {
  role: AgentRole;
  reservationPrice: number; // min acceptable (supplier) or max willing to pay (manufacturer/retailer)
  systemPrompt: string;
}

// ── Market Config ───────────────────────────────────────────
export interface MarketConfig {
  product: string;
  basePrice: number;
  noiseRange: number;       // ±percentage for per-agent noise
  failureRate: number;      // probability of tool failure (0-1)
  staleDataRate: number;    // probability of returning outdated price
}

// ── LLM call capture ────────────────────────────────────────
export interface LlmCall {
  input: string;        // situation/prompt sent to the LLM this turn
  output: string;       // LLM response (content + tool call description)
  tokens?: number;      // total tokens used (all LLM calls this turn)
  latencyMs: number;    // total LLM time this turn (all calls combined)
}

// ── Tool call capture ────────────────────────────────────────
export interface ToolCallDetail {
  name: string;
  input: Record<string, unknown>;
  output: unknown;
  latencyMs: number;
  success: boolean;
  isStale?: boolean;
  error?: string;
}

// ── Negotiation Event (the core trace unit) ─────────────────
export interface NegotiationEvent {
  timestamp: string;
  runId: string;
  traceId: string;    // identifies the negotiation trace (runId + pair)
  spanId: string;     // identifies this specific turn (traceId + round + agent)
  negotiation: NegotiationPair;
  round: number;
  agent: AgentRole;
  action: ActionType;
  price?: number;
  reservationPrice: number;
  marketPriceSeen?: number;
  marketPriceActual?: number;   // the "real" base price for comparison
  margin?: number;              // price - reservationPrice (negative = selling at loss)
  llm: LlmCall;
  toolCallDetail?: ToolCallDetail;
  latencyMs: number;            // total turn latency
  toolSuccess: boolean;
  toolError?: string;
  messageDeliveredRound?: number; // the round the other agent will see this
}

// ── Negotiation Result ──────────────────────────────────────
export type NegotiationOutcome = "deal" | "walk_away" | "timeout" | "rejection";

export interface NegotiationResult {
  pair: NegotiationPair;
  events: NegotiationEvent[];
  outcome: NegotiationOutcome;
  finalPrice?: number;
  rounds: number;
  agentA: AgentRole;
  agentB: AgentRole;
}

// ── Failure Attribution ─────────────────────────────────────
export type FailureType =
  | "single_agent_decision"    // one agent made a bad call
  | "interaction_mismatch"     // agents couldn't converge
  | "systemic"                 // market conditions made deal impossible
  | "tool_failure"             // tool errors caused breakdown
  | null;                      // success — no failure

export interface FailureDiagnosis {
  type: FailureType;
  description: string;
  agent?: AgentRole;
  priceGap?: number;           // gap between final offers
  marketDivergence?: number;   // how different agents' market views were
}

// ── Run Analysis ────────────────────────────────────────────
export interface RunAnalysis {
  what_happened: string;
  why: string[];
  issues: string[];   // problematic agent behaviors (e.g. negative margin, premature walk-away)
  what_to_fix: string[];
}

// ── Full Run Output ─────────────────────────────────────────
export interface RunConfig {
  product: string;
  marketBasePrice: number;
  agents: {
    role: AgentRole;
    reservationPrice: number;
  }[];
  maxRoundsPerNegotiation: number;
  marketNoiseRange: number;
  toolFailureRate: number;
}

export interface RunOutput {
  runId: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  config: RunConfig;
  negotiations: NegotiationResult[];
  overallOutcome: "success" | "failure";
  failureDiagnosis: FailureDiagnosis;
  analysis: RunAnalysis;
}
