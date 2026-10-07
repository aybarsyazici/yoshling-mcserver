"use client";

import { useCallback, useEffect, useState } from "react";
import { signOut } from "next-auth/react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { discordIdList, discordUserId } from "@/lib/discord-identity";
import { fileRevision, revisionHeaders } from "@/lib/file-revision-client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { SectionHeading } from "@/components/ui-bits";

interface WhitelistSnapshot {
  users: string[];
  source: "file" | "env";
  labels: Record<string, string>;
  selfId: string;
  revision: string;
}
interface SaveIntent { users: string[]; revision: string }
interface Confirmation { kind: "empty" | "self"; intent: SaveIntent }

function strongRevision(response: Response): string | null {
  const revision = fileRevision(response);
  return revision && /^"[^"\r\n]+"$/.test(revision) ? revision : null;
}
function sameUsers(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}
function readSnapshot(data: unknown, revision: string | null): WhitelistSnapshot {
  if (!data || typeof data !== "object") throw new Error("The sign-in list response is incomplete.");
  const row = data as Record<string, unknown>;
  const users = discordIdList(row.users);
  const selfId = discordUserId(row.selfId);
  if (!users || (row.source !== "file" && row.source !== "env") || !selfId ||
      !row.labels || typeof row.labels !== "object" || Array.isArray(row.labels) ||
      !Object.entries(row.labels).every(([id, label]) => users.includes(id) && typeof label === "string")) {
    throw new Error("The sign-in list response is incomplete. Discord IDs and your own identity must be verified before editing.");
  }
  if (!revision) throw new Error("The sign-in list revision could not be verified. Retry before editing.");
  return { users, selfId, source: row.source as "file" | "env", labels: row.labels as Record<string, string>, revision };
}

