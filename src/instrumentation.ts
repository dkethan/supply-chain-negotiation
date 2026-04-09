import { webcrypto } from "crypto";
if (!globalThis.crypto) {
  (globalThis as any).crypto = webcrypto;
}

import logfire from "@pydantic/logfire-node";
import { config } from "dotenv";

config({ path: ".env.local" });

logfire.configure({
  token: process.env.LOGFIRE_TOKEN,
  serviceName: "supply-chain-negotiation",
});

export { logfire };
