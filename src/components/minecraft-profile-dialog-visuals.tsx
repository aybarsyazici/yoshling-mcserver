"use client";
import type { ReactNode } from "react";
import { motion } from "motion/react";
import { Compass, Layers3, ShieldCheck } from "lucide-react";
import { usePrefersReducedMotion } from "@/components/motion";
import { MinecraftProfileScene } from "@/components/minecraft-profile-scene";
import { DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import styles from "@/components/minecraft-profile-dialog.module.css";

export function ProfileDialogHero({ title, description, variant = "vanilla", eyebrow = "Minecraft · World builder" }: { title: string; description: string; variant?: Parameters<typeof MinecraftProfileScene>[0]["variant"]; eyebrow?: string }) {
  return <DialogHeader className={styles.hero}>
    <div className={styles.scene}><MinecraftProfileScene variant={variant} animated /></div><div className={styles.scrim} aria-hidden="true" />
    <ProfileDialogReveal><p className={styles.kicker}><Compass className="size-3.5" aria-hidden="true" />{eyebrow}</p><DialogTitle className={styles.title}>{title}</DialogTitle><DialogDescription className={styles.description}>{description}</DialogDescription></ProfileDialogReveal>
  </DialogHeader>;
}
export function ProfileDialogReveal({ children, delay = 0, className }: { children: ReactNode; delay?: number; className?: string }) {
  const reduced = usePrefersReducedMotion();
  return <motion.div className={className} data-profile-motion={reduced ? "reduced" : "animated"} initial={reduced ? false : { opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reduced ? 0 : .4, delay: reduced ? 0 : delay, ease: [.22, 1, .36, 1] }}>{children}</motion.div>;
}
export function ProfileFormSection({ step, title, hint, children, className }: { step: string; title: string; hint?: string; children: ReactNode; className?: string }) {
  return <section className={cn(styles.section, className)}><div className={styles.sectionHeader}><span className={styles.step} aria-hidden="true">{step}</span><div><h3 className={styles.sectionTitle}>{title}</h3>{hint && <p className={styles.sectionSub}>{hint}</p>}</div></div>{children}</section>;
}
export function ProfileDraftPreview({ name, description = "", source, target, variant = "vanilla", adopt = false }: { name: string; description?: string; source: string; target: string; variant?: Parameters<typeof MinecraftProfileScene>[0]["variant"]; adopt?: boolean }) {
  return <aside className={styles.preview} aria-label="Profile preview"><div className={styles.previewScene}><MinecraftProfileScene variant={variant} /></div><div className={styles.previewContent}><p className={styles.previewLabel}>Your profile · Draft illustration</p><p className={styles.previewName}>{name.trim() || (adopt ? "Your existing world" : "Your next adventure")}</p>{description.trim() && <p className="mt-1.5 break-words text-xs leading-relaxed text-muted-foreground">{description}</p>}<div className="mt-4 space-y-2 text-xs"><p className="flex items-start gap-2"><Layers3 className="mt-px size-3.5 shrink-0 text-[var(--mc)]" aria-hidden="true"/><span className="min-w-0">{source}</span></p><p className="font-mono text-[11px] leading-relaxed text-muted-foreground">{target}</p></div><div className="mt-4 flex items-start gap-2 border-t border-border/60 pt-3 text-[11px] leading-relaxed text-muted-foreground"><ShieldCheck className="mt-px size-3.5 shrink-0 text-[var(--mc)]" aria-hidden="true"/><p>{adopt ? "Existing progress stays with this profile. Adoption leaves Minecraft stopped." : "A separate world. Preparation leaves the running profile alone."}</p></div></div></aside>;
}
