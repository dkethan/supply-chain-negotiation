import OpenAI from "openai";
import type {
  ChatCompletionMessageParam,
  ChatCompletionToolMessageParam,
} from "openai/resources/chat/completions";
import { NEGOTIATION_TOOLS } from "./tools.js";
import { checkMarketPrice } from "./market.js";
import { logfire } from "./instrumentation.js";
import type {
  AgentRole,
  AgentConfig,
  MarketConfig,
  ActionType,
  NegotiationEvent,
  NegotiationPair,
  ToolCallDetail,
} from "./types.js";

const openai = new OpenAI();

export interface AgentAction {
  action: ActionType;
  price?: number;
  message: string;
  marketPriceSeen?: number;
  marketPriceActual?: number;
  toolSuccess: boolean;
  toolError?: string;
  // Tracing fields
  llmInput: string;
  llmOutput: string;
  llmTokens: number;
  llmLatencyMs: number;
  toolCallDetail?: ToolCallDetail;
  turnLatencyMs: number;
}

function formatLlmOutput(msg: { content: string | null; tool_calls?: { function: { name: string; arguments: string } }[] }): string {
  const parts: string[] = [];
  if (msg.content) parts.push(msg.content);
  if (msg.tool_calls && msg.tool_calls.length > 0) {
    for (const tc of msg.tool_calls) {
      parts.push(`[tool_call: ${tc.function.name}(${tc.function.arguments})]`);
    }
  }
  return parts.join(" | ") || "(no output)";
}

export class Agent {
  readonly role: AgentRole;
  readonly reservationPrice: number;
  private messages: ChatCompletionMessageParam[];
  private config: AgentConfig;
  private marketConfig: MarketConfig;
  private offerHistory: { round: number; agent: string; price: number }[] = [];

  constructor(agentConfig: AgentConfig, marketConfig: MarketConfig) {
    this.role = agentConfig.role;
    this.reservationPrice = agentConfig.reservationPrice;
    this.config = agentConfig;
    this.marketConfig = marketConfig;
    this.messages = [{ role: "system", content: agentConfig.systemPrompt }];
  }

  addOfferToHistory(round: number, agent: string, price: number) {
    this.offerHistory.push({ round, agent, price });
  }

