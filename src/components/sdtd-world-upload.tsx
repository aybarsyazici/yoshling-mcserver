"use client";

import { useEffect, useRef, useState } from "react";
import { motion, AnimatePresence } from "motion/react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/format";
import { MAX_WORLD_UPLOAD_BYTES, MAX_WORLD_UPLOAD_LABEL } from "@/lib/sdtd-upload-limits";
import { Button } from "@/components/ui/button";
import { UploadCloud, Globe, Loader2, CheckCircle2, Trash2 } from "lucide-react";

export function SdtdWorldUpload({ tint }: { tint: string }) {
  const [worlds, setWorlds] = useState<string[]>([]);
  const [deleting, setDeleting] = useState<string | null>(null);
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

  async function deleteWorld(name: string) {
    if (!confirm(`Delete the custom world "${name}"? This removes the map and its saves. This cannot be undone.`)) return;
    setDeleting(name);
    try {
      const res = await fetch(`/api/7dtd/world?name=${encodeURIComponent(name)}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        toast.success(`Deleted "${name}"`);
        setWorlds((w) => w.filter((x) => x !== name));
      } else {
        // 409 = protected (active world or referenced by a backup)
        toast.error(data.error || "Couldn't delete world");
      }
    } catch {
      toast.error("Couldn't delete world");
    } finally {
      setDeleting(null);
    }
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
    // Refuse here, not after the transfer. The server's cap is the same constant, so the
    // only thing uploading an oversized file achieved was spending the whole upload time
    // to be told no — over a home connection, that is tens of minutes. The cap is also
    // Caddy's real ceiling on the direct host (see `sdtd-upload-limits.ts`), so anything
    // above it could not arrive even if the route allowed it.
    if (f.size > MAX_WORLD_UPLOAD_BYTES) {
      toast.error(
        `That file is ${formatBytes(f.size)} — the limit is ${MAX_WORLD_UPLOAD_LABEL}. Upload the world on its own, without the Saves folder.`
      );
      return;
    }
    setFile(f);
  }

  async function upload() {
    if (!file || uploading) return;
    setUploading(true);
    setProgress(0);

    // Large worlds exceed Cloudflare's 100MB request cap, so uploads go to the
    // direct (non-Cloudflare) host when configured. That host doesn't get our
    // session cookie, so mint a short-lived signed token first and send it as a
    // header. Falls back to the same-origin path if no direct host is set.
    let target = "/api/7dtd/world";
    let token = "";
    try {
      const t = await fetch("/api/7dtd/world/token");
      if (t.ok) {
        const td = await t.json();
        token = td.token || "";
        if (td.directHost) target = `${td.directHost}/api/7dtd/world`;
      }
    } catch {
      /* fall back to same-origin */
    }

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
        // No toast. `xhr.onload` resolves only after the whole server-side operation has
        // finished and returned, so the old comment here ("the transfer is the only half
        // this client can see") was simply wrong — and a green `toast.success` fired
        // beside the operation's amber "Uploaded and placed Reveo Valley… Also, it
        // replaced an existing copy of the same name." Two different severities for one
        // event, with the wrong one coloured reassuringly. The operation's summary is the
        // only text that cannot overstate, so it is the single voice.
        setFile(null);
        setProgress(0);
        loadWorlds();
      } else if (xhr.status === 409 && data.error) {
        toast.error(data.error);
      } else if (xhr.status === 413) {
        // Two very different 413s reach here and the old code gave both the same
        // explanation. Ours carries a JSON `error`; Cloudflare's (100 MB) and Caddy's
        // (2 GB) are HTML pages with none, and *those* are the ones that mean the
        // request never reached the app.
        toast.error(
          data.error ||
            `The upload was rejected before it reached the server — it is over ${MAX_WORLD_UPLOAD_LABEL}, or the direct-upload host is not configured and Cloudflare's 100 MB cap applied.`
        );
      } else {
        toast.error(data.error || `Upload failed (HTTP ${xhr.status})`);
      }
    };
    xhr.onerror = () => {
      setUploading(false);
      toast.error("Upload failed — network error");
    };
    xhr.open("POST", target);
    xhr.withCredentials = true;
    if (token) xhr.setRequestHeader("X-Upload-Token", token);
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
        {/* The size below uses `formatBytes`, not a local `/1048576 … "MB"`: that divided
            by 1024² and labelled the result MB, so this readout disagreed with the same
            file's size everywhere else in the app by ~5%. One formatter, one unit. */}
        {file ? (
          <span className="font-mono text-sm">{file.name} <span className="text-muted-foreground">({formatBytes(file.size)})</span></span>
        ) : (
          <>
            <span className="text-sm font-medium">Drop a .zip here or click to browse</span>
            <span className="text-xs text-muted-foreground">
              A world zip has files like dtm.raw / biomes.png / prefabs.xml — up to {MAX_WORLD_UPLOAD_LABEL}
            </span>
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
              <span key={w} className="group inline-flex items-center gap-1.5 rounded-lg py-1.5 pl-2.5 pr-1.5 font-mono text-xs" style={{ background: `color-mix(in oklab, ${tint} 12%, transparent)`, color: tint }}>
                <CheckCircle2 className="h-3.5 w-3.5" /> {w}
                <button
                  onClick={() => deleteWorld(w)}
                  disabled={deleting === w}
                  title={`Delete "${w}"`}
                  className="ml-1 grid h-5 w-5 place-items-center rounded text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive disabled:opacity-50"
                >
                  {deleting === w ? <Loader2 className="h-3 w-3 animate-spin" /> : <Trash2 className="h-3 w-3" />}
                </button>
              </span>
            ))}
          </div>
          <p className="mt-2 text-[11px] text-muted-foreground">
            To play on one: set <span className="font-mono">Game World</span> to its name in All settings, then start a fresh game. Restart 7DTD to apply.
            Worlds in use by the server or a backup can&rsquo;t be deleted.
          </p>
        </div>
      )}
    </div>
  );
}