export default function WhitelistPage() {
  const [snapshot, setSnapshot] = useState<WhitelistSnapshot | null>(null);
  const [users, setUsers] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [newUser, setNewUser] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmation, setConfirmation] = useState<Confirmation | null>(null);
  const [selfRemoved, setSelfRemoved] = useState(false);

  const load = useCallback(async () => {
    try {
      const response = await fetch("/api/whitelist", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(typeof data?.error === "string" ? data.error : `Couldn't read the sign-in list (HTTP ${response.status}).`);
      const loaded = readSnapshot(data, strongRevision(response));
      setSnapshot(loaded); setUsers(loaded.users); setLoadError(null); setConfirmation(null); setSelfRemoved(false);
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : "Couldn't read the sign-in list.");
    } finally { setLoading(false); }
  }, []);
  useEffect(() => {
    // State updates in load follow the awaited read.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const ready = snapshot !== null && !loading && !loadError && !saving && !selfRemoved;
  const editable = ready && confirmation === null;
  function addUser() {
    if (!editable) return;
    const id = discordUserId(newUser);
    if (!id) { toast.error("Enter the exact decimal Discord user ID. Usernames and display names cannot identify an invited account."); return; }
    if (users.includes(id)) { toast.info("That Discord ID is already allowed."); return; }
    setUsers((previous) => [...previous, id]); setNewUser("");
  }
  function removeUser(id: string) {
    if (editable) setUsers((previous) => previous.filter((user) => user !== id));
  }
  function requestSave() {
    if (!editable || !snapshot) return;
    const intent = { users: [...users], revision: snapshot.revision };
    if (users.length === 0) setConfirmation({ kind: "empty", intent });
    else if (!users.includes(snapshot.selfId)) setConfirmation({ kind: "self", intent });
    else void save(intent);
  }

  async function save(intent: SaveIntent, confirmed?: "empty" | "self") {
    if (!ready || !snapshot || intent.revision !== snapshot.revision) return;
    setSaving(true);
    try {
      const response = await fetch("/api/whitelist", {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...revisionHeaders(intent.revision) },
        body: JSON.stringify({ users: intent.users,
          ...(confirmed === "empty" ? { confirmEmpty: true } : {}),
          ...(confirmed === "self" ? { confirmSelfRemoval: true } : {}),
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        if (response.status >= 500) throw new Error("The save result could not be confirmed.");
        if (response.status === 409 && data?.code === "confirm_empty") setConfirmation({ kind: "empty", intent });
        else if (response.status === 409 && data?.code === "confirm_self_removal") setConfirmation({ kind: "self", intent });
        else {
          const message = typeof data?.error === "string" ? data.error : `Couldn't save the sign-in list (HTTP ${response.status}).`;
          if (data?.stale || response.status === 401 || response.status === 403) { setLoadError(message); setConfirmation(null); }
          toast.error(message);
        }
        return;
      }
      const savedUsers = discordIdList(data?.users);
      const revision = strongRevision(response);
      if (data?.success !== true || !savedUsers || !sameUsers(savedUsers, intent.users) || !revision) {
        throw new Error("The saved sign-in list could not be verified.");
      }
      const removingSelf = savedUsers.length > 0 && !savedUsers.includes(snapshot.selfId);
      if (removingSelf && confirmed !== "self") throw new Error("Your removal was not confirmed before the save.");
      setSnapshot({ ...snapshot, users: savedUsers, source: "file", revision }); setUsers(savedUsers); setConfirmation(null);
      toast.success("Sign-in list saved and verified.");
      if (removingSelf) {
        setSelfRemoved(true);
        try { await signOut({ callbackUrl: "/login" }); }
        catch { setLoadError("Your Discord ID was removed from the saved list. The sign-out request was not confirmed; reload to finish signing out."); }
      }
    } catch {
      setLoadError("The save result is unconfirmed. Reload the sign-in list before retrying."); setConfirmation(null);
      toast.info("The sign-in list save result is unconfirmed. Reload it before retrying.");
    } finally { setSaving(false); }
  }

  return (
    <div className="space-y-6" style={{ ["--tint" as string]: "var(--primary)" }}>
      <SectionHeading eyebrow="Shared · Access" title="App whitelist"
        sub="Who can sign in at all. Granting someone a server is a separate step on the Crew page." tint="var(--primary)" />
      <Card className="bg-card/70 backdrop-blur">
        <CardHeader><CardTitle>Allowed Discord IDs</CardTitle></CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">Use the exact decimal Discord user ID. Names below are display labels only; usernames and display names cannot grant sign-in access.</p>
          <p className="text-sm text-muted-foreground">An empty list lets anyone with a Discord account sign in. Being allowed here gives no server access; grant worlds on the <Link href="/users" className="text-primary hover:underline">Crew page</Link>.</p>
          {loading ? <div aria-label="Loading sign-in list" className="h-20 animate-pulse rounded bg-muted" /> : loadError ? (
            <div role="alert" className="space-y-2 rounded-xl bg-destructive/10 p-3 ring-1 ring-destructive/30">
              <p className="flex items-center gap-2 font-medium"><AlertTriangle className="h-4 w-4" />Editing is unavailable</p>
              <p>{loadError}</p>
              <Button variant="outline" disabled={saving || selfRemoved} onClick={() => { setLoading(true); void load(); }}>Retry sign-in list</Button>
            </div>
          ) : snapshot && (
            <>
              {snapshot.source === "env" && <p className="text-sm text-muted-foreground">These IDs come from the deployment sign-in seed. Saving makes this list the active policy.</p>}
              <div className="flex flex-wrap gap-2">
                {users.map((id) => <Badge key={id} variant="secondary" className="gap-1.5 px-3 py-1.5">
                  <span className="font-mono">{id}</span>{snapshot.labels[id] && <span>· {snapshot.labels[id]}</span>}
                  {id === snapshot.selfId && <span>(you)</span>}
                  <button type="button" aria-label={`Remove Discord ID ${id}`} disabled={!editable} onClick={() => removeUser(id)} className="ml-1 text-muted-foreground hover:text-destructive">×</button>
                </Badge>)}
                {users.length === 0 && <p className="text-sm italic text-muted-foreground">The draft is empty. Saving it allows anyone with a Discord account to sign in.</p>}
              </div>
              <div className="flex gap-2">
                <Input aria-label="Discord user ID" placeholder="Discord user ID (exact digits)" inputMode="numeric" type="text" value={newUser} disabled={!editable}
                  onChange={(event) => setNewUser(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); addUser(); } }} />
                <Button variant="outline" onClick={addUser} disabled={!editable || !newUser.trim()}>Add ID</Button>
              </div>
              <Button onClick={requestSave} disabled={!editable}>{saving ? "Saving…" : "Save Whitelist"}</Button>
              {selfRemoved && <p role="status">Your ID was removed from the saved list. Signing out…</p>}
            </>
          )}
        </CardContent>
      </Card>
      <Dialog open={confirmation !== null} onOpenChange={(open) => { if (!open && !saving) setConfirmation(null); }}>
        <DialogContent showCloseButton={!saving}>
          <DialogHeader>
            <DialogTitle>{confirmation?.kind === "empty" ? "Allow anyone to sign in?" : "Remove your own Discord ID?"}</DialogTitle>
            <DialogDescription>{confirmation?.kind === "empty"
              ? "Saving an empty list opens sign-in to anyone with Discord. New accounts still need world grants from an admin. Add at least one Discord ID if you want to keep sign-in restricted."
              : "This saves the list without your Discord ID and then signs you out. Confirm that another allowed admin can manage access before continuing."}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" disabled={saving} onClick={() => setConfirmation(null)}>Cancel</Button>
            <Button variant="destructive" disabled={!ready} onClick={() => confirmation && void save(confirmation.intent, confirmation.kind)}>
              {saving ? "Saving…" : confirmation?.kind === "empty" ? "Save empty list" : "Save and sign out"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
