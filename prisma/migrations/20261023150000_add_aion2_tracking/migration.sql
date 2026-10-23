-- Additive only. Apply manually after a database backup; never run on application boot.
CREATE TABLE "Aion2Character" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "region" TEXT NOT NULL,
    "serverId" INTEGER NOT NULL,
    "characterId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "serverName" TEXT NOT NULL,
    "tracking" BOOLEAN NOT NULL DEFAULT true,
    "odyleEnergy" INTEGER,
    "resourcesUpdatedAt" DATETIME,
    "lastAttemptAt" DATETIME,
    "lastSuccessAt" DATETIME,
    "nextRefreshAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastError" TEXT,
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "leaseToken" TEXT,
    "leaseUntil" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "Aion2Character_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Aion2Character_ownerId_region_serverId_characterId_key" ON "Aion2Character"("ownerId", "region", "serverId", "characterId");
CREATE INDEX "Aion2Character_tracking_nextRefreshAt_idx" ON "Aion2Character"("tracking", "nextRefreshAt");
CREATE TABLE "Aion2Snapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "characterId" TEXT NOT NULL,
    "observedAt" DATETIME NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "payloadJson" TEXT NOT NULL,
    "combatPower" INTEGER,
    "gearScore" INTEGER,
    CONSTRAINT "Aion2Snapshot_characterId_fkey" FOREIGN KEY ("characterId") REFERENCES "Aion2Character" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE INDEX "Aion2Snapshot_characterId_observedAt_idx" ON "Aion2Snapshot"("characterId", "observedAt");
CREATE TABLE "Aion2ChecklistCompletion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "ownerId" TEXT NOT NULL,
    "scopeKey" TEXT NOT NULL,
    "activityId" TEXT NOT NULL,
    "periodKey" TEXT NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 1,
    "completedAt" DATETIME,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Aion2ChecklistCompletion_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
CREATE UNIQUE INDEX "Aion2ChecklistCompletion_ownerId_scopeKey_activityId_periodKey_key" ON "Aion2ChecklistCompletion"("ownerId", "scopeKey", "activityId", "periodKey");
CREATE INDEX "Aion2ChecklistCompletion_ownerId_scopeKey_idx" ON "Aion2ChecklistCompletion"("ownerId", "scopeKey");
