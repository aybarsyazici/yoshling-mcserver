-- CreateTable
CREATE TABLE "Modpack" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "createdBy" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "ModpackMod" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "modpackId" TEXT NOT NULL,
    "modrinthId" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "versionId" TEXT,
    CONSTRAINT "ModpackMod_modpackId_fkey" FOREIGN KEY ("modpackId") REFERENCES "Modpack" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