  async takeTurn(
    roundNumber: number,
    situationUpdate: string,
    runId: string,
    negotiation: NegotiationPair
  ): Promise<{ action: AgentAction; event: NegotiationEvent }> {
    return logfire.span(`agent.turn`, {
      attributes: { role: this.role, round: roundNumber, negotiation },
      callback: async () => {
        const turnStart = Date.now();

        // Add the situation update as a user message
        this.messages.push({ role: "user", content: situationUpdate });

        // Call OpenAI with tools
        const llmStart = Date.now();
        const response = await logfire.span(`llm_call`, {
          attributes: { model: "gpt-4o-mini", round: roundNumber, role: this.role, purpose: "decide_action" },
          callback: () =>
            openai.chat.completions.create({
              model: "gpt-4o-mini",
              messages: this.messages,
              tools: NEGOTIATION_TOOLS,
              tool_choice: "required",
              parallel_tool_calls: false,
              temperature: 0.7,
            }),
        });
        const firstLlmLatencyMs = Date.now() - llmStart;

        const assistantMsg = response.choices[0].message;
        this.messages.push(assistantMsg);
        let totalTokens = response.usage?.total_tokens ?? 0;

        // If no tool call (shouldn't happen with tool_choice: required)
        if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
          return this.buildResult(roundNumber, runId, negotiation, {
            action: "reject",
            message: assistantMsg.content || "No action taken",
            toolSuccess: true,
            llmInput: situationUpdate,
            llmOutput: formatLlmOutput(assistantMsg),
            llmTokens: totalTokens,
            llmLatencyMs: firstLlmLatencyMs,
            turnLatencyMs: Date.now() - turnStart,
          });
        }

        // Process the first tool call
        const toolCall = assistantMsg.tool_calls[0];
        const fnName = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments);

        let agentAction: AgentAction;

        switch (fnName) {
          case "check_market_price": {
            const toolStart = Date.now();
            const result = await logfire.span(`tool_call`, {
              attributes: { tool: "check_market_price", role: this.role, round: roundNumber },
              callback: () => Promise.resolve(checkMarketPrice(this.role, this.marketConfig)),
            });
            const toolLatencyMs = Date.now() - toolStart;

            const toolCallDetail: ToolCallDetail = {
              name: "check_market_price",
              input: { product: args.product ?? this.marketConfig.product },
              output: result.success ? result.price : result.error,
              latencyMs: toolLatencyMs,
              success: result.success,
              isStale: result.isStale,
              error: result.error,
            };

            let toolResponse: string;
            if (result.success) {
              toolResponse = `Market reference price for ${args.product}: $${result.price!.toFixed(2)}${result.isStale ? " (note: data may be slightly delayed)" : ""}`;
            } else {
              toolResponse = `Error: ${result.error}`;
            }

            // Send tool result back and get the agent's actual action
            const toolMsg: ChatCompletionToolMessageParam = {
              role: "tool",
              tool_call_id: toolCall.id,
              content: toolResponse,
            };
            this.messages.push(toolMsg);

            // Agent needs to take an actual negotiation action after checking price
            const followUpLlmStart = Date.now();
            const followUp = await logfire.span(`llm_call`, {
              attributes: { model: "gpt-4o-mini", round: roundNumber, role: this.role, purpose: "act_after_market_check" },
              callback: () =>
                openai.chat.completions.create({
                  model: "gpt-4o-mini",
                  messages: this.messages,
                  tools: NEGOTIATION_TOOLS.filter(
                    (t) => t.function.name !== "check_market_price"
                  ),
                  tool_choice: "required",
                  parallel_tool_calls: false,
                  temperature: 0.7,
                }),
            });
            const followUpLlmLatencyMs = Date.now() - followUpLlmStart;
            totalTokens += followUp.usage?.total_tokens ?? 0;

            const followUpMsg = followUp.choices[0].message;
            this.messages.push(followUpMsg);

            if (followUpMsg.tool_calls && followUpMsg.tool_calls.length > 0) {
              const followUpCall = followUpMsg.tool_calls[0];
              const followUpArgs = JSON.parse(followUpCall.function.arguments);
              agentAction = {
                action: followUpCall.function.name as ActionType,
                price: followUpArgs.price,
                message: followUpArgs.message || followUpMsg.content || "",
                marketPriceSeen: result.price,
                marketPriceActual: result.actualBasePrice,
                toolSuccess: result.success,
                toolError: result.error,
                llmInput: situationUpdate,
                llmOutput: formatLlmOutput(followUpMsg),
                llmTokens: totalTokens,
                llmLatencyMs: firstLlmLatencyMs + followUpLlmLatencyMs,
                toolCallDetail,
                turnLatencyMs: Date.now() - turnStart,
              };

              // Add tool result for the follow-up tool call
              this.messages.push({
                role: "tool",
                tool_call_id: followUpCall.id,
                content: `Action ${followUpCall.function.name} acknowledged.`,
              });
            } else {
              agentAction = {
                action: "reject",
                message: followUpMsg.content || "Checked price, no action",
                marketPriceSeen: result.price,
                marketPriceActual: result.actualBasePrice,
                toolSuccess: result.success,
                toolError: result.error,
                llmInput: situationUpdate,
                llmOutput: formatLlmOutput(followUpMsg),
                llmTokens: totalTokens,
                llmLatencyMs: firstLlmLatencyMs + followUpLlmLatencyMs,
                toolCallDetail,
                turnLatencyMs: Date.now() - turnStart,
              };
            }
            break;
          }

          case "review_past_offers": {
            const toolStart = Date.now();
            const historyStr = await logfire.span(`tool_call`, {
              attributes: { tool: "review_past_offers", role: this.role, round: roundNumber, offerCount: this.offerHistory.length },
              callback: () =>
                Promise.resolve(
                  this.offerHistory.length === 0
                    ? "No offers have been made yet."
                    : this.offerHistory
                        .map(
                          (o) =>
                            `Round ${o.round}: ${o.agent} offered $${o.price.toFixed(2)}`
                        )
                        .join("\n")
                ),
            });
            const toolLatencyMs = Date.now() - toolStart;

            const toolCallDetail: ToolCallDetail = {
              name: "review_past_offers",
              input: {},
              output: historyStr,
              latencyMs: toolLatencyMs,
              success: true,
            };

            this.messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: historyStr,
            });

            // After reviewing, agent needs to act
            const reviewLlmStart = Date.now();
            const reviewFollowUp = await logfire.span(`llm_call`, {
              attributes: { model: "gpt-4o-mini", round: roundNumber, role: this.role, purpose: "act_after_offer_review" },
              callback: () =>
                openai.chat.completions.create({
                  model: "gpt-4o-mini",
                  messages: this.messages,
                  tools: NEGOTIATION_TOOLS.filter(
                    (t) =>
                      t.function.name !== "review_past_offers" &&
                      t.function.name !== "check_market_price"
                  ),
                  tool_choice: "required",
                  parallel_tool_calls: false,
                  temperature: 0.7,
                }),
            });
            const reviewLlmLatencyMs = Date.now() - reviewLlmStart;
            totalTokens += reviewFollowUp.usage?.total_tokens ?? 0;

            const rfMsg = reviewFollowUp.choices[0].message;
            this.messages.push(rfMsg);

            if (rfMsg.tool_calls && rfMsg.tool_calls.length > 0) {
              const rfCall = rfMsg.tool_calls[0];
              const rfArgs = JSON.parse(rfCall.function.arguments);
              agentAction = {
                action: rfCall.function.name as ActionType,
                price: rfArgs.price,
                message: rfArgs.message || rfMsg.content || "",
                toolSuccess: true,
                llmInput: situationUpdate,
                llmOutput: formatLlmOutput(rfMsg),
                llmTokens: totalTokens,
                llmLatencyMs: firstLlmLatencyMs + reviewLlmLatencyMs,
                toolCallDetail,
                turnLatencyMs: Date.now() - turnStart,
              };
              this.messages.push({
                role: "tool",
                tool_call_id: rfCall.id,
                content: `Action ${rfCall.function.name} acknowledged.`,
              });
            } else {
              agentAction = {
                action: "reject",
                message: rfMsg.content || "Reviewed offers, no action",
                toolSuccess: true,
                llmInput: situationUpdate,
                llmOutput: formatLlmOutput(rfMsg),
                llmTokens: totalTokens,
                llmLatencyMs: firstLlmLatencyMs + reviewLlmLatencyMs,
                toolCallDetail,
                turnLatencyMs: Date.now() - turnStart,
              };
            }
            break;
          }

          case "make_offer":
          case "counter_offer": {
            agentAction = {
              action: "make_offer",
              price: args.price,
              message: args.message || "",
              toolSuccess: true,
              llmInput: situationUpdate,
              llmOutput: formatLlmOutput(assistantMsg),
              llmTokens: totalTokens,
              llmLatencyMs: firstLlmLatencyMs,
              turnLatencyMs: Date.now() - turnStart,
            };
            this.messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: `Offer of $${args.price.toFixed(2)} sent.`,
            });
            break;
          }

          case "accept_offer": {
            agentAction = {
              action: "accept",
              message: args.message || "",
              toolSuccess: true,
              llmInput: situationUpdate,
              llmOutput: formatLlmOutput(assistantMsg),
              llmTokens: totalTokens,
              llmLatencyMs: firstLlmLatencyMs,
              turnLatencyMs: Date.now() - turnStart,
            };
            this.messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: "Offer accepted. Deal closed.",
            });
            break;
          }

          case "reject_offer": {
            agentAction = {
              action: "reject",
              message: args.message || "",
              toolSuccess: true,
              llmInput: situationUpdate,
              llmOutput: formatLlmOutput(assistantMsg),
              llmTokens: totalTokens,
              llmLatencyMs: firstLlmLatencyMs,
              turnLatencyMs: Date.now() - turnStart,
            };
            this.messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: "Offer rejected.",
            });
            break;
          }

          case "walk_away": {
            agentAction = {
              action: "walk_away",
              message: args.message || "",
              toolSuccess: true,
              llmInput: situationUpdate,
              llmOutput: formatLlmOutput(assistantMsg),
              llmTokens: totalTokens,
              llmLatencyMs: firstLlmLatencyMs,
              turnLatencyMs: Date.now() - turnStart,
            };
            this.messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: "You have walked away. Negotiation over.",
            });
            break;
          }

          default: {
            agentAction = {
              action: "reject",
              message: `Unknown action: ${fnName}`,
              toolSuccess: false,
              toolError: `Unknown tool: ${fnName}`,
              llmInput: situationUpdate,
              llmOutput: formatLlmOutput(assistantMsg),
              llmTokens: totalTokens,
              llmLatencyMs: firstLlmLatencyMs,
              turnLatencyMs: Date.now() - turnStart,
            };
          }
        }

        return this.buildResult(roundNumber, runId, negotiation, agentAction);
      },
    });
  }

  private buildResult(
    round: number,
    runId: string,
    negotiation: NegotiationPair,
    action: AgentAction
  ): { action: AgentAction; event: NegotiationEvent } {
    const margin =
      action.price != null
        ? this.role === "supplier"
          ? action.price - this.reservationPrice
          : this.reservationPrice - action.price
        : undefined;

    const traceId = `${runId}::${negotiation}`;
    const spanId = `${traceId}::r${round}::${this.role}`;

    const event: NegotiationEvent = {
      timestamp: new Date().toISOString(),
      runId,
      traceId,
      spanId,
      negotiation,
      round,
      agent: this.role,
      action: action.action,
      price: action.price,
      reservationPrice: this.reservationPrice,
      marketPriceSeen: action.marketPriceSeen,
      marketPriceActual: action.marketPriceActual,
      margin,
      llm: {
        input: action.llmInput,
        output: action.llmOutput,
        tokens: action.llmTokens,
        latencyMs: action.llmLatencyMs,
      },
      toolCallDetail: action.toolCallDetail,
      latencyMs: action.turnLatencyMs,
      toolSuccess: action.toolSuccess,
      toolError: action.toolError,
      messageDeliveredRound: round + 1, // delivered next turn
    };

    return { action, event };
  }
}

