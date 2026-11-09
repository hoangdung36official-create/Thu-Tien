-- CreateTable
CREATE TABLE "AssetSequence" (
    "prefix" TEXT NOT NULL,
    "nextNo" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "AssetSequence_pkey" PRIMARY KEY ("prefix")
);

-- CreateTable
CREATE TABLE "Asset" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "brand" TEXT NOT NULL DEFAULT '',
    "model" TEXT NOT NULL DEFAULT '',
    "purchaseDate" TIMESTAMP(3),
    "purchaseCost" BIGINT,
    "warrantyUntil" TIMESTAMP(3),
    "conditionPct" INTEGER NOT NULL DEFAULT 100,
    "status" TEXT NOT NULL DEFAULT 'AVAILABLE',
    "locationType" TEXT NOT NULL DEFAULT 'CENTRAL',
    "houseCode" TEXT,
    "room" TEXT,
    "note" TEXT NOT NULL DEFAULT '',
    "imageUrl" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetMovement" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "fromType" TEXT NOT NULL,
    "fromHouse" TEXT,
    "fromRoom" TEXT,
    "toType" TEXT NOT NULL,
    "toHouse" TEXT,
    "toRoom" TEXT,
    "reason" TEXT NOT NULL,
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "requestKey" TEXT NOT NULL,

    CONSTRAINT "AssetMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EquipmentRental" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "houseCode" TEXT NOT NULL,
    "room" TEXT NOT NULL,
    "startAt" TIMESTAMP(3) NOT NULL,
    "expectedEndAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),
    "monthlyFee" BIGINT NOT NULL DEFAULT 0,
    "included" BOOLEAN NOT NULL DEFAULT false,
    "handoverNote" TEXT NOT NULL DEFAULT '',
    "handoverDoc" TEXT,
    "returnNote" TEXT NOT NULL DEFAULT '',
    "actorId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EquipmentRental_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Supply" (
    "id" TEXT NOT NULL,
    "sku" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "unit" TEXT NOT NULL,
    "referencePrice" BIGINT NOT NULL DEFAULT 0,
    "minimumQty" INTEGER NOT NULL DEFAULT 0,
    "note" TEXT NOT NULL DEFAULT '',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Supply_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockBalance" (
    "id" TEXT NOT NULL,
    "supplyId" TEXT NOT NULL,
    "locationKey" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "StockBalance_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockMovement" (
    "id" TEXT NOT NULL,
    "supplyId" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "quantity" INTEGER NOT NULL,
    "fromKey" TEXT,
    "toKey" TEXT,
    "reason" TEXT NOT NULL,
    "workRef" TEXT,
    "actorId" TEXT NOT NULL,
    "approverId" TEXT,
    "requestKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StockMovement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockCount" (
    "id" TEXT NOT NULL,
    "locationKey" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "note" TEXT NOT NULL DEFAULT '',
    "actorId" TEXT NOT NULL,
    "approverId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "approvedAt" TIMESTAMP(3),

    CONSTRAINT "StockCount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "StockCountLine" (
    "id" TEXT NOT NULL,
    "countId" TEXT NOT NULL,
    "supplyId" TEXT NOT NULL,
    "expectedQty" INTEGER NOT NULL,
    "actualQty" INTEGER NOT NULL,

    CONSTRAINT "StockCountLine_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssetMaintenance" (
    "id" TEXT NOT NULL,
    "assetId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "description" TEXT NOT NULL,
    "cost" BIGINT NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "actorId" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT '',

    CONSTRAINT "AssetMaintenance_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Asset_code_key" ON "Asset"("code");

-- CreateIndex
CREATE INDEX "Asset_houseCode_room_idx" ON "Asset"("houseCode", "room");

-- CreateIndex
CREATE INDEX "Asset_category_status_idx" ON "Asset"("category", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AssetMovement_requestKey_key" ON "AssetMovement"("requestKey");

-- CreateIndex
CREATE INDEX "AssetMovement_assetId_createdAt_idx" ON "AssetMovement"("assetId", "createdAt");

-- CreateIndex
CREATE INDEX "EquipmentRental_houseCode_room_endedAt_idx" ON "EquipmentRental"("houseCode", "room", "endedAt");

-- CreateIndex
CREATE INDEX "EquipmentRental_assetId_endedAt_idx" ON "EquipmentRental"("assetId", "endedAt");

-- CreateIndex
CREATE UNIQUE INDEX "Supply_sku_key" ON "Supply"("sku");

-- CreateIndex
CREATE INDEX "StockBalance_locationKey_idx" ON "StockBalance"("locationKey");

-- CreateIndex
CREATE UNIQUE INDEX "StockBalance_supplyId_locationKey_key" ON "StockBalance"("supplyId", "locationKey");

-- CreateIndex
CREATE UNIQUE INDEX "StockMovement_requestKey_key" ON "StockMovement"("requestKey");

-- CreateIndex
CREATE INDEX "StockMovement_supplyId_createdAt_idx" ON "StockMovement"("supplyId", "createdAt");

-- CreateIndex
CREATE INDEX "StockCount_status_locationKey_idx" ON "StockCount"("status", "locationKey");

-- CreateIndex
CREATE UNIQUE INDEX "StockCountLine_countId_supplyId_key" ON "StockCountLine"("countId", "supplyId");

-- CreateIndex
CREATE INDEX "AssetMaintenance_assetId_status_idx" ON "AssetMaintenance"("assetId", "status");

-- AddForeignKey
ALTER TABLE "AssetMovement" ADD CONSTRAINT "AssetMovement_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EquipmentRental" ADD CONSTRAINT "EquipmentRental_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockBalance" ADD CONSTRAINT "StockBalance_supplyId_fkey" FOREIGN KEY ("supplyId") REFERENCES "Supply"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockMovement" ADD CONSTRAINT "StockMovement_supplyId_fkey" FOREIGN KEY ("supplyId") REFERENCES "Supply"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_countId_fkey" FOREIGN KEY ("countId") REFERENCES "StockCount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StockCountLine" ADD CONSTRAINT "StockCountLine_supplyId_fkey" FOREIGN KEY ("supplyId") REFERENCES "Supply"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssetMaintenance" ADD CONSTRAINT "AssetMaintenance_assetId_fkey" FOREIGN KEY ("assetId") REFERENCES "Asset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
