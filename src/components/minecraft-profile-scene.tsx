"use client";

import { useId, type CSSProperties } from "react";
import { motion } from "motion/react";
import { usePrefersReducedMotion } from "@/components/motion";
import { cn } from "@/lib/utils";

/** Decorative illustration, never a screenshot or evidence of a world's contents. */
export function MinecraftProfileScene({
  variant = "vanilla", className, animated = false,
}: { variant?: "vanilla" | "saved-set" | "modrinth" | "adopt"; className?: string; animated?: boolean }) {
  const id = useId().replace(/:/g, "");
  const reduced = usePrefersReducedMotion();
  const moving = animated && !reduced;
  const accent = variant === "saved-set" ? "var(--chart-3)" : variant === "modrinth" ? "var(--chart-5)" : variant === "adopt" ? "var(--chart-4)" : "var(--mc)";
  return <svg viewBox="0 0 640 260" fill="none" aria-hidden="true" focusable="false" preserveAspectRatio="xMidYMid slice" className={cn("pointer-events-none h-full w-full select-none", className)} data-profile-scene={variant} data-motion-mode={moving ? "animated" : reduced ? "reduced" : "static"} style={{ "--scene-accent": accent } as CSSProperties}>
    <defs>
      <linearGradient id={`${id}-sky`} x1="320" y1="0" x2="320" y2="260" gradientUnits="userSpaceOnUse"><stop stopColor="var(--chart-1)" stopOpacity=".24"/><stop offset="1" stopColor="var(--mc)" stopOpacity=".07"/></linearGradient>
      <linearGradient id={`${id}-sun`} x1="482" y1="38" x2="526" y2="84" gradientUnits="userSpaceOnUse"><stop stopColor="var(--scene-accent)"/><stop offset="1" stopColor="var(--chart-4)"/></linearGradient>
      <pattern id={`${id}-pixels`} width="24" height="24" patternUnits="userSpaceOnUse"><path d="M24 0H0V24" stroke="var(--foreground)" strokeOpacity=".035"/></pattern>
    </defs>
    <rect width="640" height="260" fill={`url(#${id}-sky)`}/><rect width="640" height="260" fill={`url(#${id}-pixels)`}/>
    <rect x="475" y="34" width="48" height="48" rx="3" fill={`url(#${id}-sun)`} opacity=".88"/>
    <rect x="483" y="42" width="48" height="48" rx="3" fill="var(--scene-accent)" opacity=".09"/>
    <motion.g animate={moving ? { x: [0, 12, 0] } : undefined} transition={moving ? { duration: 18, repeat: Infinity, ease: "easeInOut" } : undefined} fill="var(--foreground)" opacity=".1">
      <path d="M345 43h32v-9h34v9h29v13h-95z"/><path d="M545 89h25V78h28v11h33v13h-86z"/>
    </motion.g>
    <motion.g animate={moving ? { x: [0, -8, 0] } : undefined} transition={moving ? { duration: 22, repeat: Infinity, ease: "easeInOut" } : undefined} fill="var(--foreground)" opacity=".07"><path d="M199 76h25V65h39v11h30v12h-94z"/></motion.g>
    <path d="M0 165h48v-15h44v13h45v-24h50v-17h44v17h38v-24h44V96h41v19h41v27h56v-19h38v24h49v-18h42v30h55v18h45v83H0z" fill="var(--scene-accent)" opacity=".12"/>
    <path d="M185 185h54v-22h42v-20h40v-28h33v28h36v23h37v19h46v18h167v57H185z" fill="var(--mc)" opacity=".19"/>
    <path d="M0 201h85v-14h49v15h64v-22h71v18h77v-13h58v24h52v-12h76v18h108v45H0z" fill="var(--mc)" opacity=".34"/>
    <path d="M0 211h85v-14h49v15h64v-22h71v18h77v-13h58v24h52v-12h76v18h108v35H0z" fill="var(--foreground)" opacity=".09"/>
    <path d="M0 201h85v-14h49v15h64v-22h71v18h77v-13h58v24h52v-12h76v18h108" stroke="var(--mc)" strokeWidth="4" opacity=".6"/>
    <g shapeRendering="crispEdges">
      <path d="M405 159h10v50h-10z" fill="var(--chart-5)" opacity=".68"/><path d="M384 120h52v18h10v25h-71v-25h9z" fill="var(--mc)" opacity=".75"/><path d="M392 116h35v16h-35z" fill="var(--mc)" opacity=".56"/>
      <path d="M571 180h8v35h-8z" fill="var(--chart-5)" opacity=".6"/><path d="M555 152h40v14h8v20h-56v-20h8z" fill="var(--mc)" opacity=".62"/>
      {variant === "adopt" ? <g><path d="M467 157h67v51h-67z" fill="var(--chart-4)" opacity=".66"/><path d="M459 151h13v-12h14v-12h29v12h14v12h13v12h-83z" fill="var(--chart-5)" opacity=".77"/><path d="M494 182h13v26h-13z" fill="var(--popover)" opacity=".8"/><path d="M477 170h10v10h-10zM516 170h10v10h-10z" fill="var(--chart-1)" opacity=".8"/></g> : <g><path d="M481 172h33v26h-33z" fill="var(--scene-accent)" opacity=".65"/><path d="M478 169h39v7h-39z" fill="var(--foreground)" opacity=".32"/><path d="M496 179h5v7h-5z" fill="var(--popover)"/></g>}
      {variant === "modrinth" && <g fill="var(--chart-3)" opacity=".72"><path d="M342 153h8v14h-8zM336 166h20v7h-20z"/><path d="M351 177h7v8h-7z"/></g>}
      {variant === "saved-set" && <g fill="var(--scene-accent)" opacity=".7"><path d="M293 163h16v16h-16zM309 148h16v16h-16zM323 164h15v15h-15z"/></g>}
      <path d="M222 208h5v8h-5zM249 219h5v9h-5zM448 220h5v8h-5zM539 232h5v8h-5z" fill="var(--scene-accent)" opacity=".7"/>
    </g>
    <path d="M276 235h45v-10h34v-10h27v-7h20v9h-24v10h-34v10h-28v10h-40z" fill="var(--chart-1)" opacity=".35"/>
  </svg>;
}
