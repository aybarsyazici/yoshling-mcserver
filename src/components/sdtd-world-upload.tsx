"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { UploadCloud, Globe, Loader2, CheckCircle2 } from "lucide-react";

export function SdtdWorldUpload({ tint }: { tint: string }) {
  const [worlds, setWorlds] = useState<string[]>([]);
  const [dragging, setDragging] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [progress, setProgress] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  async function loadWorlds() {
    try {
      const res = await fetch("/api/7dtd/world");
      const data = await res.json();
      if (Array.isArray(data.worlds)) setWorlds(data.worlds);
    } catch {}
  }

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    loadWorlds();
  }, []);

  function pick(f: File | null) {
    if (!f) return;
    if (!f.name.toLowerCase().endsWith(".zip")) {
      toast.error("Please choose a .zip file");
      return;
    }
    setFile(f);
  }

  function upload() {
    if (!file || uploading) return;
    setUploading(true);
    setProgress(0);

    // Use XHR for real upload progress (fetch has no upload progress events).
    const xhr = new XMLHttpRequest();
    const form = new FormData();
    form.append("file", file);

    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) setProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      setUploading(false);
      let data: { success?: boolean; hint?: string; error?: string; name?: string } = {};
      try { data = JSON.parse(xhr.responseText); } catch {}
      if (xhr.status >= 200 && xhr.status < 300 && data.success) {
        toast.success(data.hint || `Uploaded ${data.name}`);
        setFile(null);
        setProgress(0);
        loadWorlds();
      } else {
        toast.error(data.error || `Upload failed (HTTP ${xhr.status})`);
      }
    };
    xhr.onerror = () => {
      setUploading(false);
      toast.error("Upload failed — network error");
    };
    xhr.open("POST", "/api/7dtd/world");
    xhr.send(form);
  }

  return (
    <div className="rounded-2xl bg-card/70 p-5 ring-1 ring-foreground/10 backdrop-blur" style={{ ["--tint" as string]: tint }}>
      <div className="mb-1 flex items-center gap-2.5">
        <span className="grid h-9 w-9 place-items-center rounded-lg" style={{ background: `color-mix(in oklab, ${tint} 14%, transparent)`, color: tint }}>
          <Globe className="h-4 w-4" />
        </span>
        <div>
          <p className="font-display text-base font-semibold">Upload a world</p>
          <p className="text-xs text-muted-foreground">Add a custom map (e.g. a friend&rsquo;s generated world) as a .zip.</p>
        </div>
      </div>

      {/* Drop zone */}
      <label
        onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => { e.preventDefault(); setDragging(false); pick(e.dataTransfer.files?.[0] ?? null); }}
        className={cn(
          "mt-4 flex cursor-pointer flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-8 text-center transition-colors",
          dragging ? "bg-[color-mix(in_oklab,var(--tint)_10%,transparent)]" : "hover:bg-muted/40"
        )}
        style={{ borderColor: dragging ? tint : "color-mix(in oklab, var(--foreground) 15%, transparent)" }}
      >
        <input
          ref={inputRef}
          type="file"
          accept=".zip"
          className="hidden"
          onChange={(e) => pick(e.target.files?.[0] ?? null)}
        />
        <UploadCloud className="h-7 w-7" style={{ color: tint }} />
        {file ? (
          <span className="font-mono text-sm">{file.name} <span className="text-muted-foreground">({(file.size / 1048576).toFixed(1)} MB)</span></span>
        ) : (
          <>
            <span className="text-sm font-medium">Drop a .zip here or click to browse</span>
            <span className="text-xs text-muted-foreground">A world zip has files like dtm.raw / biomes.png / prefabs.xml</span>
          </>
        )}
      </label>

      {/* Progress + action */}
      <div className="mt-4 flex items-center gap-3">
        <Button onClick={upload} disabled={!file || uploading} style={{ background: tint, color: "var(--background)" }}>
          {uploading ? <><Loader2 className="h-4 w-4 animate-spin" /> Uploading… {progress}%</> : "Upload world"}
        </Button>
        {file && !uploading && (
          <button onClick={() => setFile(null)} className="text-xs text-muted-foreground hover:text-foreground">
            Clear
          </button>
        )}
      </div>
      <AnimatePresence>
        {uploading && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            className="mt-3 h-2 overflow-hidden rounded-full bg-muted"
          >
            <motion.div className="h-full rounded-full" style={{ background: tint }} animate={{ width: `${progress}%` }} />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Installed worlds */}
      {worlds.length > 0 && (
        <div className="mt-5 border-t border-border/50 pt-4">
          <p className="eyebrow mb-2 text-muted-foreground">Installed custom worlds</p>
          <div className="flex flex-wrap gap-2">
            {worlds.map((w) => (
              <span key={w} className="inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 font-mono text-xs" style={{ background: `color-mix(in oklab, ${tint} 12%, transparent)`, color: tint }}>
                <CheckCircle2 className="h-3.5 w-3.5" /> {w}
              </span>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            To play on one: set <span className="font-mono">Game World</span> to its name in All settings, then start a fresh game. Restart 7DTD to apply.
          </p>
        </div>
      )}
    </div>
  );
}
