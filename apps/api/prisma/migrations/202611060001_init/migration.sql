-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'NV',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "passwordHash" TEXT,
    "legacySalt" TEXT,
    "legacyHash" TEXT,
    "sessionVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "UserHouse" (
    "userId" TEXT NOT NULL,
    "houseCode" TEXT NOT NULL,

    CONSTRAINT "UserHouse_pkey" PRIMARY KEY ("userId","houseCode")
);

-- CreateTable
CREATE TABLE "UserAccount" (
    "userId" TEXT NOT NULL,
    "accountName" TEXT NOT NULL,

    CONSTRAINT "UserAccount_pkey" PRIMARY KEY ("userId","accountName")
);

-- CreateTable
CREATE TABLE "Session" (
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("tokenHash")
);

-- CreateTable
CREATE TABLE "House" (
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sheetFingerprint" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "House_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "BankAccount" (
    "name" TEXT NOT NULL,
    "owner" TEXT NOT NULL DEFAULT '',
    "bank" TEXT NOT NULL DEFAULT '',
    "number" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sheetFingerprint" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "BankAccount_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "Due" (
    "id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "houseCode" TEXT NOT NULL,
    "room" TEXT NOT NULL,
    "amount" BIGINT NOT NULL,
    "sheetRow" INTEGER,
    "sheetColumn" INTEGER,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Due_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Receipt" (
    "id" TEXT NOT NULL,
    "month" TEXT NOT NULL,
    "houseCode" TEXT NOT NULL,
    "room" TEXT NOT NULL,
    "collector" TEXT NOT NULL,
    "payer" TEXT NOT NULL DEFAULT '',
    "amount" BIGINT NOT NULL,
    "method" TEXT NOT NULL,
    "accountName" TEXT,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "transferAt" TIMESTAMP(3),
    "transferMemo" TEXT NOT NULL DEFAULT '',
    "note" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "syncStatus" TEXT NOT NULL DEFAULT 'PENDING',
    "source" TEXT NOT NULL DEFAULT 'APP',
    "sheetRow" INTEGER,
    "sheetFingerprint" TEXT,
    "createdById" TEXT,
    "updatedById" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Receipt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Outbox" (
    "id" TEXT NOT NULL,
    "receiptId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "operation" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "error" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogOutbox" (
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CatalogOutbox_pkey" PRIMARY KEY ("key")
);

-- CreateTable
CREATE TABLE "Conflict" (
    "id" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "localValue" JSONB,
    "sheetValue" JSONB,
    "resolved" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "Conflict_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Audit" (
    "id" TEXT NOT NULL,
    "actorId" TEXT,
    "actorLogin" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "entityId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Audit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncState" (
    "key" TEXT NOT NULL,
    "value" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SyncState_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_login_key" ON "User"("login");

-- CreateIndex
CREATE INDEX "Session_expiresAt_idx" ON "Session"("expiresAt");

-- CreateIndex
CREATE INDEX "Due_month_houseCode_idx" ON "Due"("month", "houseCode");

-- CreateIndex
CREATE UNIQUE INDEX "Due_month_houseCode_room_key" ON "Due"("month", "houseCode", "room");

-- CreateIndex
CREATE INDEX "Receipt_month_houseCode_room_status_idx" ON "Receipt"("month", "houseCode", "room", "status");

-- CreateIndex
CREATE INDEX "Receipt_method_accountName_transferAt_idx" ON "Receipt"("method", "accountName", "transferAt");

-- CreateIndex
CREATE INDEX "Receipt_syncStatus_idx" ON "Receipt"("syncStatus");

-- CreateIndex
CREATE UNIQUE INDEX "Outbox_receiptId_key" ON "Outbox"("receiptId");

-- CreateIndex
CREATE INDEX "Conflict_resolved_entityType_idx" ON "Conflict"("resolved", "entityType");

-- CreateIndex
CREATE INDEX "Audit_entityId_createdAt_idx" ON "Audit"("entityId", "createdAt");

-- AddForeignKey
ALTER TABLE "UserHouse" ADD CONSTRAINT "UserHouse_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "UserAccount" ADD CONSTRAINT "UserAccount_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Receipt" ADD CONSTRAINT "Receipt_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
