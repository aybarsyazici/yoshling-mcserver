-- CreateTable
CREATE TABLE "GameState" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'main',
    "activeGame" TEXT,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "SevenDaysConfig" (
    "id" TEXT NOT NULL PRIMARY KEY DEFAULT 'main',
    "serverName" TEXT NOT NULL DEFAULT 'Yoshling 7DTD',
    "password" TEXT NOT NULL DEFAULT '',
    "maxPlayers" INTEGER NOT NULL DEFAULT 8,
    "gameDifficulty" INTEGER NOT NULL DEFAULT 2,
    "dayLength" INTEGER NOT NULL DEFAULT 60,
    "version" TEXT NOT NULL DEFAULT 'stable',
    "maxMemory" TEXT NOT NULL DEFAULT '5G'
);
