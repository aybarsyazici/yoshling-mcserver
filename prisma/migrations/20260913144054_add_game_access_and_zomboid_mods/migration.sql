-- CreateTable
CREATE TABLE "ZomboidMod" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "title" TEXT NOT NULL DEFAULT '',
    "modIds" TEXT NOT NULL DEFAULT '',
    "previewUrl" TEXT,
    "addedBy" TEXT NOT NULL DEFAULT '',
    "addedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- AddColumn: per-world access, as a CSV of game ids.
-- Prisma would rebuild the whole User table for this; a plain ADD COLUMN is
-- equivalent here (no constraint changes) and is what gets applied by hand in
-- production, so keep the two identical.
ALTER TABLE "User" ADD COLUMN "games" TEXT NOT NULL DEFAULT '';

-- Everyone who already had an account could see every world, so keep it that
-- way. Only accounts created from now on start with nothing.
UPDATE "User" SET "games" = 'minecraft,7dtd,zomboid';
