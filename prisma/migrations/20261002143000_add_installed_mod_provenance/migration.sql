-- AddColumn: where an installed mod came from.
--
-- Prisma would rebuild the whole InstalledMod table for a nullable column; a plain
-- ADD COLUMN is equivalent here (no constraint changes, no defaults) and is what gets
-- applied by hand in production, so keep the two identical. Same reasoning as
-- 20260913144054's note on `User.games`.
ALTER TABLE "InstalledMod" ADD COLUMN "source" TEXT;

-- AddColumn: the Modrinth version id the jar was downloaded from. Both writers already
-- had it in hand at the moment they created the row, and both threw it away.
ALTER TABLE "InstalledMod" ADD COLUMN "versionId" TEXT;

-- Backfill. Every row that exists before this migration was installed one mod at a time,
-- through `/api/mods/install`'s writer, before any modpack had ever been applied -- so
-- "manual" is a fact about those rows and not a default standing in for one. Rows created
-- from here on are written with their own source by whichever writer creates them.
--
-- No backfill for `versionId`: it cannot be reconstructed. A version *number* is a
-- publisher's free text and does not identify a build.
UPDATE "InstalledMod" SET "source" = 'manual' WHERE "source" IS NULL;
