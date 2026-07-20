"use client";

import { motion, useMotionValue, useSpring, useTransform, type Variants } from "motion/react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/* Respect reduced-motion at the JS layer too. */
export function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
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
  const [display, setDisplay] = useState("0");

  useEffect(() => {
    if (reduced) {
      setDisplay(value.toFixed(decimals));
      return;
    }
    mv.set(value);
    const unsub = spring.on("change", (v) => setDisplay(v.toFixed(decimals)));
    return () => unsub();
  }, [value, decimals, mv, spring, reduced]);

  return (
    <span className={className}>
      {prefix}
      {display}
      {suffix}
    </span>
  );
}

/** Card wrapper with a subtle pointer-follow tilt + lift. */
export function TiltCard({
  children,
  className,
  intensity = 6,
  style,
}: {
  children: ReactNode;
  className?: string;
  intensity?: number;
  style?: React.CSSProperties;
}) {
  const reduced = usePrefersReducedMotion();
  const ref = useRef<HTMLDivElement>(null);
  const px = useMotionValue(0.5);
  const py = useMotionValue(0.5);
  const rx = useSpring(useTransform(py, [0, 1], [intensity, -intensity]), { stiffness: 150, damping: 18 });
  const ry = useSpring(useTransform(px, [0, 1], [-intensity, intensity]), { stiffness: 150, damping: 18 });

  function onMove(e: React.MouseEvent) {
    if (reduced || !ref.current) return;
    const r = ref.current.getBoundingClientRect();
    px.set((e.clientX - r.left) / r.width);
    py.set((e.clientY - r.top) / r.height);
  }
  function onLeave() {
    px.set(0.5);
    py.set(0.5);
  }

  return (
    <motion.div
      ref={ref}
      onMouseMove={onMove}
      onMouseLeave={onLeave}
      style={{ rotateX: reduced ? 0 : rx, rotateY: reduced ? 0 : ry, transformPerspective: 900, ...style }}
      whileHover={reduced ? undefined : { y: -4 }}
      transition={{ type: "spring", stiffness: 300, damping: 25 }}
      className={cn("will-change-transform", className)}
    >
      {children}
    </motion.div>
  );
}

export { motion };
