/**
 * Non-destructive peek at one message on the configured SQS queue, for confirming the real
 * EventBridge envelope shape against worker/eventbridge-envelope.ts's assumptions (see its
 * top-of-file comment and docs/PLAN.md, milestone 2).
 *
 * Receives with a short visibility timeout and does NOT delete the message — it reappears on
 * the queue shortly after this script exits, so it's safe to run against a live queue.
 *
 * Usage (from repo root, with AWS_REGION/SQS_QUEUE_URL set — e.g. via `.env`):
 *   bun run worker/scripts/peek-queue.ts
 */
import { ReceiveMessageCommand, SQSClient } from "@aws-sdk/client-sqs";

async function main() {
  const region = process.env.AWS_REGION;
  const queueUrl = process.env.SQS_QUEUE_URL;
  if (!region || !queueUrl) {
    console.error("Set AWS_REGION and SQS_QUEUE_URL first (see .env.example).");
    process.exit(1);
  }

  const sqs = new SQSClient({ region });
  console.log(`Polling ${queueUrl} for up to 10s...`);

  const result = await sqs.send(
    new ReceiveMessageCommand({
      QueueUrl: queueUrl,
      MaxNumberOfMessages: 1,
      WaitTimeSeconds: 10,
      VisibilityTimeout: 5, // short — this is a peek, not a claim
      MessageAttributeNames: ["All"],
      AttributeNames: ["All"],
    }),
  );

  if (!result.Messages || result.Messages.length === 0) {
    console.log(
      "No messages received. Trigger an order status change in your dev store (e.g. mark an " +
        "order as fulfilled) and try again — Events deliveries can take a few seconds to arrive.",
    );
    return;
  }

  for (const message of result.Messages) {
    console.log("\n=== SQS message ===");
    console.log("MessageId:", message.MessageId);
    console.log("Attributes:", JSON.stringify(message.Attributes, null, 2));
    console.log("MessageAttributes:", JSON.stringify(message.MessageAttributes, null, 2));
    console.log("Body (raw):", message.Body);
    try {
      console.log("Body (parsed):", JSON.stringify(JSON.parse(message.Body ?? ""), null, 2));
    } catch {
      console.log("Body is not valid JSON.");
    }
  }
  console.log(
    "\nNot deleted — it will reappear on the queue in ~5s. Compare this against " +
      "worker/eventbridge-envelope.ts's assumptions and adjust if needed.",
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
