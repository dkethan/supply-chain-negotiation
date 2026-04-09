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
    return logfire.span(
      `agent.turn`,
      { role: this.role, round: roundNumber, negotiation },
      async () => {
        // Add the situation update as a user message
        this.messages.push({ role: "user", content: situationUpdate });

        // Call OpenAI with tools
        const response = await logfire.span(
          `llm_call`,
          { model: "gpt-4o-mini", round: roundNumber, role: this.role, purpose: "decide_action" },
          () =>
            openai.chat.completions.create({
              model: "gpt-4o-mini",
              messages: this.messages,
              tools: NEGOTIATION_TOOLS,
              tool_choice: "required",
              parallel_tool_calls: false,
              temperature: 0.7,
            })
        );

        const assistantMsg = response.choices[0].message;
        this.messages.push(assistantMsg);

        const reasoning = assistantMsg.content || "";

        // If no tool call (shouldn't happen with tool_choice: required)
        if (!assistantMsg.tool_calls || assistantMsg.tool_calls.length === 0) {
          return this.buildResult(roundNumber, runId, negotiation, {
            action: "reject",
            message: reasoning || "No action taken",
            toolSuccess: true,
          });
        }

        // Process the first tool call
        const toolCall = assistantMsg.tool_calls[0];
        const fnName = toolCall.function.name;
        const args = JSON.parse(toolCall.function.arguments);

        let agentAction: AgentAction;

        switch (fnName) {
          case "check_market_price": {
            const result = await logfire.span(
              `tool_call`,
              { tool: "check_market_price", role: this.role, round: roundNumber },
              () => Promise.resolve(checkMarketPrice(this.role, this.marketConfig))
            );
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
            const followUp = await logfire.span(
              `llm_call`,
              { model: "gpt-4o-mini", round: roundNumber, role: this.role, purpose: "act_after_market_check" },
              () =>
                openai.chat.completions.create({
                  model: "gpt-4o-mini",
                  messages: this.messages,
                  tools: NEGOTIATION_TOOLS.filter(
                    (t) => t.function.name !== "check_market_price"
                  ),
                  tool_choice: "required",
                  parallel_tool_calls: false,
                  temperature: 0.7,
                })
            );

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
              };
            }
            break;
          }

          case "review_past_offers": {
            const historyStr = await logfire.span(
              `tool_call`,
              { tool: "review_past_offers", role: this.role, round: roundNumber, offerCount: this.offerHistory.length },
              () =>
                Promise.resolve(
                  this.offerHistory.length === 0
                    ? "No offers have been made yet."
                    : this.offerHistory
                        .map(
                          (o) =>
                            `Round ${o.round}: ${o.agent} offered $${o.price.toFixed(2)}`
                        )
                        .join("\n")
                )
            );

            this.messages.push({
              role: "tool",
              tool_call_id: toolCall.id,
              content: historyStr,
            });

            // After reviewing, agent needs to act
            const reviewFollowUp = await logfire.span(
              `llm_call`,
              { model: "gpt-4o-mini", round: roundNumber, role: this.role, purpose: "act_after_offer_review" },
              () =>
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
                })
            );

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
            };
          }
        }

        return this.buildResult(roundNumber, runId, negotiation, agentAction);
      }
    );
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

    const event: NegotiationEvent = {
      timestamp: new Date().toISOString(),
      runId,
      negotiation,
      round,
      agent: this.role,
      action: action.action,
      price: action.price,
      reservationPrice: this.reservationPrice,
      marketPriceSeen: action.marketPriceSeen,
      marketPriceActual: action.marketPriceActual,
      margin,
      reasoning: action.message,
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
