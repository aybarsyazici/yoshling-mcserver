"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Layers3, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useOperations } from "@/components/operations-provider";
import type { MinecraftProfileDTO } from "@/lib/minecraft-profile-types";
import type { MinecraftProfileOverviewDTO } from "@/lib/minecraft-profile-overview-types";
import { overviewDate, overviewStateLabel, parseMinecraftProfileOverview, parseMinecraftProfileOverviewRead, parseMinecraftProfileOverviewRequest } from "@/lib/minecraft-profile-images";
import { readOperationResponse, UnconfirmedOperationResult, unconfirmedOperationMessage } from "@/lib/operation-client";
import { withOverviewDeadline } from "@/lib/minecraft-profile-overview-deadline";

interface Props {
  profile: MinecraftProfileDTO;
  canRender: boolean;
  readEpoch?: number;
  onOverviewRead(overview: MinecraftProfileOverviewDTO): void;
  onProfileRecheck(): Promise<boolean>;
}
export function MinecraftProfileOverview(props: Props) { return <OverviewSession key={props.profile.id} {...props} />; }
function OverviewSession({ profile, canRender, readEpoch = 0, onOverviewRead, onProfileRecheck }: Props) {
  const { refresh: refreshOperations } = useOperations();
  const [accepted, setAccepted] = useState(false);
  const [overview, setOverview] = useState<MinecraftProfileOverviewDTO | null>(() => parseMinecraftProfileOverview(profile.overview, profile.id));
  const [readError, setReadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const error = actionError || readError;
  const [blocked, setBlocked] = useState(false);
  const [requesting, setRequesting] = useState(false);
  const [rechecking, setRechecking] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const generation = useRef(0), lifetime = useRef(0), inFlight = useRef(false), actionActive = useRef(false);
  const endpoint = `/api/minecraft/profiles/${encodeURIComponent(profile.id)}/overview`;
  const invalidateRead = useCallback(() => { generation.current++; }, []);
  useEffect(() => () => { lifetime.current++; generation.current++; }, []);
  const read = useCallback(async () => {
    const request = ++generation.current; inFlight.current = true; setRefreshing(true);
    try {
      const { response, raw } = await withOverviewDeadline(async signal => {
        const response = await fetch(endpoint, { cache: "no-store", signal });
        const raw: unknown = await response.json(); return { response, raw };
      });
      if (request !== generation.current) return false;
      const parsed = parseMinecraftProfileOverviewRead(raw, profile.id);
      if (!response.ok || !parsed) throw new Error("The overview status could not be confirmed. Recheck before requesting another render.");
      setOverview(parsed); setAccepted(true); setReadError(null); onOverviewRead(parsed);
      return true;
    } catch (e) { if (request === generation.current) { setReadError(e instanceof Error ? e.message : "The overview status could not be read."); setAccepted(false); } return false; }
    finally { if (request === generation.current) { inFlight.current = false; setRefreshing(false); } }
  }, [endpoint, profile.id, onOverviewRead]);
  useEffect(() => {
    let current = true;
    void Promise.resolve().then(() => { if (current) void read(); });
    const timer = window.setInterval(() => { if (!document.hidden && !inFlight.current && !actionActive.current) void read(); }, 5000);
    return () => { current = false; invalidateRead(); window.clearInterval(timer); };
  }, [read, readEpoch, profile.revision, invalidateRead]);
  const pending = overview?.state === "queued" || overview?.state === "rendering";
  const allowed = canRender && profile.status === "ready" && accepted && !error && !blocked && !requesting && !rechecking && !pending && overview?.state !== "unsupported";
  async function requestOverview() {
    if (!allowed || !overview) return;
    const request = lifetime.current;
    let knownRefusal = false;
    let operationId: string | undefined;
    actionActive.current = true; setRequesting(true); setActionError(null);
    try {
      const { response, raw } = await withOverviewDeadline(async signal => {
        const response = await fetch(endpoint, { method: "POST", signal, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ expectedRevision: profile.revision, expectedOverviewRevision: overview.revision }) });
        operationId = response.headers.get("X-Operation-Id") || undefined;
        return { response, raw: await readOperationResponse(response) };
      });
      if (request !== lifetime.current) return;
      if (!response.ok && !raw.operationId && raw.error && response.status >= 400 && response.status < 500) { knownRefusal = true; throw new Error(raw.error); }
      const receipt = parseMinecraftProfileOverviewRequest(raw, profile.id);
      if (!response.ok || !receipt) throw new UnconfirmedOperationResult(raw.operationId);
      // The ledger owns admission/completion. A queue receipt does not prove a rendered image.
      await read();
    } catch (e) { if (request === lifetime.current) { setBlocked(true); setActionError(knownRefusal && e instanceof Error ? e.message : unconfirmedOperationMessage("world overview request", e instanceof UnconfirmedOperationResult ? e : new UnconfirmedOperationResult(operationId))); } }
    finally { void refreshOperations(); if (request === lifetime.current) { actionActive.current = false; setRequesting(false); } }
  }
  async function reconcile() {
    if (requesting || rechecking) return;
    const request = lifetime.current; actionActive.current = true; setRechecking(true);
    try {
      if (blocked && !(await onProfileRecheck())) return;
      const results = await Promise.all([read(), refreshOperations()]);
      if (request !== lifetime.current) return;
      if (results.every(result => result === true)) { setBlocked(false); setActionError(null); }
      else { setBlocked(true); setActionError("The latest overview and operation readings could not both be confirmed. Recheck before another request."); }
    } catch { if (request === lifetime.current) { setBlocked(true); setActionError("The overview recheck is unconfirmed. Recheck again before another request."); } }
    finally { if (request === lifetime.current) { actionActive.current = false; setRechecking(false); } }
  }
  return <div className="space-y-3 rounded-xl border border-border/70 bg-background/40 p-4" aria-label="Generated world overview">
    <div className="flex items-start gap-3"><Layers3 aria-hidden="true" className="mt-0.5 size-5 shrink-0" /><div><h3 className="font-display font-semibold">Automatic world overview</h3><p className="text-sm text-muted-foreground">The default image is generated from a saved Overworld snapshot. A custom cover takes priority. Generating an overview does not start a world.</p></div></div>
    <p role="status" className="text-sm">{overview ? overviewStateLabel(overview) : refreshing ? "Reading overview status…" : "Overview status not available"}{error && overview ? " · Last confirmed status" : ""}</p>
    {overview?.reason && <p className="text-sm text-muted-foreground">{overview.reason}</p>}
    {overview?.generatedAt && <p className="text-xs text-muted-foreground">Generated {overviewDate(overview.generatedAt)}</p>}
    {overview?.sourceSavedAt && <p className="text-xs text-muted-foreground">Source world last saved {overviewDate(overview.sourceSavedAt)}</p>}
    {overview?.snapshotAt && <p className="text-xs text-muted-foreground">Snapshot taken {overviewDate(overview.snapshotAt)}</p>}
    {overview?.renderer && <p className="text-xs text-muted-foreground">Renderer: {overview.renderer.name} {overview.renderer.version}</p>}
    {overview?.operationId && pending && <p className="text-xs text-muted-foreground">Check the operation strip for render progress.</p>}
    {error && <p role="alert" className="text-sm">{error}</p>}
    <div className="flex flex-wrap gap-2"><Button variant="outline" disabled={requesting || rechecking || (refreshing && !accepted)} onClick={() => void reconcile()}><RefreshCw aria-hidden="true" className="size-4" />{rechecking ? "Rechecking overview…" : blocked ? "Recheck profile and overview" : "Recheck overview"}</Button>{canRender && <Button disabled={!allowed} onClick={() => void requestOverview()}>{requesting ? "Requesting overview…" : overview?.imageUrl ? "Refresh world overview" : "Request world overview"}</Button>}</div>
  </div>;
}
