"use client";

import Image from "next/image";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";

/**
 * Hidden easter egg: rest the pointer in the very bottom-right corner for a
 * moment and British Miku peeks up. Leaving the corner tucks her back down.
 * Purely decorative, pointer-events gated so it never blocks real UI.
 */
export function MikuEasterEgg() {
  const [revealed, setRevealed] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function arm() {
    if (timer.current) clearTimeout(timer.current);
    // sustained hover before she appears
    timer.current = setTimeout(() => setRevealed(true), 1100);
  }
  function disarm() {
    if (timer.current) clearTimeout(timer.current);
    setRevealed(false);
  }

  useEffect(() => () => {
    if (timer.current) clearTimeout(timer.current);
  }, []);

  return (
    <>
      {/* Invisible corner trigger — small, fixed, doesn't capture clicks */}
      <div
        className="fixed bottom-0 right-0 z-40 h-24 w-24"
        onMouseEnter={arm}
        onMouseLeave={disarm}
        aria-hidden
      />

      <AnimatePresence>
        {revealed && (
          <motion.div
            className="pointer-events-none fixed bottom-0 right-2 z-30 select-none"
            initial={{ y: 240, opacity: 0, rotate: 4 }}
            animate={{ y: 0, opacity: 1, rotate: 0 }}
            exit={{ y: 240, opacity: 0, rotate: 4 }}
            transition={{ type: "spring", stiffness: 120, damping: 16 }}
          >
            <motion.div
              animate={{ y: [0, -6, 0] }}
              transition={{ duration: 3.5, repeat: Infinity, ease: "easeInOut" }}
              className="relative"
              style={{ filter: "drop-shadow(0 -8px 24px rgba(0,0,0,0.45))" }}
            >
              <Image
                src="/british-miku.webp"
                alt=""
                width={200}
                height={266}
                className="h-auto w-[150px] rounded-t-2xl sm:w-[190px]"
                priority={false}
              />
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
