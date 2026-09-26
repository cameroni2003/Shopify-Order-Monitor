import type { NormalizedEvent } from "../../shared/shopify-delivery";

/**
 * Provider-agnostic interface (docs/PLAN.md, "Queue provider"). Business logic (the message
 * handler) is written against MessageHandler/NormalizedEvent only — never against a raw SQS/etc.
 * message — so a second provider later is a new file implementing this interface, not a rewrite.
 */
export type MessageHandler = (event: NormalizedEvent) => Promise<void>;

export interface QueueProvider {
  start(): Promise<void>;
  stop(): Promise<void>;
}
