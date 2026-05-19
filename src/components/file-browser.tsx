"use client";

import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { toast } from "sonner";

interface FileEntry {
  name: string;
  isDirectory: boolean;
  size: number;
  path: string;
}

export function FileBrowser() {
  const [items, setItems] = useState<FileEntry[]>([]);
  const [currentPath, setCurrentPath] = useState("");
  const [loading, setLoading] = useState(true);
  const [fileContent, setFileContent] = useState<string | null>(null);
  const [viewingFile, setViewingFile] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [editContent, setEditContent] = useState("");
  const [saving, setSaving] = useState(false);

  async function navigate(dirPath: string) {
    setLoading(true);
    setFileContent(null);
    setViewingFile(null);
    setEditing(false);
    try {
      const res = await fetch(`/api/server/files?path=${encodeURIComponent(dirPath)}`);
      const data = await res.json();
      if (data.items) {
        setItems(data.items);
        setCurrentPath(dirPath);
      }
    } catch {}
    setLoading(false);
  }

  async function viewFile(filePath: string) {
    try {
      const res = await fetch(
        `/api/server/files?path=${encodeURIComponent(filePath)}&action=read`
      );
      const data = await res.json();
      if (data.content !== undefined) {
        setFileContent(data.content);
        setEditContent(data.content);
        setViewingFile(filePath);
      } else if (data.error) {
        setFileContent(`Error: ${data.error}`);
        setViewingFile(filePath);
      }
    } catch {
      setFileContent("Failed to read file");
      setViewingFile(filePath);
    }
  }

  async function saveFile() {
    if (!viewingFile) return;
    setSaving(true);
    try {
      const res = await fetch("/api/server/files", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ path: viewingFile, content: editContent }),
      });
      if (res.ok) {
        setFileContent(editContent);
        setEditing(false);
        toast.success("File saved. Restart server if needed.");
      } else {
        const data = await res.json();
        toast.error(data.error || "Failed to save");
      }
    } catch {
      toast.error("Failed to save file");
    } finally {
      setSaving(false);
    }
  }

  async function deleteItem(item: FileEntry) {
    const what = item.isDirectory ? "folder" : "file";
    if (!confirm(`Delete ${what} "${item.name}"? This cannot be undone.`)) return;

    const res = await fetch(
      `/api/server/files?path=${encodeURIComponent(item.path)}`,
      { method: "DELETE" }
    );
    if (res.ok) {
      setItems((prev) => prev.filter((i) => i.path !== item.path));
      toast.success(`Deleted ${item.name}`);
    } else {
      const data = await res.json();
      toast.error(data.error || "Failed to delete");
    }
  }

  useEffect(() => {
    navigate("");
  }, []);

  function goUp() {
    const parts = currentPath.split("/").filter(Boolean);
    parts.pop();
    navigate(parts.join("/"));
  }

  const breadcrumbs = currentPath.split("/").filter(Boolean);
  const isEditable = viewingFile
    ? /\.(properties|json|yml|yaml|toml|txt|cfg|conf|ini|log|csv|md)$/i.test(viewingFile)
    : false;

  return (
    <Card className="border-border/50 shadow-sm">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle>File Browser</CardTitle>
          <div className="flex gap-2">
            {viewingFile && !editing && isEditable && (
              <Button size="sm" onClick={() => setEditing(true)}>
                Edit
              </Button>
            )}
            {editing && (
              <>
                <Button size="sm" variant="outline" onClick={() => { setEditing(false); setEditContent(fileContent || ""); }}>
                  Cancel
                </Button>
                <Button size="sm" onClick={saveFile} disabled={saving}>
                  {saving ? "Saving..." : "Save"}
                </Button>
              </>
            )}
            {viewingFile && (
              <Button size="sm" variant="outline" onClick={() => { setFileContent(null); setViewingFile(null); setEditing(false); }}>
                Back
              </Button>
            )}
          </div>
        </div>
        <div className="flex items-center gap-1 text-sm text-muted-foreground mt-2 flex-wrap">
          <button
            onClick={() => navigate("")}
            className="hover:text-foreground transition-colors font-mono"
          >
            /server
          </button>
          {breadcrumbs.map((part, i) => (
            <span key={i} className="flex items-center gap-1">
              <span className="text-border">/</span>
              <button
                onClick={() => navigate(breadcrumbs.slice(0, i + 1).join("/"))}
                className="hover:text-foreground transition-colors font-mono"
              >
                {part}
              </button>
            </span>
          ))}
          {viewingFile && (
            <span className="text-foreground font-mono">
              <span className="text-border">/</span>
              {viewingFile.split("/").pop()}
            </span>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {viewingFile && fileContent !== null ? (
          editing ? (
            <textarea
              value={editContent}
              onChange={(e) => setEditContent(e.target.value)}
              className="w-full h-[500px] rounded-lg bg-[#11111b] p-4 font-mono text-xs text-[#cdd6f4] border border-border/50 resize-none focus:outline-none focus:ring-2 focus:ring-primary/50"
              spellCheck={false}
            />
          ) : (
            <div className="h-[500px] overflow-y-auto rounded-lg bg-[#11111b] p-4 font-mono text-xs text-[#cdd6f4] border border-border/50">
              <pre className="whitespace-pre-wrap break-all">{fileContent}</pre>
            </div>
          )
        ) : loading ? (
          <div className="space-y-2">
            {Array.from({ length: 5 }).map((_, i) => (
              <div key={i} className="h-10 bg-muted animate-pulse rounded" />
            ))}
          </div>
        ) : (
          <div className="space-y-0.5">
            {currentPath && (
              <button
                onClick={goUp}
                className="w-full flex items-center gap-3 px-3 py-2.5 rounded-lg hover:bg-muted text-sm text-muted-foreground transition-colors"
              >
                <FolderUpIcon className="h-4 w-4" />
                ..
              </button>
            )}
            {items.map((item) => (
              <div
                key={item.path}
                className="flex items-center justify-between px-3 py-2.5 rounded-lg hover:bg-muted transition-colors group"
              >
                <button
                  onClick={() =>
                    item.isDirectory ? navigate(item.path) : viewFile(item.path)
                  }
                  className="flex items-center gap-3 flex-1 text-sm text-left"
                >
                  {item.isDirectory ? (
                    <FolderIcon className="h-4 w-4 text-chart-5" />
                  ) : (
                    <FileIcon className="h-4 w-4 text-muted-foreground" />
                  )}
                  <span>{item.name}</span>
                </button>
                <div className="flex items-center gap-3">
                  {!item.isDirectory && (
                    <span className="text-xs text-muted-foreground">
                      {formatSize(item.size)}
                    </span>
                  )}
                  <button
                    onClick={() => deleteItem(item)}
                    className="opacity-0 group-hover:opacity-100 text-xs text-destructive hover:text-destructive/80 transition-all"
                    title="Delete"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
            {items.length === 0 && (
              <p className="text-sm text-muted-foreground text-center py-8">
                Empty directory
              </p>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function formatSize(bytes: number): string {
  if (bytes === 0) return "0 B";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function FolderIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75m-8.69-6.44-2.12-2.12a1.5 1.5 0 0 0-1.061-.44H4.5A2.25 2.25 0 0 0 2.25 6v12a2.25 2.25 0 0 0 2.25 2.25h15A2.25 2.25 0 0 0 21.75 18V9a2.25 2.25 0 0 0-2.25-2.25h-5.379a1.5 1.5 0 0 1-1.06-.44Z" />
    </svg>
  );
}

function FolderUpIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="m9 9 3-3m0 0 3 3m-3-3v12M2.25 12.75V12A2.25 2.25 0 0 1 4.5 9.75h15A2.25 2.25 0 0 1 21.75 12v.75" />
    </svg>
  );
}

function FileIcon({ className }: { className?: string }) {
  return (
    <svg className={className} fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor">
      <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 14.25v-2.625a3.375 3.375 0 0 0-3.375-3.375h-1.5A1.125 1.125 0 0 1 13.5 7.125v-1.5a3.375 3.375 0 0 0-3.375-3.375H8.25m2.25 0H5.625c-.621 0-1.125.504-1.125 1.125v17.25c0 .621.504 1.125 1.125 1.125h12.75c.621 0 1.125-.504 1.125-1.125V11.25a9 9 0 0 0-9-9Z" />
    </svg>
  );
}
