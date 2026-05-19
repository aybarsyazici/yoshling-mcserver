"use client";

import { useState } from "react";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function RoadhogDrawer() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <div className="sticky top-0 z-30 flex justify-center py-2 bg-background/80 backdrop-blur-sm border-b border-border/30">
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setOpen(!open)}
          className="text-xs text-muted-foreground hover:text-primary gap-1.5"
        >
          <span className={cn("transition-transform inline-block", open && "rotate-180")}>
            &#9660;
          </span>
          {open ? "Hide" : "?"}
        </Button>
      </div>

      <div
        className={cn(
          "overflow-hidden transition-all duration-500 ease-in-out border-b border-border/30",
          open ? "max-h-[500px] opacity-100" : "max-h-0 opacity-0"
        )}
      >
        <div className="flex flex-col items-center py-6 gap-3 bg-card/50">
          <Image
            src="/roadhog.gif"
            alt="roadhog"
            width={300}
            height={300}
            className="rounded-xl"
            unoptimized
          />
        </div>
      </div>
    </>
  );
}
