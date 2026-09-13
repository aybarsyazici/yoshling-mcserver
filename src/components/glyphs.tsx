// Hand-drawn SVG glyphs that give each world its own visual language, plus a
// few utility marks. Kept crisp at any size; inherit currentColor.

import { type GameId } from "@/lib/games";

type P = { className?: string; style?: React.CSSProperties };

/** Blocky creeper face — unmistakably Minecraft, pixel-grid construction. */
export function MinecraftGlyph({ className, style }: P) {
  return (
    <svg viewBox="0 0 24 24" className={className} style={style} fill="currentColor" aria-hidden>
      <path d="M3 3h18v18H3V3zm2 2v14h14V5H5z" opacity="0.35" />
      {/* eyes */}
      <rect x="7" y="8" width="3.2" height="3.2" />
      <rect x="13.8" y="8" width="3.2" height="3.2" />
      {/* mouth */}
      <rect x="10.4" y="11.2" width="3.2" height="3.2" />
      <rect x="8.4" y="14.4" width="3" height="3" />
      <rect x="12.6" y="14.4" width="3" height="3" />
    </svg>
  );
}

/** Hazmat skull — 7 Days to Die horde/danger flavor. */
export function ZombieGlyph({ className, style }: P) {
  return (
    <svg viewBox="0 0 24 24" className={className} style={style} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 2.5c-4.4 0-7.5 3-7.5 7.2 0 2.3 1 4 2.4 5.1.5.4.8 1 .8 1.7v1.3c0 .8.6 1.4 1.4 1.4h5.8c.8 0 1.4-.6 1.4-1.4v-1.3c0-.7.3-1.3.8-1.7 1.4-1.1 2.4-2.8 2.4-5.1 0-4.2-3.1-7.2-7.5-7.2z" />
      {/* hollow eyes (angled = menacing) */}
      <path d="M8 9.5l2.2 1M8 11.2l2.2-1" />
      <path d="M16 9.5l-2.2 1M16 11.2l-2.2-1" />
      {/* stitched mouth */}
      <path d="M9 17h6M10 15.6v2.8M12 15.6v2.8M14 15.6v2.8" />
    </svg>
  );
}

/** Boarded-up window — the Project Zomboid image, and not another skull. */
export function ZomboidGlyph({ className, style }: P) {
  return (
    <svg viewBox="0 0 24 24" className={className} style={style} aria-hidden>
      {/* window frame + panes */}
      <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round">
        <rect x="3.6" y="3.2" width="16.8" height="17.6" rx="1.2" />
        <path d="M12 3.2v17.6M3.6 12h16.8" opacity="0.4" />
      </g>
      {/* boards nailed across it */}
      <g fill="currentColor">
        <path d="M1.6 8.9 22.4 5.6v3.3L1.6 12.2z" />
        <path d="M1.6 15.1 22.4 11.8v3.3L1.6 18.4z" />
      </g>
    </svg>
  );
}

/** The right glyph for a world. Keeps the per-game branch in exactly one place. */
export function GameMark({ game, className, style }: P & { game: GameId }) {
  if (game === "minecraft") return <MinecraftGlyph className={className} style={style} />;
  if (game === "7dtd") return <ZombieGlyph className={className} style={style} />;
  return <ZomboidGlyph className={className} style={style} />;
}

export function PowerGlyph({ className, style }: P) {
  return (
    <svg viewBox="0 0 24 24" className={className} style={style} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M12 3v9" />
      <path d="M6.4 6.4a8 8 0 1 0 11.2 0" />
    </svg>
  );
}

export function ArrowGlyph({ className, style }: P) {
  return (
    <svg viewBox="0 0 24 24" className={className} style={style} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M5 12h14M13 6l6 6-6 6" />
    </svg>
  );
}

export function GearGlyph({ className, style }: P) {
  return (
    <svg viewBox="0 0 24 24" className={className} style={style} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  );
}
