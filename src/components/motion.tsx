"use client";

import { motion, useMotionValue, useSpring, type Variants } from "motion/react";
import { useCallback, useEffect, useSyncExternalStore, type ReactNode } from "react";

/* Match the browser preference without changing state in a mount effect. */
function subscribeReducedMotion(notify: () => void) {
  const query = window.matchMedia("(prefers-reduced-motion: reduce)");
  query.addEventListener("change", notify);
  return () => query.removeEventListener("change", notify);
}
function reducedMotionSnapshot() {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}
export function usePrefersReducedMotion() {
  return useSyncExternalStore(subscribeReducedMotion, reducedMotionSnapshot, () => false);
}

const easeOut = [0.22, 1, 0.36, 1] as const;

/** Fade + rise in when scrolled into view (or on mount). */
export function Reveal({
  children,
  delay = 0,
  y = 16,
  className,
  once = true,
}: {
  children: ReactNode;
  delay?: number;
  y?: number;
  className?: string;
  once?: boolean;
}) {
  // Animate on mount. For the above-the-fold content these wrap, mount and
  // in-view coincide, and mount-based reveal has no dependency on
  // IntersectionObserver timing — so content can never get stuck hidden.
  void once;
  return (
    <motion.div
      className={className}
      initial={{ opacity: 0, y }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.5, delay, ease: easeOut }}
    >
      {children}
    </motion.div>
  );
}

/** Container that staggers its <StaggerItem> children. */
export function Stagger({
  children,
  className,
  delay = 0,
  gap = 0.07,
}: {
  children: ReactNode;
  className?: string;
  delay?: number;
  gap?: number;
}) {
  const variants: Variants = {
    hidden: {},
    show: { transition: { staggerChildren: gap, delayChildren: delay } },
  };
  return (
    <motion.div className={className} variants={variants} initial="hidden" animate="show">
      {children}
    </motion.div>
  );
}

const itemVariants: Variants = {
  hidden: { opacity: 0, y: 18, scale: 0.98 },
  show: { opacity: 1, y: 0, scale: 1, transition: { duration: 0.5, ease: easeOut } },
};

export function StaggerItem({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <motion.div variants={itemVariants} className={className}>
      {children}
    </motion.div>
  );
}

/** Smoothly animate a number from 0 → value. */
export function AnimatedNumber({
  value,
  decimals = 0,
  suffix = "",
  prefix = "",
  className,
}: {
  value: number;
  decimals?: number;
  suffix?: string;
  prefix?: string;
  className?: string;
}) {
  const reduced = usePrefersReducedMotion();
  const mv = useMotionValue(0);
  const spring = useSpring(mv, { stiffness: 90, damping: 20 });
  const subscribe = useCallback((notify: () => void) => spring.on("change", notify), [spring]);
  const snapshot = useCallback(() => spring.get(), [spring]);
  const animated = useSyncExternalStore(subscribe, snapshot, () => 0);
  const display = (reduced ? value : animated).toFixed(decimals);

  useEffect(() => {
    if (!reduced) mv.set(value);
  }, [value, mv, reduced]);

  return (
    <span className={className}>
      {prefix}
      {display}
      {suffix}
    </span>
  );
}

// `TiltCard` — a pointer-follow 3D tilt + lift wrapper — used to live here and was
// never mounted. It respected `usePrefersReducedMotion`, so it was not deleted for
// being hostile; it was deleted because nothing in the app tilts, and a ready-made
// tilt sitting in the shared motion module is a standing suggestion to start.

export { motion };
