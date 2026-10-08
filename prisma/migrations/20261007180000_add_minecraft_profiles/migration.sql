-- Production application is manual, after a verified SQLite backup.
-- This migration does not adopt files, select a profile, or change existing inventory.
CREATE TABLE "MinecraftProfile" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "name" TEXT NOT NULL,
  "description" TEXT NOT NULL DEFAULT '',
  "status" TEXT NOT NULL DEFAULT 'preparing',
  "mcVersion" TEXT NOT NULL,
  "loader" TEXT NOT NULL,
  "loaderVersion" TEXT,
  "javaVariant" TEXT NOT NULL,
  "sourceKind" TEXT NOT NULL,
  "sourceRef" TEXT,
  "sourceVersionId" TEXT,
  "sourceTitle" TEXT,
  "preparationError" TEXT,
  "coverKey" TEXT,
  "coverMime" TEXT,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "createdBy" TEXT NOT NULL,
  "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" DATETIME NOT NULL,
  "lastPlayedAt" DATETIME
);

CREATE TABLE "MinecraftRuntime" (
  "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'main' CHECK ("id" = 'main'),
  "selectedProfileId" TEXT,
  "revision" TEXT NOT NULL DEFAULT '0',
  "updatedAt" DATETIME NOT NULL,
  CONSTRAINT "MinecraftRuntime_selectedProfileId_fkey" FOREIGN KEY ("selectedProfileId") REFERENCES "MinecraftProfile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE
);

ALTER TABLE "InstalledMod" ADD COLUMN "profileId" TEXT REFERENCES "MinecraftProfile" ("id") ON DELETE RESTRICT ON UPDATE CASCADE;
CREATE INDEX "InstalledMod_profileId_idx" ON "InstalledMod"("profileId");
