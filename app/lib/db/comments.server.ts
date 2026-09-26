import { COMMENT_EDITING_ENABLED } from "../../config/features.server";
import { withShop } from "./shop-scope.server";

export interface AddCommentInput {
  shopDomain: string;
  shopifyOrderId: string;
  body: string;
  authorUserId?: bigint;
  authorName?: string;
}

const MAX_COMMENT_LENGTH = 5000;

function assertValidBody(body: string): void {
  const trimmed = body.trim();
  if (trimmed.length === 0) {
    throw new Error("Comment body cannot be empty.");
  }
  if (trimmed.length > MAX_COMMENT_LENGTH) {
    throw new Error(`Comment body exceeds ${MAX_COMMENT_LENGTH} characters.`);
  }
}

export async function addComment(input: AddCommentInput) {
  assertValidBody(input.body);
  return withShop(input.shopDomain, (tx) =>
    tx.orderComment.create({
      data: {
        shopDomain: input.shopDomain,
        shopifyOrderId: input.shopifyOrderId,
        body: input.body.trim(),
        authorUserId: input.authorUserId,
        authorName: input.authorName,
      },
    }),
  );
}

export interface ListCommentsOptions {
  cursor?: string;
  take?: number;
}

export async function listComments(
  shopDomain: string,
  shopifyOrderId: string,
  { cursor, take = 25 }: ListCommentsOptions = {},
) {
  return withShop(shopDomain, (tx) =>
    tx.orderComment.findMany({
      where: { shopDomain, shopifyOrderId, deletedAt: null },
      orderBy: { createdAt: "desc" },
      take: take + 1, // +1 so the caller can tell whether there's another page
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    }),
  );
}

export async function countComments(shopDomain: string, shopifyOrderId: string) {
  return withShop(shopDomain, (tx) =>
    tx.orderComment.count({ where: { shopDomain, shopifyOrderId, deletedAt: null } }),
  );
}

/**
 * Implemented ahead of the UI per docs/PLAN.md — comments are permanent for v1. Both functions
 * refuse to run while COMMENT_EDITING_ENABLED is false, so turning the feature on later is just
 * flipping that flag and adding the buttons, not writing this logic under time pressure.
 */
export async function editComment(
  shopDomain: string,
  commentId: string,
  authorUserId: bigint,
  body: string,
) {
  if (!COMMENT_EDITING_ENABLED) {
    throw new Error("Comment editing is not enabled.");
  }
  assertValidBody(body);
  return withShop(shopDomain, async (tx) => {
    const existing = await tx.orderComment.findFirst({
      where: { shopDomain, id: commentId, deletedAt: null },
    });
    if (!existing) throw new Error("Comment not found.");
    if (existing.authorUserId !== authorUserId) {
      throw new Error("Only the original author can edit this comment.");
    }
    return tx.orderComment.update({
      where: { id: commentId },
      data: { body: body.trim(), editedAt: new Date() },
    });
  });
}

export async function deleteComment(shopDomain: string, commentId: string, authorUserId: bigint) {
  if (!COMMENT_EDITING_ENABLED) {
    throw new Error("Comment deletion is not enabled.");
  }
  return withShop(shopDomain, async (tx) => {
    const existing = await tx.orderComment.findFirst({
      where: { shopDomain, id: commentId, deletedAt: null },
    });
    if (!existing) throw new Error("Comment not found.");
    if (existing.authorUserId !== authorUserId) {
      throw new Error("Only the original author can delete this comment.");
    }
    return tx.orderComment.update({
      where: { id: commentId },
      data: { deletedAt: new Date(), deletedByUserId: authorUserId },
    });
  });
}
