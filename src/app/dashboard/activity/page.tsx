"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

interface Activity {
  id: string;
  action: string;
  details: string;
  createdAt: string;
  user: { username: string; avatar: string | null };
}

export default function ActivityPage() {
  const [activities, setActivities] = useState<Activity[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch("/api/activity")
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setActivities(data);
      })
      .finally(() => setLoading(false));
  }, []);

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-3xl font-bold tracking-tight">Activity Log</h2>
        <p className="text-muted-foreground">
          Track all changes made to the server
        </p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Recent Activity</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="space-y-3">
              {Array.from({ length: 5 }).map((_, i) => (
                <div key={i} className="h-10 bg-muted rounded animate-pulse" />
              ))}
            </div>
          ) : activities.length === 0 ? (
            <p className="text-sm text-muted-foreground text-center py-8">No activity yet</p>
          ) : (
            <div className="space-y-4">
              {activities.map((activity) => {
                const details = JSON.parse(activity.details);
                return (
                  <div
                    key={activity.id}
                    className="flex items-start justify-between border-b border-border pb-3 last:border-0"
                  >
                    <div className="space-y-1">
                      <p className="text-sm">
                        <span className="font-medium">
                          {activity.user.username}
                        </span>{" "}
                        <span className="text-muted-foreground">
                          {formatAction(activity.action, details)}
                        </span>
                      </p>
                    </div>
                    <time className="text-xs text-muted-foreground whitespace-nowrap">
                      {new Date(activity.createdAt).toLocaleString()}
                    </time>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function formatAction(action: string, details: any): string {
  switch (action) {
    case "install_mod":
      return `installed ${details.modName} (v${details.version})`;
    case "remove_mod":
      return `removed ${details.modName}`;
    case "update_mod":
      return `updated ${details.modName} from v${details.fromVersion} to v${details.toVersion}`;
    case "server_start":
      return "started the server";
    case "server_stop":
      return "stopped the server";
    case "server_restart":
      return "restarted the server";
    default:
      return action;
  }
}
