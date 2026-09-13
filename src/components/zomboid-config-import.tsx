"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Upload, FileUp } from "lucide-react";

interface ImportPreview {
  serverName: string;
  hadConfig: boolean;
  totalKeys: number;
  changed: { name: string; from: string; to: string }[];
  added: string[];
  dropped: string[];
  preserved: { name: string; value: string }[];
  mods: { workshopIds: string[]; modIds: string[] };
}

/**
 * Import a server .ini from a Project Zomboid server you already had. Settings
 * and mods come across; this box's RCON password and ports don't, or the app
 * would lose control of the server. Shows what will change before writing.
 */
export function ZomboidConfigImport({ tint }: { tint: string }) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [content, setContent] = useState<string | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [busy, setBusy] = useState(false);

  function reset() {
    setFileName(null);
    setContent(null);
    setPreview(null);
    if (fileRef.current) fileRef.current.value = "";
  }

  async function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setBusy(true);
    try {
      const text = await file.text();
      const res = await fetch("/api/zomboid/config/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content: text }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Couldn't read that file");
        reset();
        return;
      }
      setFileName(file.name);
      setContent(text);
      setPreview(data);
    } catch {
      toast.error("Couldn't read that file");
      reset();
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!content) return;
    setBusy(true);
    try {
      const res = await fetch("/api/zomboid/config/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content, apply: true }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || "Import failed");
        return;
      }
      toast.success(
        `Imported ${data.changed} changed setting${data.changed === 1 ? "" : "s"}` +
          (data.mods > 0 ? ` and ${data.mods} mod${data.mods === 1 ? "" : "s"}` : "") +
          ". Restart Project Zomboid to apply.",
      );
      // The whole config changed underneath the other cards, so reload rather
      // than leave them showing the old values.
      setTimeout(() => window.location.reload(), 900);
    } catch {
      toast.error("Import failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl bg-card/70 p-5 ring-1 ring-foreground/10 backdrop-blur" style={{ ["--tint" as string]: tint }}>
      <div className="flex items-start gap-2.5">
        <span
          className="grid h-9 w-9 flex-shrink-0 place-items-center rounded-lg"
          style={{ background: `color-mix(in oklab, ${tint} 14%, transparent)`, color: tint }}
        >
          <FileUp className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-display text-base font-semibold">Import a server config</p>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Moving a server you already ran? Upload its{" "}
            <span className="font-mono text-xs text-foreground">servertest.ini</span> to bring the
            settings and the whole mod list across in one go. The RCON password and ports stay as
            they are here, so the dashboard keeps control.
          </p>
        </div>
      </div>

      <input
        ref={fileRef}
        type="file"
        accept=".ini,text/plain"
        onChange={pick}
        className="hidden"
        aria-hidden
      />

      {!preview ? (
        <Button
          variant="outline"
          className="mt-4"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          <Upload className="h-4 w-4" /> {busy ? "Reading…" : "Choose .ini file"}
        </Button>
      ) : (
        <div className="mt-4 space-y-3 rounded-xl bg-background/50 p-4 ring-1 ring-foreground/10">
          <p className="font-mono text-xs text-muted-foreground">{fileName}</p>

          <dl className="grid gap-3 sm:grid-cols-3">
            <Figure
              value={preview.changed.length}
              label={`setting${preview.changed.length === 1 ? "" : "s"} change`}
              tint={tint}
            />
            <Figure
              value={preview.mods.workshopIds.length}
              label={`Workshop mod${preview.mods.workshopIds.length === 1 ? "" : "s"} in this file`}
              tint={tint}
            />
            <Figure
              value={preview.added.length + preview.dropped.length}
              label={`key${preview.added.length + preview.dropped.length === 1 ? "" : "s"} added or dropped`}
              tint={tint}
            />
          </dl>

          {preview.mods.modIds.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground">loads</span>
              {preview.mods.modIds.slice(0, 12).map((id) => (
                <span
                  key={id}
                  className="rounded-md px-2 py-0.5 font-mono text-[11px]"
                  style={{ background: `color-mix(in oklab, ${tint} 16%, transparent)`, color: tint }}
                >
                  {id}
                </span>
              ))}
              {preview.mods.modIds.length > 12 && (
                <span className="text-[11px] text-muted-foreground">
                  +{preview.mods.modIds.length - 12} more
                </span>
              )}
            </div>
          )}

          {preview.preserved.length > 0 && (
            <p className="text-xs text-muted-foreground">
              Kept at this server&rsquo;s values:{" "}
              <span className="font-mono text-[11px]">
                {preview.preserved.map((p) => p.name).join(", ")}
              </span>
            </p>
          )}

          {preview.dropped.length > 0 && (
            <p className="text-xs text-muted-foreground">
              {preview.dropped.length} setting{preview.dropped.length === 1 ? "" : "s"} in the
              current config {preview.dropped.length === 1 ? "isn't" : "aren't"} in this file. The
              game fills those back in with its defaults on the next start.
            </p>
          )}

          {preview.changed.length + preview.added.length + preview.dropped.length === 0 &&
            preview.hadConfig && (
              <p className="text-xs text-muted-foreground">
                This file matches the current config, so importing it changes nothing.
              </p>
            )}

          {!preview.hadConfig && (
            <p className="text-xs text-muted-foreground">
              There&rsquo;s no config on this server yet, so this file becomes it.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-2 border-t border-border/50 pt-3">
            <Button
              onClick={apply}
              disabled={busy}
              style={{ background: tint, color: "var(--background)" }}
            >
              {busy ? "Importing…" : "Import settings"}
            </Button>
            <Button variant="outline" onClick={reset} disabled={busy}>
              Cancel
            </Button>
            <p className="text-xs text-muted-foreground">
              The current config is backed up next to it first.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

function Figure({ value, label, tint }: { value: number; label: string; tint: string }) {
  return (
    <div>
      <dt className="font-display text-2xl font-bold" style={{ color: tint }}>
        {value}
      </dt>
      <dd className="text-xs text-muted-foreground">{label}</dd>
    </div>
  );
}
