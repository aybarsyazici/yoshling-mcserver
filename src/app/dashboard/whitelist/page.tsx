"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

export default function WhitelistPage() {
  const [users, setUsers] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [newUser, setNewUser] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/whitelist")
      .then((r) => r.json())
      .then((data) => {
        if (data.users) setUsers(data.users);
      })
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

  async function save() {
    setSaving(true);
    try {
      const res = await fetch("/api/whitelist", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ users }),
      });
      if (res.ok) {
        toast.success("Whitelist saved");
      } else {
        toast.error("Failed to save");
      }
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-bold tracking-tight">Whitelist</h2>
        <p className="text-muted-foreground mt-1">
          Control which Discord users can access the app
        </p>
      </div>

      <Card className="border-border/50 shadow-sm">
        <CardHeader>
          <CardTitle>Allowed Discord Users</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted-foreground">
            Only these Discord usernames can sign in. If the list is empty, anyone can sign in.
          </p>

          {loading ? (
            <div className="h-20 bg-muted animate-pulse rounded" />
          ) : (
            <>
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
                    No restrictions — anyone can sign in
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

              <Button onClick={save} disabled={saving}>
                {saving ? "Saving..." : "Save Whitelist"}
              </Button>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
