import { logfire } from "./instrumentation.js";
import { orchestrate, type OrchestratorConfig } from "./orchestrator.js";
import type { RunOutput } from "./types.js";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const SCENARIOS: OrchestratorConfig[] = [
  {
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
  mkdirSync(join(process.cwd(), "runs"), { recursive: true });

  const results = [];

  for (let i = 0; i < SCENARIOS.length; i++) {
    const scenario = SCENARIOS[i];

    try {
      const output = await logfire.span(
        `batch:${scenario.product}`,
        {
          callback: async () => {
            return await orchestrate(scenario);
          },
        }
      ) as RunOutput;

      const outPath = join(process.cwd(), "runs", `${output.runId}.json`);
      writeFileSync(outPath, JSON.stringify(output, null, 2));
      console.log(`Saved: ${outPath}`);
      results.push({
        product: scenario.product,
        outcome: output.overallOutcome,
        runId: output.runId,
      });
    } catch (err) {
      console.error(`Scenario ${i} (${scenario.product}) failed:`, err);
      results.push({
        product: scenario.product,
        outcome: "error",
        error: String(err),
      });
    }

    // Brief pause between runs
    await new Promise((r) => setTimeout(r, 1000));
  }

  console.log("\n═══ Batch Summary ═══");
  for (const r of results) {
    console.log(`  ${r.product}: ${r.outcome}`);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
