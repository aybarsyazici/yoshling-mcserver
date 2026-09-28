"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { SectionHeading } from "@/components/ui-bits";

export default function WhitelistPage() {
  const [users, setUsers] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  /**
   * "Loaded, and it's empty" and "never loaded" have to be separate states. While
   * they were the same one, a failed GET left `users` at `[]` and the page said
   * "No restrictions — anyone can sign in" about a list it had never seen, and a
   * Save on top of that would have made the claim true by wiping the file.
   */
  const [loadError, setLoadError] = useState<string | null>(null);
  /** Nothing saved yet — these names come from `ALLOWED_DISCORD_USERS`. */
  const [fromEnvSeed, setFromEnvSeed] = useState(false);
  const [newUser, setNewUser] = useState("");
  const [saving, setSaving] = useState(false);
  const [confirmClear, setConfirmClear] = useState(false);

  useEffect(() => {
    fetch("/api/whitelist")
      .then(async (r) => {
        const data = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(data.error || `HTTP ${r.status}`);
        if (!Array.isArray(data.users)) throw new Error("the response had no list in it");
        setUsers(data.users);
        setFromEnvSeed(data.source === "env");
      })
      .catch((e: Error) => setLoadError(e.message))
      .finally(() => setLoading(false));
  }, []);

  function addUser() {
    const username = newUser.trim().toLowerCase();
    if (!username) return;
    if (users.includes(username)) {
      toast.info("User already in whitelist");
      return;
    }
    setUsers((prev) => [...prev, username]);
    setNewUser("");
  }

  function removeUser(username: string) {
    setUsers((prev) => prev.filter((u) => u !== username));
  }

  async function save(confirmEmpty = false) {
    setSaving(true);
    try {
      const res = await fetch("/api/whitelist", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(confirmEmpty ? { users, confirmEmpty: true } : { users }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        toast.success("Whitelist saved");
        setConfirmClear(false);
        setFromEnvSeed(false);
      } else {
        // Say what the server said. A bare "Failed to save" is how the route's own
        // explanation — e.g. that it refused to clear a populated list — was lost.
        toast.error(data.error || `Couldn't save the whitelist (HTTP ${res.status})`);
      }
    } catch (e) {
      toast.error(`Couldn't save the whitelist: ${(e as Error).message}`);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6" style={{ ["--tint" as string]: "var(--primary)" }}>
      <SectionHeading
        eyebrow="Shared · Access"
        title="App whitelist"
        sub="Who can sign in at all. Granting someone a server is a separate step on the Crew page."
        tint="var(--primary)"
      />

      <Card className="bg-card/70 backdrop-blur">
        <CardHeader>
          <CardTitle>Allowed Discord users</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Only these Discord users can sign in. Use their Discord username (the @handle) or
            their display name — either works. If the list is empty, anyone with Discord can sign
            in.
          </p>
          <p className="text-sm text-muted-foreground">
            Being on this list doesn&rsquo;t give anyone a server. After they sign in once they
            appear on the{" "}
            <Link href="/users" className="text-primary hover:underline">
              Crew page
            </Link>
            , where you pick which worlds they can see.
          </p>

          {loading ? (
            <div className="h-20 bg-muted animate-pulse rounded" />
          ) : loadError ? (
            <div className="flex items-start gap-2 rounded-xl bg-destructive/10 p-3 ring-1 ring-destructive/30">
              <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-destructive" />
              <div className="space-y-1 text-sm">
                <p className="font-medium">Couldn&rsquo;t load the whitelist</p>
                <p className="text-muted-foreground">{loadError}</p>
                <p className="text-muted-foreground">
                  Editing is off until it loads — the list is still whatever it was, and saving from
                  here would replace it with an empty one. Reload the page.
                </p>
              </div>
            </div>
          ) : (
            <>
              {fromEnvSeed && (
                <p className="text-sm text-muted-foreground">
                  Nothing has been saved here yet, so these names come from{" "}
                  <code className="text-xs">ALLOWED_DISCORD_USERS</code>. Saving writes them to the
                  whitelist file, which then takes over.
                </p>
              )}

              <div className="flex flex-wrap gap-2">
                {users.map((user) => (
                  <Badge key={user} variant="secondary" className="gap-1.5 py-1.5 px-3">
                    {user}
                    <button
                      onClick={() => removeUser(user)}
                      className="text-muted-foreground hover:text-destructive ml-1"
                    >
                      x
                    </button>
                  </Badge>
                ))}
                {users.length === 0 && (
                  <p className="text-sm text-muted-foreground italic">
                    The list is empty, so anyone with a Discord account can sign in
                  </p>
                )}
              </div>

              <div className="flex gap-2">
                <Input
                  placeholder="Discord username (e.g. jamma010)"
                  value={newUser}
                  onChange={(e) => setNewUser(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addUser()}
                />
                <Button variant="outline" onClick={addUser}>
                  Add
                </Button>
              </div>

              {/* Saving an empty list switches the sign-in check off, so it asks first. */}
              <Button
                onClick={() => (users.length === 0 ? setConfirmClear(true) : save())}
                disabled={saving}
              >
                {saving ? "Saving..." : "Save Whitelist"}
              </Button>
            </>
          )}
        </CardContent>
      </Card>

      <Dialog open={confirmClear} onOpenChange={setConfirmClear}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-destructive" /> Save an empty whitelist?
            </DialogTitle>
            <DialogDescription>
              An empty list turns the sign-in check off:{" "}
              <strong>anyone with a Discord account can sign in.</strong> They arrive with no server
              access until you grant one on the Crew page, but they do get an account. If you only
              meant to remove someone, add at least one name back first.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmClear(false)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => save(true)} disabled={saving}>
              {saving ? "Saving..." : "Save empty list"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
