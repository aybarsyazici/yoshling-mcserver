-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_SevenDaysConfig" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'main',
    "serverName" TEXT NOT NULL DEFAULT 'Yoshling 7DTD',
    "password" TEXT NOT NULL DEFAULT '',
    "maxPlayers" INTEGER NOT NULL DEFAULT 8,
    "gameDifficulty" INTEGER NOT NULL DEFAULT 2,
    "dayLength" INTEGER NOT NULL DEFAULT 60,
    "version" TEXT NOT NULL DEFAULT 'stable',
    "maxMemory" TEXT NOT NULL DEFAULT '5G',
    "sandboxCode" TEXT NOT NULL DEFAULT ''
);
INSERT INTO "new_SevenDaysConfig" ("dayLength", "gameDifficulty", "id", "maxMemory", "maxPlayers", "password", "serverName", "version") SELECT "dayLength", "gameDifficulty", "id", "maxMemory", "maxPlayers", "password", "serverName", "version" FROM "SevenDaysConfig";
DROP TABLE "SevenDaysConfig";
ALTER TABLE "new_SevenDaysConfig" RENAME TO "SevenDaysConfig";
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
