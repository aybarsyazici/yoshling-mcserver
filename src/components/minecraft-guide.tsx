"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Archive, ArrowLeft, ArrowRight, BookOpen, Check, CheckCheck, ChevronRight, Compass, ImageIcon, Layers3, Play, Puzzle, RotateCcw, Server, Settings } from "lucide-react";
import { Button } from "@/components/ui/button";
import { MinecraftProfileScene } from "@/components/minecraft-profile-scene";
import { GAMES } from "@/lib/games";
import { useGames, CAPABILITY_POLL_MS } from "@/lib/use-games";
import { MINECRAFT_GUIDE_CHAPTERS } from "@/lib/minecraft-guide";
import { defaultMinecraftGuideProgress, minecraftGuideStorageKey, parseMinecraftGuideProgress, saveMinecraftGuideProgress, type MinecraftGuideChapterId, type MinecraftGuideProgress } from "@/lib/minecraft-guide-progress";
import { cn } from "@/lib/utils";

const ICONS = { welcome: Compass, profiles: Layers3, play: Play, mods: Puzzle, backups: Archive, settings: Settings, covers: ImageIcon, server: Server };
export function MinecraftGuide({ userId }: { userId: string }) { return <GuideSession key={userId} userId={userId} />; }
function GuideSession({ userId }: { userId: string }) {
  const [progress, setProgress] = useState<MinecraftGuideProgress>(defaultMinecraftGuideProgress);
  const [loaded, setLoaded] = useState(false);
  const [remembered, setRemembered] = useState(false);
  const [resetting, setResetting] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const { can, access, loading, pollError } = useGames(CAPABILITY_POLL_MS);
  const canSettings = !loading && !pollError && access.includes("minecraft") && can.settings;
  useEffect(() => {
    let current = true;
    void Promise.resolve().then(() => {
      if (!current) return;
      try { const raw = window.localStorage.getItem(minecraftGuideStorageKey(userId)), stored = parseMinecraftGuideProgress(raw); setProgress(stored); setRemembered(raw !== null && raw === JSON.stringify(stored)); }
      catch { /* Private browsing or unavailable storage keeps this visit usable. */ }
      setLoaded(true);
    });
    return () => { current = false; };
  }, [userId]);
  const index = MINECRAFT_GUIDE_CHAPTERS.findIndex(chapter => chapter.id === progress.current);
  const chapter = MINECRAFT_GUIDE_CHAPTERS[index];
  const Icon = ICONS[chapter.id];
  const count = progress.completed.length;
  const complete = count === MINECRAFT_GUIDE_CHAPTERS.length;
  function commit(next: MinecraftGuideProgress) {
    if (!loaded) return;
    setProgress(next);
    try { setRemembered(saveMinecraftGuideProgress(window.localStorage, userId, next)); }
    catch { setRemembered(false); }
  }
  function choose(id: MinecraftGuideChapterId) {
    commit({ ...progress, current: id });
    // The same heading stays mounted, so keyboard readers land on the new lesson.
    requestAnimationFrame(() => heading.current?.focus({ preventScroll: true }));
  }
  function next() {
    const completed = [...new Set([...progress.completed, chapter.id])];
    commit({ version: 1, current: MINECRAFT_GUIDE_CHAPTERS[Math.min(index + 1, MINECRAFT_GUIDE_CHAPTERS.length - 1)].id, completed });
    requestAnimationFrame(() => heading.current?.focus({ preventScroll: true }));
  }
  return <div className="space-y-6" style={{ ["--tint" as string]: GAMES.minecraft.tint }}>
    <header className="relative isolate overflow-hidden rounded-3xl border border-[var(--tint)]/25 bg-card p-6 sm:p-8">
      <div aria-hidden="true" className="pointer-events-none absolute inset-y-0 right-0 hidden w-1/2 opacity-30 sm:block"><MinecraftProfileScene variant="vanilla" className="size-full" /></div>
      <div className="relative max-w-xl space-y-3">
        <p className="eyebrow flex items-center gap-2 text-foreground"><BookOpen aria-hidden="true" className="size-4" />Minecraft · Field guide</p>
        <h1 className="font-display text-3xl font-bold tracking-tight sm:text-4xl">Your first world, and the next</h1>
        <p className="text-sm leading-relaxed text-muted-foreground">A walkthrough of profiles, joining, mods and looking after your worlds. Read in order or jump to what you need.</p>
        <p className="text-xs text-muted-foreground">Reopen Minecraft guide from the sidebar at any time.</p>
      </div>
    </header>
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl bg-card/60 p-4 ring-1 ring-border">
      <div className="min-w-0 flex-1 space-y-2">
        <div className="flex flex-wrap justify-between gap-2 text-xs"><span role="status">{complete ? "Guide complete — revisit any chapter" : `${count} of ${MINECRAFT_GUIDE_CHAPTERS.length} chapters read`}</span><span className="text-muted-foreground">{!loaded ? "Loading your progress…" : remembered ? "Progress saved in this browser" : "Progress is available for this visit"}</span></div>
        <div role="progressbar" aria-label="Guide chapters read" aria-valuemin={0} aria-valuemax={MINECRAFT_GUIDE_CHAPTERS.length} aria-valuenow={count} className="h-1.5 overflow-hidden rounded-full bg-muted"><div className="h-full rounded-full bg-foreground motion-safe:transition-[width] motion-safe:duration-300" style={{ width: `${count / MINECRAFT_GUIDE_CHAPTERS.length * 100}%` }} /></div>
      </div>
      <Button variant="ghost" disabled={!loaded} onClick={() => setResetting(true)}><RotateCcw aria-hidden="true" className="size-3.5" />Start over</Button>
    </div>
    {resetting && <section aria-label="Reset guide progress" className="space-y-3 rounded-2xl border border-border bg-card p-4"><p className="text-sm">Start the guide again? This clears only your tutorial checklist.</p><div className="flex flex-wrap gap-2"><Button onClick={() => { commit(defaultMinecraftGuideProgress()); setResetting(false); }}>Reset guide progress</Button><Button variant="outline" onClick={() => setResetting(false)}>Keep my progress</Button></div></section>}
    <div className="grid items-start gap-5 lg:grid-cols-[15rem_minmax(0,1fr)]">
      <nav aria-label="Minecraft guide chapters" className="grid gap-1 rounded-2xl bg-card/60 p-2 ring-1 ring-border sm:grid-cols-2 lg:sticky lg:top-0 lg:grid-cols-1">
        {MINECRAFT_GUIDE_CHAPTERS.map((item, position) => { const Mark = ICONS[item.id]; const read = progress.completed.includes(item.id); return <button key={item.id} type="button" disabled={!loaded} aria-current={chapter.id === item.id ? "step" : undefined} onClick={() => choose(item.id)} className={cn("flex min-h-12 items-center gap-3 rounded-xl px-3 py-2 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-foreground disabled:opacity-50", chapter.id === item.id ? "bg-[var(--tint)]/15 text-foreground" : "text-muted-foreground hover:bg-muted/70 hover:text-foreground")}><span aria-hidden="true" className="grid size-8 shrink-0 place-items-center rounded-lg bg-background/70">{read ? <Check className="size-4 text-[var(--tint)]" /> : <Mark className="size-4" />}</span><span className="min-w-0 flex-1"><span className="block text-[10px] uppercase tracking-wider text-muted-foreground">Chapter {position + 1}{read ? " · Read" : ""}</span>{item.title}</span>{chapter.id === item.id && <ChevronRight aria-hidden="true" className="size-4 shrink-0" />}</button>; })}
      </nav>
      <article aria-label={chapter.title} className="min-w-0 overflow-hidden rounded-3xl border border-border bg-card/80">
        <div className="space-y-4 border-b border-border/70 p-5 sm:p-7">
          <div className="flex items-center gap-3"><span aria-hidden="true" className="grid size-12 place-items-center rounded-2xl bg-[var(--tint)]/15 text-[var(--tint)]"><Icon className="size-6" /></span><p className="eyebrow text-muted-foreground">Chapter {index + 1} / {MINECRAFT_GUIDE_CHAPTERS.length}</p></div>
          <h2 ref={heading} tabIndex={-1} className="font-display text-2xl font-bold tracking-tight outline-none focus-visible:rounded focus-visible:ring-2 focus-visible:ring-foreground">{chapter.title}</h2>
          <p className="text-sm leading-relaxed text-muted-foreground">{chapter.summary}</p>
        </div>
        <div key={chapter.id} className="space-y-5 p-5 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-200 sm:p-7">
          <ol className="space-y-5">{chapter.steps.map((step, position) => <li key={step.label} className="flex gap-3"><span aria-hidden="true" className="grid size-7 shrink-0 place-items-center rounded-full border border-[var(--tint)]/30 bg-[var(--tint)]/5 font-mono text-xs text-foreground">{position + 1}</span><div className="min-w-0 space-y-1"><h3 className="font-semibold">{step.label}</h3><p className="text-sm leading-relaxed text-muted-foreground">{step.text}</p></div></li>)}</ol>
          <aside className="rounded-xl border border-[var(--tint)]/20 bg-[var(--tint)]/5 p-4 text-sm leading-relaxed">{chapter.note}</aside>
          {chapter.settingsOnly && !canSettings ? <p className="text-sm text-muted-foreground">The Settings link needs confirmed moderator access. You can inspect profile details from <Link className="underline underline-offset-4" href="/minecraft">Profiles</Link>.</p> : <Link href={chapter.href} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm font-medium outline-none hover:bg-muted focus-visible:ring-2 focus-visible:ring-foreground">{chapter.linkLabel}<ArrowRight aria-hidden="true" className="size-4" /></Link>}
        </div>
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border/70 bg-background/40 p-5 sm:px-7"><Button variant="outline" disabled={!loaded || index === 0} onClick={() => choose(MINECRAFT_GUIDE_CHAPTERS[index - 1].id)}><ArrowLeft aria-hidden="true" className="size-4" />Previous</Button><Button disabled={!loaded} onClick={next}>{index === MINECRAFT_GUIDE_CHAPTERS.length - 1 ? <><CheckCheck aria-hidden="true" className="size-4" />Mark chapter read</> : <>Mark read & continue<ArrowRight aria-hidden="true" className="size-4" /></>}</Button></footer>
      </article>
    </div>
    <p className="text-xs leading-relaxed text-muted-foreground">This checklist tracks lessons you&apos;ve read. Follow the live screen&apos;s permissions, confirmations and operation results when you use a feature.</p>
  </div>;
}
