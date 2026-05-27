"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";

interface Backup {
  name: string;
  size: number;
  createdAt: string;
}

export function ServerBackups() {
  const [backups, setBackups] = useState<Backup[]>([]);
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [restoring, setRestoring] = useState<string | null>(null);

  async function fetchBackups() {
    try {
      const res = await fetch("/api/server/backups");
      const data = await res.json();
      if (Array.isArray(data)) setBackups(data);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    fetchBackups();
  }, []);

  async function handleCreate() {
    setCreating(true);
    try {
      const res = await fetch("/api/server/backups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "create" }),
      });
      const data = await res.json();
      if (res.ok && data.backup) {
        setBackups((prev) => [data.backup, ...prev]);
        toast.success("Backup created successfully");
      } else {
        toast.error(data.error || "Backup failed");
      }
    } finally {
      setCreating(false);
    }
  }

  async function handleRestore(backupName: string) {
    if (!confirm(`Restore "${backupName}"? This will replace the current world. The server should be stopped first.`)) return;

    setRestoring(backupName);
    try {
      const res = await fetch("/api/server/backups", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "restore", backupName }),
      });
      if (res.ok) {
        toast.success("World restored. Start the server to play.");
      } else {
        const data = await res.json();
        toast.error(data.error || "Restore failed");
      }
    } finally {
      setRestoring(null);
    }
  }

  async function handleDelete(backupName: string) {
    if (!confirm(`Delete backup "${backupName}"? This cannot be undone.`)) return;

    const res = await fetch("/api/server/backups", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "delete", backupName }),
    });
    if (res.ok) {
      setBackups((prev) => prev.filter((b) => b.name !== backupName));
      toast.success("Backup deleted");
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <p className="text-sm text-muted-foreground">
          Create backups of your world before making changes
        </p>
        <Button onClick={handleCreate} disabled={creating}>
          {creating ? "Creating..." : "Create Backup"}
        </Button>
      </div>

      <div className="rounded-lg border border-chart-5/30 bg-chart-5/5 p-3">
        <p className="text-xs text-muted-foreground">
          Backups save the entire <code className="bg-muted px-1 py-0.5 rounded">world/</code> folder.
          Stop the server before restoring to avoid corruption.
        </p>
      </div>

      {loading ? (
        <div className="space-y-3">
          {Array.from({ length: 3 }).map((_, i) => (
            <div key={i} className="h-16 bg-muted animate-pulse rounded-lg" />
          ))}
        </div>
      ) : backups.length === 0 ? (
        <Card className="border-border/50">
          <CardContent className="py-8 text-center text-muted-foreground">
            <p>No backups yet. Create one before installing mods or switching versions.</p>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-3">
          {backups.map((backup) => (
            <Card key={backup.name} className="border-border/50 shadow-sm">
              <CardContent className="flex items-center justify-between py-4">
                <div className="space-y-1">
                  <p className="text-sm font-medium font-mono">{backup.name}</p>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span>{new Date(backup.createdAt).toLocaleString()}</span>
                    <Badge variant="outline" className="text-[10px]">
                      {formatSize(backup.size)}
                    </Badge>
                  </div>
                </div>
                <div className="flex gap-2">
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => handleRestore(backup.name)}
                    disabled={restoring === backup.name}
                  >
                    {restoring === backup.name ? "Restoring..." : "Restore"}
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => handleDelete(backup.name)}
                  >
                    Delete
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}
    </div>
  );
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
