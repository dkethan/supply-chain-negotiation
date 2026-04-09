import { logfire } from "./instrumentation.js";
import { orchestrate, type OrchestratorConfig } from "./orchestrator.js";
import type { RunOutput } from "./types.js";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

// ── Scenario configs to vary across runs ────────────────────
const SCENARIOS: OrchestratorConfig[] = [
  {
    // Scenario 1: Easy deal — wide overlap
    product: "Steel Coils",
    marketBasePrice: 50,
    supplierReservation: 35,
    manufacturerBuyMax: 60,
    manufacturerSellMin: 65,
    manufacturerMarkup: 0.4,
    retailerMaxPrice: 95,
    maxRoundsPerNegotiation: 10,
    marketNoiseRange: 0.08,
    toolFailureRate: 0.0,
    staleDataRate: 0.0,
  },
  {
    // Scenario 2: Tight margins — narrow overlap
    product: "Copper Wire",
    marketBasePrice: 100,
    supplierReservation: 90,
    manufacturerBuyMax: 105,
    manufacturerSellMin: 130,
    manufacturerMarkup: 0.3,
    retailerMaxPrice: 140,
    maxRoundsPerNegotiation: 10,
    marketNoiseRange: 0.12,
    toolFailureRate: 0.05,
    staleDataRate: 0.1,
  },
  {
    // Scenario 3: Impossible deal — no overlap
    product: "Titanium Alloy",
    marketBasePrice: 200,
    supplierReservation: 190,
    manufacturerBuyMax: 180,
    manufacturerSellMin: 250,
    manufacturerMarkup: 0.35,
    retailerMaxPrice: 260,
    maxRoundsPerNegotiation: 8,
    marketNoiseRange: 0.15,
    toolFailureRate: 0.1,
    staleDataRate: 0.15,
  },
  {
    // Scenario 4: Tool chaos — high failure rate
    product: "Aluminum Sheets",
    marketBasePrice: 75,
    supplierReservation: 60,
    manufacturerBuyMax: 85,
    manufacturerSellMin: 95,
    manufacturerMarkup: 0.35,
    retailerMaxPrice: 120,
    maxRoundsPerNegotiation: 10,
    marketNoiseRange: 0.2,
    toolFailureRate: 0.25,
    staleDataRate: 0.2,
  },
  {
    // Scenario 5: Cascade pressure — deal 1 eats all margin
    product: "Carbon Fiber",
    marketBasePrice: 150,
    supplierReservation: 130,
    manufacturerBuyMax: 165,
    manufacturerSellMin: 200,
    manufacturerMarkup: 0.25,
    retailerMaxPrice: 195,
    maxRoundsPerNegotiation: 10,
    marketNoiseRange: 0.1,
    toolFailureRate: 0.05,
    staleDataRate: 0.05,
  },
];

async function main() {
  const scenarioIdx = parseInt(process.argv[2] || "0", 10);
  const scenario = SCENARIOS[scenarioIdx % SCENARIOS.length];

  mkdirSync(join(process.cwd(), "runs"), { recursive: true });

  const output = await logfire.span(`run:${scenario.product}`, {
    callback: async () => {
      return await orchestrate(scenario);
    },
  }) as RunOutput;

  const outPath = join(process.cwd(), "runs", `${output.runId}.json`);
  writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nRun saved to: ${outPath}`);
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
