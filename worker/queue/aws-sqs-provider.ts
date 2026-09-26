import { SQSClient, type Message } from "@aws-sdk/client-sqs";
import { Consumer } from "sqs-consumer";
import { normalizeShopifyDelivery } from "../../shared/shopify-delivery";
import { extractShopifyDelivery } from "../eventbridge-envelope";
import type { MessageHandler, QueueProvider } from "./queue-provider";

export interface AwsSqsProviderOptions {
  queueUrl: string;
  region: string;
  handler: MessageHandler;
}

function extractMessageAttributeHeaders(message: Message): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, attr] of Object.entries(message.MessageAttributes ?? {})) {
    if (attr.StringValue) out[key.toLowerCase().replace(/^x-/, "")] = attr.StringValue;
  }
  return out;
}

/**
 * AWS SQS implementation of QueueProvider, using sqs-consumer + @aws-sdk/client-sqs (per
 * docs/PLAN.md). Instantiated via createQueueProvider() based on QUEUE_PROVIDER — nothing else
 * in the app should import sqs-consumer or @aws-sdk/client-sqs directly.
 */
export function createAwsSqsProvider(options: AwsSqsProviderOptions): QueueProvider {
  const sqs = new SQSClient({ region: options.region });

  const consumer = Consumer.create({
    queueUrl: options.queueUrl,
    sqs,
    messageAttributeNames: ["All"],
    handleMessage: async (message: Message) => {
      if (!message.Body) {
        throw new Error(`SQS message ${message.MessageId ?? "(no id)"} has no body`);
      }

      const { headers: envelopeHeaders, body } = extractShopifyDelivery(message.Body);
      // Envelope headers take priority; message-attribute headers fill any gaps (only relevant
      // if the EventBridge rule's input transformer maps headers onto attributes instead of/as
      // well as into the body — see worker/eventbridge-envelope.ts).
      const headers = { ...extractMessageAttributeHeaders(message), ...envelopeHeaders };

      const event = await normalizeShopifyDelivery(body, headers);
      await options.handler(event);

      // sqs-consumer (v15+) deletes a message only when handleMessage *returns* it. Throwing
      // above (from any step — envelope extraction, normalization, or the handler) leaves the
      // message on the queue for retry, and eventually routes it to the DLQ via the queue's
      // redrive policy, per docs/PLAN.md — no silent drops.
      return message;
    },
  });

  consumer.on("error", (err) => {
    console.error("[worker:sqs] consumer error:", err);
  });
  consumer.on("processing_error", (err) => {
    console.error("[worker:sqs] processing error (message left on queue for retry):", err);
  });
  consumer.on("timeout_error", (err) => {
    console.error("[worker:sqs] handler timed out:", err);
  });

  return {
    async start() {
      consumer.start();
    },
    async stop() {
      consumer.stop();
    },
  };
}