// ── System prompt builders ──────────────────────────────────

export function buildSupplierPrompt(
  product: string,
  reservationPrice: number
): string {
  return `You are a SUPPLIER selling raw materials (${product}) to a manufacturer.

Your minimum acceptable price (walk-away price): $${reservationPrice.toFixed(2)}
You MUST NOT accept any deal below this price. You want to sell as HIGH above this as possible.

You are in a bilateral negotiation. Each round, you see the other party's latest action and must respond with exactly ONE tool call.

Strategy tips:
- Lead with an offer — don't burn your first turn just checking market price
- You can check market price mid-negotiation if you're unsure whether to accept
- Open with an ambitious but not absurd offer (market price ± 20% is reasonable)
- Make concessions gradually, not all at once
- If the buyer's offers are consistently below your floor, walk away
- You don't know the buyer's budget — probe with your offers

Keep messages short and professional.`;
}

export function buildManufacturerBuyerPrompt(
  product: string,
  maxPrice: number
): string {
  return `You are a MANUFACTURER buying raw materials (${product}) from a supplier.

Your maximum acceptable price (walk-away price): $${maxPrice.toFixed(2)}
You MUST NOT accept any deal above this price. You want to buy as LOW below this as possible.

The lower you buy, the more margin you'll have when selling finished goods to retailers later.

You are in a bilateral negotiation. Each round, you see the other party's latest action and must respond with exactly ONE tool call.

Strategy tips:
- Lead with a low but reasonable offer — don't waste your first turn checking prices
- Use market price checks when deciding whether to accept or push back, not to open
- Every dollar saved here is margin for your next negotiation
- Be willing to walk away if the price doesn't work

Keep messages short and professional.`;
}

