-- CreateEnum
CREATE TYPE "OrderStatus" AS ENUM ('NEEDS_ATTENTION', 'COMPLETED', 'CANCELLED', 'STALE', 'DELETED');

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "shop" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "isOnline" BOOLEAN NOT NULL DEFAULT false,
    "scope" TEXT,
    "expires" TIMESTAMP(3),
    "accessToken" TEXT NOT NULL,
    "userId" BIGINT,
    "firstName" TEXT,
    "lastName" TEXT,
    "email" TEXT,
    "accountOwner" BOOLEAN NOT NULL DEFAULT false,
    "locale" TEXT,
    "collaborator" BOOLEAN DEFAULT false,
    "emailVerified" BOOLEAN DEFAULT false,
    "refreshToken" TEXT,
    "refreshTokenExpires" TIMESTAMP(3),

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Shop" (
    "shopDomain" TEXT NOT NULL,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMP(3),

    CONSTRAINT "Shop_pkey" PRIMARY KEY ("shopDomain")
);

-- CreateTable
CREATE TABLE "Order" (
    "shopDomain" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "name" TEXT,
    "financialStatus" TEXT,
    "fulfillmentStatus" TEXT,
    "isCancelled" BOOLEAN NOT NULL DEFAULT false,
    "cancelledAt" TIMESTAMP(3),
    "refundPending" BOOLEAN NOT NULL DEFAULT false,
    "shopifyClosed" BOOLEAN NOT NULL DEFAULT false,
    "shopifyClosedAt" TIMESTAMP(3),
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "totalAmount" DECIMAL(19,4),
    "totalCurrency" TEXT,
    "itemsCount" INTEGER,
    "shopifyCreatedAt" TIMESTAMP(3),
    "shopifyUpdatedAt" TIMESTAMP(3),
    "lastTriggeredAt" TIMESTAMP(3),
    "orderStatus" "OrderStatus" NOT NULL DEFAULT 'NEEDS_ATTENTION',
    "staleSince" TIMESTAMP(3),
    "firstSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "Order_pkey" PRIMARY KEY ("shopDomain","shopifyOrderId")
);

-- CreateTable
CREATE TABLE "OrderComment" (
    "id" TEXT NOT NULL,
    "shopDomain" TEXT NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "authorUserId" BIGINT,
    "authorName" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "deletedByUserId" BIGINT,

    CONSTRAINT "OrderComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProcessedDelivery" (
    "shopDomain" TEXT NOT NULL,
    "webhookId" TEXT NOT NULL,
    "processedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProcessedDelivery_pkey" PRIMARY KEY ("shopDomain","webhookId")
);

-- CreateTable
CREATE TABLE "ShopSetting" (
    "shopDomain" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ShopSetting_pkey" PRIMARY KEY ("shopDomain","key")
);

-- CreateIndex
CREATE INDEX "Session_shop_idx" ON "Session"("shop");

-- CreateIndex
CREATE INDEX "Order_shopDomain_orderStatus_shopifyCreatedAt_shopifyOrderI_idx" ON "Order"("shopDomain", "orderStatus", "shopifyCreatedAt", "shopifyOrderId");

-- CreateIndex
CREATE INDEX "Order_shopDomain_orderStatus_shopifyUpdatedAt_idx" ON "Order"("shopDomain", "orderStatus", "shopifyUpdatedAt");

-- CreateIndex
CREATE INDEX "OrderComment_shopDomain_shopifyOrderId_createdAt_idx" ON "OrderComment"("shopDomain", "shopifyOrderId", "createdAt" DESC);

-- CreateIndex
CREATE INDEX "ProcessedDelivery_processedAt_idx" ON "ProcessedDelivery"("processedAt");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_shopDomain_fkey" FOREIGN KEY ("shopDomain") REFERENCES "Shop"("shopDomain") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderComment" ADD CONSTRAINT "OrderComment_shopDomain_fkey" FOREIGN KEY ("shopDomain") REFERENCES "Shop"("shopDomain") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderComment" ADD CONSTRAINT "OrderComment_shopDomain_shopifyOrderId_fkey" FOREIGN KEY ("shopDomain", "shopifyOrderId") REFERENCES "Order"("shopDomain", "shopifyOrderId") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProcessedDelivery" ADD CONSTRAINT "ProcessedDelivery_shopDomain_fkey" FOREIGN KEY ("shopDomain") REFERENCES "Shop"("shopDomain") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ShopSetting" ADD CONSTRAINT "ShopSetting_shopDomain_fkey" FOREIGN KEY ("shopDomain") REFERENCES "Shop"("shopDomain") ON DELETE RESTRICT ON UPDATE CASCADE;
