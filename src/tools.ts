import type { ChatCompletionTool } from "openai/resources/chat/completions";

export const NEGOTIATION_TOOLS: ChatCompletionTool[] = [
  {
    type: "function",
    function: {
      name: "check_market_price",
      description:
        "Check the current market reference price for the product being negotiated. Returns a price estimate (may vary slightly due to market conditions). Use this to inform your pricing strategy.",
      parameters: {
        type: "object",
        properties: {
          product: {
            type: "string",
            description: "The product to check the price for",
          },
        },
        required: ["product"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "make_offer",
      description:
        "Make a price offer to the other party. This is your proposed price for the deal.",
      parameters: {
        type: "object",
        properties: {
          price: {
            type: "number",
            description: "The price you are offering",
          },
          message: {
            type: "string",
            description: "A short message to accompany your offer explaining your reasoning",
          },
        },
        required: ["price", "message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "accept_offer",
      description:
        "Accept the current offer on the table. This closes the deal at the last offered price.",
      parameters: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "A short message explaining why you accept",
          },
        },
        required: ["message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "reject_offer",
      description:
        "Reject the current offer. The negotiation continues and the other party gets a chance to respond.",
      parameters: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "A short message explaining why you reject",
          },
        },
        required: ["message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "walk_away",
      description:
        "Walk away from the negotiation entirely. The deal fails. Use this only if you believe no acceptable deal is possible.",
      parameters: {
        type: "object",
        properties: {
          message: {
            type: "string",
            description: "A short message explaining why you are walking away",
          },
        },
        required: ["message"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "review_past_offers",
      description:
        "Review all offers made so far in this negotiation. Useful for identifying patterns and deciding your next move.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
];