export function buildManufacturerSellerPrompt(
  product: string,
  costBasis: number,
  reservationPrice: number
): string {
  return `You are a MANUFACTURER selling finished goods (${product}) to a retailer.

You purchased raw materials at $${costBasis.toFixed(2)} per unit.
Your minimum acceptable price: $${reservationPrice.toFixed(2)}
You MUST NOT accept any deal below this price. You want to maximize your margin.

You are in a bilateral negotiation. Each round, you see the other party's latest action and must respond with exactly ONE tool call.

Strategy tips:
- Your cost basis is $${costBasis.toFixed(2)}, so anything above that is profit
- But your reservation price is $${reservationPrice.toFixed(2)} to ensure adequate margin
- Check the market price for finished goods
- Open with a strong ask given your costs

Keep messages short and professional.`;
}

export function buildRetailerPrompt(
  product: string,
  maxPrice: number
): string {
  return `You are a RETAILER buying finished goods (${product}) from a manufacturer.

Your maximum acceptable price: $${maxPrice.toFixed(2)}
You MUST NOT accept any deal above this price. You want to buy as LOW as possible to maximize retail margins.

You are in a bilateral negotiation. Each round, you see the other party's latest action and must respond with exactly ONE tool call.

Strategy tips:
- Open with a concrete offer — checking market price first just wastes a turn
- Start low and work up slowly; let the manufacturer justify their ask
- You're the end of the supply chain — you need margin for retail operations
- Use market price checks when evaluating whether a deal is worth it, not to open
- Walk away if the price makes retail unprofitable

Keep messages short and professional.`;
}
