-- Apply manually after a consistent verified SQLite backup, before deploying the new client.
-- Existing clients remain compatible; new clients select this column on User reads.
ALTER TABLE "User" ADD COLUMN "minecraftTourDone" BOOLEAN NOT NULL DEFAULT false;
