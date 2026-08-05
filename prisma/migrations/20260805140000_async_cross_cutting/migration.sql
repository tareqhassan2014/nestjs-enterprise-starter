-- CreateEnum
CREATE TYPE "OrganizationBillingMode" AS ENUM ('user', 'organization');

-- CreateEnum
CREATE TYPE "OrganizationMemberRole" AS ENUM ('owner', 'admin', 'member');

-- CreateEnum
CREATE TYPE "IdempotencyRecordStatus" AS ENUM ('processing', 'completed');

-- CreateTable
CREATE TABLE "organizations" (
    "id" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "billingMode" "OrganizationBillingMode" NOT NULL DEFAULT 'user',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organizations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "organization_members" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "OrganizationMemberRole" NOT NULL DEFAULT 'member',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "organization_members_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "organization_members_organizationId_userId_key" ON "organization_members"("organizationId", "userId");

-- CreateIndex
CREATE INDEX "organization_members_userId_idx" ON "organization_members"("userId");

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- CreditWallet: userId was the primary key. It becomes a nullable unique
-- column, `id` becomes the primary key (backfilled from the existing userId,
-- which was already unique), and `organizationId` is added as the org-owned
-- alternative. The check constraint is the actual XOR enforcement — Prisma
-- has no native way to express it, so it is raw SQL only.
-- ---------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "credit_wallets" ADD COLUMN "id" TEXT;

UPDATE "credit_wallets" SET "id" = "userId" WHERE "id" IS NULL;

ALTER TABLE "credit_wallets" ALTER COLUMN "id" SET NOT NULL;

ALTER TABLE "credit_wallets" DROP CONSTRAINT "credit_wallets_pkey";

ALTER TABLE "credit_wallets" ADD CONSTRAINT "credit_wallets_pkey" PRIMARY KEY ("id");

ALTER TABLE "credit_wallets" ALTER COLUMN "userId" DROP NOT NULL;

ALTER TABLE "credit_wallets" ADD COLUMN "organizationId" TEXT;

-- CreateIndex
CREATE UNIQUE INDEX "credit_wallets_userId_key" ON "credit_wallets"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "credit_wallets_organizationId_key" ON "credit_wallets"("organizationId");

-- AddForeignKey
ALTER TABLE "credit_wallets" ADD CONSTRAINT "credit_wallets_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CheckConstraint: exactly one of userId / organizationId is set
ALTER TABLE "credit_wallets" ADD CONSTRAINT "credit_wallets_owner_xor_check" CHECK (
    ("userId" IS NOT NULL AND "organizationId" IS NULL) OR
    ("userId" IS NULL AND "organizationId" IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- CreditLedgerEntry: same XOR ownership as CreditWallet.
-- ---------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "credit_ledger_entries" ALTER COLUMN "userId" DROP NOT NULL;

ALTER TABLE "credit_ledger_entries" ADD COLUMN "organizationId" TEXT;

-- CreateIndex
CREATE INDEX "credit_ledger_entries_organizationId_createdAt_idx" ON "credit_ledger_entries"("organizationId", "createdAt");

-- AddForeignKey
ALTER TABLE "credit_ledger_entries" ADD CONSTRAINT "credit_ledger_entries_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CheckConstraint: exactly one of userId / organizationId is set
ALTER TABLE "credit_ledger_entries" ADD CONSTRAINT "credit_ledger_entries_owner_xor_check" CHECK (
    ("userId" IS NOT NULL AND "organizationId" IS NULL) OR
    ("userId" IS NULL AND "organizationId" IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- Subscription: same XOR ownership pattern (userId already nullable-capable
-- FK; no primary-key change needed here since `id` was always the PK).
-- ---------------------------------------------------------------------------

-- AlterTable
ALTER TABLE "subscriptions" ALTER COLUMN "userId" DROP NOT NULL;

ALTER TABLE "subscriptions" ADD COLUMN "organizationId" TEXT;

-- CreateIndex
CREATE INDEX "subscriptions_organizationId_idx" ON "subscriptions"("organizationId");

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- CheckConstraint: exactly one of userId / organizationId is set
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_owner_xor_check" CHECK (
    ("userId" IS NOT NULL AND "organizationId" IS NULL) OR
    ("userId" IS NULL AND "organizationId" IS NOT NULL)
);

-- ---------------------------------------------------------------------------
-- Feature flag overrides: global (both null), per-user, or per-org. Plain
-- `@@unique` cannot express "one row per NULL group", so uniqueness within
-- each group is a set of partial indexes rather than a schema-level constraint.
-- ---------------------------------------------------------------------------

-- CreateTable
CREATE TABLE "feature_flag_overrides" (
    "id" TEXT NOT NULL,
    "flagKey" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL,
    "userId" TEXT,
    "organizationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "feature_flag_overrides_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "feature_flag_overrides_flagKey_idx" ON "feature_flag_overrides"("flagKey");

-- CreateIndex
CREATE INDEX "feature_flag_overrides_userId_idx" ON "feature_flag_overrides"("userId");

-- CreateIndex
CREATE INDEX "feature_flag_overrides_organizationId_idx" ON "feature_flag_overrides"("organizationId");

-- CreateIndex (partial unique): one global override per flag
CREATE UNIQUE INDEX "feature_flag_overrides_global_key" ON "feature_flag_overrides"("flagKey") WHERE "userId" IS NULL AND "organizationId" IS NULL;

-- CreateIndex (partial unique): one override per (flag, user)
CREATE UNIQUE INDEX "feature_flag_overrides_user_key" ON "feature_flag_overrides"("flagKey", "userId") WHERE "userId" IS NOT NULL;

-- CreateIndex (partial unique): one override per (flag, org)
CREATE UNIQUE INDEX "feature_flag_overrides_org_key" ON "feature_flag_overrides"("flagKey", "organizationId") WHERE "organizationId" IS NOT NULL;

-- AddForeignKey
ALTER TABLE "feature_flag_overrides" ADD CONSTRAINT "feature_flag_overrides_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- HTTP idempotency records. Postgres is the source of truth (not Redis), so
-- a Redis flush cannot cause a duplicate side effect on client retry.
-- ---------------------------------------------------------------------------

-- CreateTable
CREATE TABLE "idempotency_records" (
    "id" TEXT NOT NULL,
    "principalId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "status" "IdempotencyRecordStatus" NOT NULL DEFAULT 'processing',
    "statusCode" INTEGER,
    "responseBody" JSONB,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_records_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "idempotency_records_principalId_key_key" ON "idempotency_records"("principalId", "key");

-- CreateIndex
CREATE INDEX "idempotency_records_expiresAt_idx" ON "idempotency_records"("expiresAt");
