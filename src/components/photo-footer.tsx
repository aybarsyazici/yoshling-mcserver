"use client";

import Image from "next/image";
import { motion } from "motion/react";
import { Reveal } from "@/components/motion";

/**
 * A small, self-aware "gang" photo strip anchored to the bottom of a page.
 * Deliberately understated so it never competes with real controls — it's a
 * wink, not a banner. Photos gently tilt straight on hover.
 */
export function PhotoFooter({
  src,
  caption,
}: {
  src: string;
  caption: string;
}) {
  return (
    <Reveal className="pt-6">
      <div className="flex flex-col items-center gap-2">
        <motion.div
          initial={{ rotate: -2 }}
          whileHover={{ rotate: 0, scale: 1.02 }}
          transition={{ type: "spring", stiffness: 300, damping: 20 }}
          className="relative overflow-hidden rounded-2xl ring-1 ring-foreground/10"
          style={{ boxShadow: "0 12px 40px -16px rgba(0,0,0,0.5)" }}
        >
          <Image
            src={src}
            alt={caption}
            width={360}
            height={240}
            className="h-auto w-[280px] object-cover sm:w-[340px]"
          />
          <div className="pointer-events-none absolute inset-0 bg-gradient-to-t from-black/30 to-transparent" />
        </motion.div>
        <p className="font-mono text-xs italic text-muted-foreground">{caption}</p>
      </div>
    </Reveal>
  );
}

/** A row of multiple photos for the "hall of fame" at the bottom of overview pages. */
export function PhotoStrip({ photos }: { photos: { src: string; caption: string }[] }) {
  return (
    <Reveal className="pt-6">
      <div className="flex flex-wrap items-end justify-center gap-4">
        {photos.map((p, i) => (
          <motion.div
            key={p.src}
            initial={{ rotate: i % 2 === 0 ? -3 : 3, y: 0 }}
            whileHover={{ rotate: 0, y: -6, scale: 1.04, zIndex: 10 }}
            transition={{ type: "spring", stiffness: 260, damping: 18 }}
            className="relative overflow-hidden rounded-xl ring-1 ring-foreground/10"
            style={{ boxShadow: "0 10px 30px -14px rgba(0,0,0,0.5)" }}
          >
            <Image src={p.src} alt={p.caption} width={180} height={180} className="h-40 w-40 object-cover" />
            <div className="pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/60 to-transparent p-2">
              <p className="font-mono text-[10px] text-white/90">{p.caption}</p>
            </div>
          </motion.div>
        ))}
      </div>
    </Reveal>
  );
}
