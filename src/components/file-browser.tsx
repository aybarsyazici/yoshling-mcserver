"use client";

import { fileRevision, revisionHeaders } from "@/lib/file-revision-client";

import { useGames, CAPABILITY_POLL_MS } from "@/lib/use-games";
import { useState, useEffect, useCallback, useRef } from "react";
import { motion } from "motion/react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import { formatBytes } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Folder, FileText, CornerLeftUp, ChevronRight, Pencil, Trash2, X } from "lucide-react";

interface FileEntry {
  name: string;
  isDirectory: boolean;
  size: number;
  path: string;
}

export interface FileRoot {
  key: string;
  label: string;
}

/**
 * File browser for a game's server files. Minecraft uses the default
 * `/api/server/files`; 7DTD passes `/api/7dtd/files` plus `roots` (Config /
 * Saves) which are sent as the `root` query/body param.
 */
export function FileBrowser({
  endpoint = "/api/server/files",
  roots,
  rootLabel = "server",
  tint = "var(--primary)",
}: {
  endpoint?: string;
  roots?: FileRoot[];
  rootLabel?: string;
  tint?: string;
} = {}) {
  const { can } = useGames(CAPABILITY_POLL_MS);
  const [root, setRoot] = useState(roots?.[0]?.key ?? "");
  const [items, setItems] = useState<FileEntry[]>([]);
  const [currentPath, setCurrentPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [viewingFile, setViewingFile] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [writeError, setWriteError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  // Whether what's on screen is really the file, or a message about why it
  // couldn't be read. Saving is only allowed in the first case — see viewFile.
  const [readOk, setReadOk] = useState(false);
  const [fileIdentity, setFileIdentity] = useState<{ endpoint: string; root: string; path: string; revision: string | null } | null>(null);
  const requestGeneration = useRef(0);
  const invalidateRequests = useCallback(() => { requestGeneration.current++; }, []);

  const rootQuery = root ? `&root=${encodeURIComponent(root)}` : "";

  const navigate = useCallback(
    async (dirPath: string) => {
      const generation = ++requestGeneration.current;
      setLoading(true);
      setItems([]);
      setFileIdentity(null); setWriteError(null);
      setFileContent(null);
      setViewingFile(null);
      setEditing(false);
      setEditContent("");
      setReadOk(false);
      try {
        const res = await fetch(`${endpoint}?path=${encodeURIComponent(dirPath)}${rootQuery}`);
        const data = await res.json();
        if (generation !== requestGeneration.current) return;
        if (res.ok && Array.isArray(data.items)) {
          setItems(data.items);
          setCurrentPath(dirPath);
        } else if (data.error) {
          toast.error(data.error);
        }
      } catch {
        if (generation !== requestGeneration.current) return;
        toast.error("Failed to load directory");
      }
      if (generation === requestGeneration.current) setLoading(false);
    },
    [endpoint, rootQuery]
  );

  /**
   * Every branch sets `editContent` and `readOk`, and neither is optional.
   * When a read failed we used to leave `editContent` holding the *previous*
   * file's text while still offering Edit (which only looked at the extension) —
   * so opening a 3.7 MB `blocks.xml`, getting "File too large", then Edit + Save
   * wrote the last file's contents over it. Cancel was worse: it loaded the
   * literal "Error: …" string into the buffer.
   */
  async function viewFile(filePath: string) {
    const generation = ++requestGeneration.current;
    const identity = { endpoint, root, path: filePath, revision: null as string | null };
    let content: string;
    let ok = false;
    try {
      const res = await fetch(`${endpoint}?path=${encodeURIComponent(filePath)}&action=read${rootQuery}`);
      const data = await res.json();
      if (res.ok && typeof data.content === "string") {
        content = data.content;
        ok = true; identity.revision = fileRevision(res);
      } else {
        content = `Error: ${data.error || "Failed to read file"}`;
      }
    } catch {
      content = "Failed to read file";
    }
    // All four together, from this call's `filePath`, so the save buffer can never
    // belong to a different file than the one named in `viewingFile`.
    if (generation !== requestGeneration.current) return;
    setFileIdentity(identity); setWriteError(null); setEditing(false);
    setViewingFile(filePath);
    setFileContent(content);
    setEditContent(ok ? content : "");
    setReadOk(ok);
  }

  async function saveFile() {
    // readOk, not just viewingFile: never write a buffer that isn't this file's.
    if (!can.settingsEdit || !fileIdentity || !readOk || saving) return;
    setSaving(true);
    try {
      const identity = fileIdentity;
      const generation = requestGeneration.current;
      const content = editContent;
      const res = await fetch(identity.endpoint, {
        method: "PUT",
        headers: { "Content-Type": "application/json", ...revisionHeaders(identity.revision) },
        body: JSON.stringify({ path: identity.path, content, root: identity.root || undefined }),
      });
      if (generation !== requestGeneration.current) return;
      if (res.ok) {
        setFileIdentity({ ...identity, revision: fileRevision(res) ?? identity.revision });
        setFileContent(content);
        setEditing(false);
        toast.success("File saved. Restart the server to apply if needed.");
      } else {
        const data = await res.json();
        if (data.stale) { setWriteError(data.error); setReadOk(false); }
        toast.error(data.error || "Failed to save");
      }
    } catch {
      setWriteError("The save result is unconfirmed. Reload this file before retrying."); setReadOk(false);
      toast.info("The file save result is unconfirmed. Reload this file before retrying.");
    } finally {
      setSaving(false);
    }
  }

  async function deleteItem(item: FileEntry) {
    if (!can.filesDelete) return;
    const what = item.isDirectory ? "folder" : "file";
    if (!confirm(`Delete ${what} "${item.name}"? This cannot be undone.`)) return;
    const res = await fetch(`${endpoint}?path=${encodeURIComponent(item.path)}${rootQuery}`, {
      method: "DELETE",
    });
    if (res.ok) {
      setItems((prev) => prev.filter((i) => i.path !== item.path));
      toast.success(`Deleted ${item.name}`);
    } else {
      const data = await res.json();
      toast.error(data.error || "Failed to delete");
    }
  }

  // reset to root when the selected root changes
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void navigate("");
    return invalidateRequests;
  }, [navigate, invalidateRequests]);

  function goUp() {
    const parts = currentPath.split("/").filter(Boolean);
    parts.pop();
    navigate(parts.join("/"));
  }

  const breadcrumbs = currentPath.split("/").filter(Boolean);
  // `lua` matters: Project Zomboid keeps its sandbox preset and spawn regions in
  // <name>_SandboxVars.lua and <name>_spawnregions.lua, and those are the only
  // place to change loot, XP or zombie settings — there is no .ini equivalent.
  // `readOk` as well as the extension: a file whose read failed is not editable,
  // because there is nothing correct to save back over it.
  const isEditable =
    viewingFile && readOk
      ? /\.(properties|json|yml|yaml|toml|txt|cfg|conf|ini|log|csv|md|xml|lua)$/i.test(viewingFile)
      : false;

  return (
    <div className="rounded-2xl bg-card/70 p-4 ring-1 ring-foreground/10 backdrop-blur" style={{ ["--tint" as string]: tint }}>
      {/* Root tabs (7DTD: Config / Saves) */}
      {roots && roots.length > 1 && (
        <div className="mb-3 inline-flex gap-1 rounded-xl bg-muted/60 p-1 ring-1 ring-foreground/10">
          {roots.map((r) => {
            const active = r.key === root;
            return (
              <button
                key={r.key}
                onClick={() => { requestGeneration.current++; setFileIdentity(null); setViewingFile(null); setEditing(false); setRoot(r.key); }}
                disabled={saving}
                className={cn(
                  "relative rounded-lg px-3.5 py-1.5 text-sm font-medium transition-colors",
                  active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
                )}
              >
                {active && (
                  <motion.span
                    layoutId="file-root"
                    className="absolute inset-0 rounded-lg"
                    style={{ background: `color-mix(in oklab, ${tint} 18%, var(--card))`, boxShadow: `inset 0 0 0 1px color-mix(in oklab, ${tint} 40%, transparent)` }}
                    transition={{ type: "spring", stiffness: 400, damping: 32 }}
                  />
                )}
                <span className="relative">{r.label}</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Toolbar: breadcrumbs + actions */}
      <div className="mb-3 flex items-center justify-between gap-3">
        <div className="flex flex-wrap items-center gap-1 text-sm text-muted-foreground">
          <button onClick={() => navigate("")} className="font-mono transition-colors hover:text-foreground" style={{ color: !currentPath && !viewingFile ? tint : undefined }}>
            /{roots?.find((r) => r.key === root)?.label.toLowerCase() ?? rootLabel}
          </button>
          {breadcrumbs.map((part, i) => (
            <span key={i} className="flex items-center gap-1">
              <ChevronRight className="h-3 w-3 text-border" />
              <button onClick={() => navigate(breadcrumbs.slice(0, i + 1).join("/"))} className="font-mono transition-colors hover:text-foreground">
                {part}
              </button>
            </span>
          ))}
          {viewingFile && (
            <span className="flex items-center gap-1 font-mono text-foreground">
              <ChevronRight className="h-3 w-3 text-border" />
              {viewingFile.split("/").pop()}
            </span>
          )}
        </div>
        <div className="flex flex-shrink-0 gap-2">
          {can.settingsEdit && viewingFile && !editing && isEditable && (
            <Button size="sm" onClick={() => setEditing(true)}>
              <Pencil className="h-3.5 w-3.5" /> Edit
            </Button>
          )}
          {editing && (
            <>
              <Button size="sm" variant="outline" onClick={() => { setEditing(false); setEditContent(fileContent || ""); }}>
                Cancel
              </Button>
              <Button size="sm" onClick={saveFile} disabled={saving || !readOk}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </>
          )}
          {viewingFile && (
            <Button size="sm" variant="outline" onClick={() => { requestGeneration.current++; setFileIdentity(null); setFileContent(null); setViewingFile(null); setEditing(false); setEditContent(""); setReadOk(false); }}>
              <X className="h-3.5 w-3.5" /> Close
            </Button>
          )}
        </div>
      </div>

      {writeError && <div role="alert"><p>{writeError}</p><Button onClick={() => fileIdentity && viewFile(fileIdentity.path)} disabled={saving}>Reload file</Button></div>}
      {/* Body */}
      {viewingFile && fileContent !== null ? (
        editing ? (
          <textarea
            value={editContent}
            onChange={(e) => setEditContent(e.target.value)}
            className="h-[520px] w-full resize-none rounded-xl border border-foreground/10 bg-[#0c0c14] p-4 font-mono text-xs text-[#cdd6f4] focus:outline-none focus:ring-2"
            style={{ ["--tw-ring-color" as string]: `color-mix(in oklab, ${tint} 50%, transparent)` }}
            spellCheck={false}
          />
        ) : (
          <div className="scanlines relative h-[520px] overflow-y-auto rounded-xl border border-foreground/10 bg-[#0c0c14] p-4 font-mono text-xs text-[#cdd6f4]">
            <pre className="relative whitespace-pre-wrap break-all">{fileContent}</pre>
          </div>
        )
      ) : loading ? (
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="skeleton h-10 rounded-lg" />
          ))}
        </div>
      ) : (
        <div className="space-y-0.5">
          {currentPath && (
            <button onClick={goUp} className="flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm text-muted-foreground transition-colors hover:bg-muted">
              <CornerLeftUp className="h-4 w-4" /> ..
            </button>
          )}
          {items.map((item) => (
            <div key={item.path} className="group flex items-center justify-between rounded-lg px-3 py-2.5 transition-colors hover:bg-muted">
              <button
                onClick={() => (item.isDirectory ? navigate(item.path) : viewFile(item.path))}
                className="flex flex-1 items-center gap-3 text-left text-sm"
              >
                {item.isDirectory ? (
                  <Folder className="h-4 w-4 flex-shrink-0" style={{ color: tint }} />
                ) : (
                  <FileText className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
                )}
                <span className="truncate">{item.name}</span>
              </button>
              <div className="flex flex-shrink-0 items-center gap-3">
                {!item.isDirectory && <span className="font-mono text-xs text-muted-foreground">{formatSize(item.size)}</span>}
                {can.filesDelete && <button
                  onClick={() => deleteItem(item)}
                  className="text-muted-foreground opacity-0 transition-all hover:text-destructive group-hover:opacity-100"
                  title="Delete"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>}
              </div>
            </div>
          ))}
          {items.length === 0 && <p className="py-10 text-center text-sm text-muted-foreground">Empty directory</p>}
        </div>
      )}
    </div>
  );
}

/**
 * One formatter for every byte count in the app.
 *
 * This was a local copy that divided by 1024 and labelled the result "KB/MB/GB" — the
 * exact bug `format.ts`'s docstring records fixing, still live here. The consequence was
 * that the same archive read "165 MiB" on the backups page and "165.3 MB" in the file
 * browser, so the two views of one file disagreed by ~5% and neither was obviously wrong.
 * `format.ts` stays binary on purpose (`du -h` on the box agrees); what the copy got
 * wrong was the label, not the arithmetic.
 */
const formatSize = formatBytes;
