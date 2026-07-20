"use client";

import { useState, useEffect } from "react";
import { motion } from "motion/react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { toast } from "sonner";
import { SectionHeading } from "@/components/ui-bits";
import { PhotoFooter } from "@/components/photo-footer";

const ROLE_TINT: Record<string, string> = {
  ADMIN: "var(--sd)",
  MOD: "var(--chart-2)",
  MEMBER: "var(--mc)",
};

interface User {
  id: string;
  discordId: string;
  username: string;
  avatar: string | null;
  role: string;
  createdAt: string;
}

export default function UsersPage() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/users")
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setUsers(data);
      })
      .finally(() => setLoading(false));
  }, []);

  async function handleRoleChange(userId: string, newRole: string) {
    try {
      const res = await fetch(`/api/users/${userId}/role`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: newRole }),
      });

      if (res.ok) {
        setUsers((prev) =>
          prev.map((u) => (u.id === userId ? { ...u, role: newRole } : u))
        );
        toast.success("Role updated");
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to update role");
      }
    } catch {
      toast.error("Failed to update role");
    }
  }

  return (
    <div className="space-y-6">
      <SectionHeading
        eyebrow="Shared · Access"
        title="Crew"
        sub="Who can command the servers, and what they're allowed to do."
      />

      <div className="rounded-2xl bg-card/70 p-2 ring-1 ring-foreground/10 backdrop-blur">
        {loading ? (
          <div className="space-y-2 p-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <div key={i} className="skeleton h-16 rounded-xl" />
            ))}
          </div>
        ) : (
          <div className="space-y-1">
            {users.map((user, i) => (
              <motion.div
                key={user.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: i * 0.04 }}
                className="flex items-center justify-between rounded-xl p-3 transition-colors hover:bg-muted/50"
              >
                <div className="flex items-center gap-3">
                  <div className="relative">
                    <Avatar className="h-10 w-10 ring-2" style={{ boxShadow: `0 0 0 2px color-mix(in oklab, ${ROLE_TINT[user.role] ?? "var(--border)"} 40%, transparent)` }}>
                      <AvatarImage src={user.avatar || undefined} />
                      <AvatarFallback>{user.username[0]?.toUpperCase()}</AvatarFallback>
                    </Avatar>
                  </div>
                  <div>
                    <p className="text-sm font-semibold">{user.username}</p>
                    <p className="text-xs text-muted-foreground">
                      Joined {new Date(user.createdAt).toLocaleDateString()}
                    </p>
                  </div>
                </div>
                <Select value={user.role} onValueChange={(role) => { if (role) handleRoleChange(user.id, role); }}>
                  <SelectTrigger className="w-[120px]" style={{ color: ROLE_TINT[user.role] }}>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="ADMIN">Admin</SelectItem>
                    <SelectItem value="MOD">Mod</SelectItem>
                    <SelectItem value="MEMBER">Member</SelectItem>
                  </SelectContent>
                </Select>
              </motion.div>
            ))}
          </div>
        )}
      </div>

      <PhotoFooter src="/pub-table.jpg" />
    </div>
  );
}
