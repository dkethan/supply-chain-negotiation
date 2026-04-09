# Supply Chain Negotiation Simulation

Multi-agent supply chain negotiation simulation where three LLM-powered agents (supplier, manufacturer, retailer) negotiate deals across a supply chain, with full structured tracing and a diagnostic viewer.

## Architecture

```
Orchestrator (code)
  │
  ├── Negotiation 1: Supplier ↔ Manufacturer
  │     └── Turn loop → OpenAI function calling → events logged
  │
  └── Negotiation 2: Manufacturer ↔ Retailer
        └── Turn loop → cost basis cascades from Deal 1
```

**Agents**: Each agent is an OpenAI `gpt-4o-mini` completion with function-calling tools (`check_market_price`, `make_offer`, `accept_offer`, `reject_offer`, `walk_away`, `review_past_offers`).

**Market simulation**: `check_market_price` returns noisy, per-agent prices (±8-20%). Tool calls can fail or return stale data, mimicking real-world system behavior.

**Cascading outcomes**: The price from Deal 1 becomes the manufacturer's cost basis for Deal 2, compressing or expanding their margin.

**Message delay**: Offers are delivered on the _next_ turn, not instantly, simulating async communication.

## Setup

```bash
npm install
cp .env.example .env
# Add your OPENAI_API_KEY and LOGFIRE_TOKEN to .env
```

## Run

```bash
# Single scenario (0-4)
npx tsx src/run.ts 0

# All 5 scenarios
npx tsx src/multi-run.ts
```

Output goes to `runs/*.json`.

## Scenarios

| # | Product | Difficulty | Notes |
|---|---------|-----------|-------|
| 0 | Steel Coils | Easy | Wide price overlap, no tool failures |
| 1 | Copper Wire | Medium | Tight margins, some noise and failures |
| 2 | Titanium Alloy | Impossible | No overlap — tests systemic failure |
| 3 | Aluminum Sheets | Chaotic | 25% tool failure rate, high noise |
| 4 | Carbon Fiber | Cascade trap | Deal 1 can eat all margin for Deal 2 |

## Viewer

Open `viewer/index.html` in a browser and drag in one or more `runs/*.json` files.

**Features:**
- Cross-run summary table with outcome/failure type
- Click any run to drill in
- Price convergence charts with reservation price reference lines
- Supply chain cascade flow showing margin at each stage
- Market price divergence per agent
- Round-by-round timeline with reasoning
- Automated failure diagnosis and recommendations

## Traces

Pydantic Logfire captures OpenTelemetry spans for every run, negotiation, and turn. The Logfire dashboard shows:
- Full request/response for each LLM call
- Tool call latency and success/failure
- Nested span hierarchy: run → negotiation → turn

## Event Schema

Each agent action produces a structured event:

```json
{
  "timestamp": "2026-04-09T...",
  "runId": "run_...",
  "negotiation": "supplier_manufacturer",
  "round": 3,
  "agent": "supplier",
  "action": "make_offer",
  "price": 48.50,
  "reservationPrice": 35.00,
  "marketPriceSeen": 52.00,
  "marketPriceActual": 50.00,
  "margin": 13.50,
  "reasoning": "Offering slightly below market...",
  "toolSuccess": true,
  "messageDeliveredRound": 4
}
```

## Tech Stack

- **Runtime**: Node.js + TypeScript
- **LLM**: OpenAI GPT-4o-mini with function calling
- **Observability**: Pydantic Logfire (OpenTelemetry)
- **Viewer**: Vanilla HTML/JS + Chart.js

## Submission Checklist

- [ ] This repo (commit early and often)
- [ ] `runs/` folder with 5+ JSON files (mix of outcomes)
- [ ] Logfire project link
- [ ] 1-3 min Loom walkthrough
- [ ] AI conversation history (this chat)
