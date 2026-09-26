import { createAwsSqsProvider } from "./aws-sqs-provider";
import type { MessageHandler, QueueProvider } from "./queue-provider";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
}

/**
 * Instantiates a QueueProvider based on QUEUE_PROVIDER (docs/PLAN.md). Only "aws" is implemented
 * today; adding a second provider means adding another case here, not touching the handler or
 * any business logic — everything downstream is written against QueueProvider/MessageHandler.
 */
export function createQueueProvider(handler: MessageHandler): QueueProvider {
  const provider = process.env.QUEUE_PROVIDER;
  switch (provider) {
    case "aws":
      return createAwsSqsProvider({
        queueUrl: requireEnv("SQS_QUEUE_URL"),
        region: requireEnv("AWS_REGION"),
        handler,
      });
    default:
      throw new Error(
        `Unsupported QUEUE_PROVIDER: ${JSON.stringify(provider)}. Only "aws" is implemented.`,
      );
  }
}
