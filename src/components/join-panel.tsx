"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { Check, Copy, LogIn } from "lucide-react";
import { GAMES, type GameId } from "@/lib/games";
import { parseJoinInfo, type JoinInfo } from "@/lib/join-info";
import type { GameSnapshot } from "@/lib/use-games";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

interface JoinPanelProps {
  game: GameId;
  snapshot?: GameSnapshot;
  lastSuccessAt?: number | null;
  pollError?: string | null;
  busy?: boolean;
  compact?: boolean;
}

/** Key the session so a game switch cannot carry clipboard feedback or target evidence. */
export function JoinPanel(props: JoinPanelProps) {
  return <JoinPanelSession key={props.game} {...props} />;
}

function CopyAddress({ address }: { address: string }) {
  const [state, setState] = useState<"idle" | "copying" | "copied" | "failed">("idle");
  async function copy() {
    setState("copying");
    try {
      await navigator.clipboard.writeText(address);
      setState("copied");
    } catch {
      setState("failed");
    }
  }
  return <div className="min-w-0">
    <div className="flex flex-wrap items-center justify-between gap-x-2 gap-y-1">
      <code className="min-w-0 select-all break-all text-xs text-foreground">{address}</code>
      <Button type="button" variant="ghost" className="h-10 shrink-0 px-2 text-xs" aria-label={`Copy ${address}`} disabled={state === "copying"} onClick={copy}>
        {state === "copied" ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
        {state === "copying" ? "Copying…" : state === "copied" ? "Copied" : "Copy"}
      </Button>
    </div>
    <p role="status" className="text-xs text-muted-foreground">
      {state === "failed" ? "Copy failed. Select the address and copy it manually." : state === "copied" ? "Address copied." : ""}
    </p>
  </div>;
}

function Availability({ snapshot, lastSuccessAt, pollError, busy }: JoinPanelProps) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);
  // An undefined timestamp from an older hook/build is also unverified.
  const fresh = !!lastSuccessAt && now - lastSuccessAt <= 15_000 && !pollError;
  let text = "Server availability is unconfirmed. Wait for a fresh status reading.";
  if (fresh && snapshot) {
    if (busy) text = "A server operation is in progress. Wait for it to finish before joining.";
    else if (snapshot.status === "online") text = `Server responding · ${snapshot.players.online}/${snapshot.players.max} players`;
    else if (snapshot.status === "offline") text = snapshot.containerRunning
      ? "The server is not responding. Ask a world moderator to check it."
      : "The server is stopped. Ask a world moderator to power it on.";
    else text = `The server is ${snapshot.status}. Wait for it to respond before joining.`;
  }
  return <p className="text-xs text-muted-foreground">{text}</p>;
}

function MinecraftRequirements() {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{ loading: boolean; info: JoinInfo | null; error: string | null }>({ loading: true, info: null, error: null });
  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    void (async () => {
      try {
        const response = await fetch("/api/games/join?game=minecraft", { cache: "no-store", signal: controller.signal });
        if (!response.ok) throw new Error("Target request failed");
        const info = parseJoinInfo(await response.json(), "minecraft");
        if (!info) throw new Error("Incomplete target response");
        if (active) setState({ loading: false, info, error: null });
      } catch {
        if (active) setState({ loading: false, info: null, error: "The Minecraft target could not be checked." });
      }
    })();
    return () => { active = false; controller.abort(); };
  }, [attempt]);
  const target = state.info?.target;
  return <div className="space-y-2 rounded-xl bg-muted/50 p-3">
    <p className="text-xs font-medium">Minecraft server target</p>
    {state.loading ? <p role="status" className="text-xs text-muted-foreground">Checking version and loader…</p> : target ? <>
      <p className="font-mono text-sm">{target.mcVersion} · {target.loader}</p>
      <p className="text-xs text-muted-foreground">The configured version and loader agree with the server container. This does not verify a client pack or a successful game join.</p>
      <p className="text-xs text-muted-foreground">Checked {new Date(state.info!.checkedAt).toLocaleString()}. Recheck if the server settings change.</p>
    </> : <p role="alert" className="text-xs text-muted-foreground">{state.error || "The exact Minecraft version and loader are unknown or could not be verified."} Ask the world owner which client version and pack to use.</p>}
    <Button variant="outline" className="h-10 text-xs" disabled={state.loading} onClick={() => { setState({ loading: true, info: null, error: null }); setAttempt(value => value + 1); }}>
      {target ? "Recheck target" : "Retry target check"}
    </Button>
  </div>;
}

const GUIDANCE: Record<GameId, string[]> = {
  minecraft: [
    "Use Minecraft Java Edition and match the server version below.",
    "For a modded world, ask the world owner for the matching client pack and loader. The server mod list is not a complete client pack.",
    "Add the address in Multiplayer, then connect. Ask the world owner if a game whitelist is enabled.",
  ],
  "7dtd": [
    "Match the server's exact game build and Steam branch. Ask the world owner to confirm them; this panel cannot verify that build.",
    "Use the game's direct-connect option with the IP address and port shown below.",
    "Ask the world owner for any required client mods and the game password.",
  ],
  zomboid: [
    "Match the server's game build and Steam beta branch. Ask the world owner to confirm them; this panel cannot verify that build.",
    "Add the server address and port in the game's multiplayer browser.",
    "Ask the world owner about required Workshop mods, your game account and any server password.",
  ],
};

function JoinPanelSession(props: JoinPanelProps) {
  const { game, compact } = props;
  const meta = GAMES[game];
  const [open, setOpen] = useState(false);
  return <section aria-label={`${meta.name} connection`} className={cn("relative space-y-2 rounded-xl bg-background/50 p-3 ring-1 ring-foreground/10", !compact && "bg-card/70 p-5")}>
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-sm font-medium">Join {meta.name}</h3>
      <Button variant="outline" className="h-10 text-xs" onClick={() => setOpen(true)} aria-label={`How to join ${meta.name}`}>
        <LogIn className="size-3.5" /> How to join
      </Button>
    </div>
    {!compact && <Availability {...props} />}
    <div className="divide-y divide-foreground/10">
      {meta.connect.map(address => <CopyAddress key={address} address={address} />)}
    </div>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="max-h-[85dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Join {meta.name}</DialogTitle>
          <DialogDescription>Use these details in your game client. Dashboard sign-in and world access are separate from game accounts and passwords.</DialogDescription>
        </DialogHeader>
        <Availability {...props} />
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          {GUIDANCE[game].map(line => <li key={line}>{line}</li>)}
        </ol>
        {open && game === "minecraft" && <MinecraftRequirements />}
        <div className="divide-y divide-foreground/10 rounded-xl bg-muted/50 p-3">
          {meta.connect.map(address => <CopyAddress key={address} address={address} />)}
        </div>
        {meta.hasMods && <Link href={`${meta.base}/mods`} className="inline-flex min-h-10 items-center text-sm underline underline-offset-4">View {game === "minecraft" ? "server mods and saved sets" : "Workshop mod list"}</Link>}
      </DialogContent>
    </Dialog>
  </section>;
}
