-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_ModpackMod" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "modpackId" TEXT NOT NULL,
    "modrinthId" TEXT,
    "slug" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "versionId" TEXT,
    "downloadUrl" TEXT,
    CONSTRAINT "ModpackMod_modpackId_fkey" FOREIGN KEY ("modpackId") REFERENCES "Modpack" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);
INSERT INTO "new_ModpackMod" ("id", "modpackId", "modrinthId", "name", "slug", "versionId") SELECT "id", "modpackId", "modrinthId", "name", "slug", "versionId" FROM "ModpackMod";
DROP TABLE "ModpackMod";
ALTER TABLE "new_ModpackMod" RENAME TO "ModpackMod";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
