#!/usr/bin/env python3
"""
Which Project Zomboid Workshop mods are out of date on the server.

Runs ON the box (it reads the docker volumes directly):
    ssh -i ~/.ssh/mc_yoshling_netcup root@89.58.50.155 'python3 -' \
        < scripts/pz-stale-mods.py

A stale mod has no server-side symptom at all: the version check is client-side,
so the server logs nothing and simply stops accepting anyone who logs off. This is
the only way to see it before a player reports it.

## The trap this encodes

`appworkshop_108600.acf` contains TWO sections keyed by workshop id —
`WorkshopItemsInstalled` (what is on disk) and `WorkshopItemDetails` (what Steam
knows, including `latest_timeupdated`) — and *both* carry a `timeupdated`. Reading
from the first section to end-of-file lets the second one's values win, which makes
installed == published for every mod and the check a no-op that always answers
"nothing to do". It reported "0 stale" on a server that demonstrably had a stale
mod, which is a bug agreeing with itself. Hence the brace-matched section reader
below; do not replace it with a slice.
"""

import json
import os
import re
import sys
import time
import urllib.request

INI = os.environ.get(
    "PZ_INI", "/var/lib/docker/volumes/yoshling_pz-data/_data/Server/yoshling.ini"
)
ACF = os.environ.get(
    "PZ_ACF",
    "/var/lib/docker/volumes/yoshling_pz-workshop/_data/appworkshop_108600.acf",
)
STEAM_API = "https://api.steampowered.com/ISteamRemoteStorage/GetPublishedFileDetails/v1/"


def kv_section(text: str, name: str):
    """
    The body of a named Valve-KeyValues block, bounded by matching braces.

    Bounded on purpose — see the module docstring. A slice-to-EOF silently breaks
    the whole comparison.
    """
    key = f'"{name}"'
    at = text.find(key)
    if at < 0:
        return None
    open_at = text.find("{", at + len(key))
    if open_at < 0:
        return None
    depth = 0
    for i in range(open_at, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[open_at + 1 : i]
    return None


def per_item(section: str, field: str):
    """{workshop_id: int(field)} from a section of per-item blocks."""
    out = {}
    for item_id, block in re.findall(r'"(\d{6,})"\s*\{([^}]*)\}', section or ""):
        m = re.search(rf'"{field}"\s*"(\d+)"', block)
        if m:
            out[item_id] = int(m.group(1))
    return out


def workshop_ids() -> list:
    text = open(INI, encoding="utf8", errors="replace").read()
    m = re.search(r"^WorkshopItems=(.*)$", text, re.M)
    if not m:
        return []
    seen, ids = set(), []
    for raw in m.group(1).split(";"):
        raw = raw.strip()
        if re.fullmatch(r"\d{6,}", raw) and raw not in seen:
            seen.add(raw)
            ids.append(raw)
    return ids


def published(ids: list) -> dict:
    """One batched request for every id — not one per id, which is what makes
    frequent polling cheap enough to be uninteresting."""
    body = f"itemcount={len(ids)}&" + "&".join(
        f"publishedfileids%5B{n}%5D={i}" for n, i in enumerate(ids)
    )
    req = urllib.request.Request(
        STEAM_API,
        data=body.encode(),
        headers={"Content-Type": "application/x-www-form-urlencoded"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.load(resp)
    out = {}
    for d in data.get("response", {}).get("publishedfiledetails", []):
        updated = d.get("time_updated")
        if d.get("publishedfileid") and updated:
            out[str(d["publishedfileid"])] = (int(updated), str(d.get("title", "")))
    return out


def stamp(unix: int) -> str:
    return time.strftime("%m-%d %H:%M", time.localtime(unix)) if unix else "never"


def main() -> int:
    ids = workshop_ids()
    if not ids:
        print(f"no WorkshopItems found in {INI}", file=sys.stderr)
        return 1

    acf = open(ACF, encoding="utf8", errors="replace").read()
    installed = per_item(kv_section(acf, "WorkshopItemsInstalled"), "timeupdated")
    # Steam's own view of the newest version. Only a cross-check: it goes stale
    # while the server is stopped, since nothing refreshes it then.
    local_latest = per_item(kv_section(acf, "WorkshopItemDetails"), "latest_timeupdated")

    if not installed:
        print(
            f"parsed 0 installed items from {ACF} — manifest format changed?",
            file=sys.stderr,
        )
        return 1

    avail = published(ids)

    stale = []
    for item_id in ids:
        on_disk = installed.get(item_id)
        if on_disk is None:
            continue  # never downloaded; that is the seeding path's job, not an update
        api_updated, title = avail.get(item_id, (0, ""))
        newest = max(api_updated, local_latest.get(item_id, 0))
        if newest > on_disk:
            stale.append((item_id, title or item_id, on_disk, newest))

    print(f"  {len(ids)} mods listed, {len(installed)} recorded installed")
    print(f"  stale: {len(stale)}")
    for item_id, title, on_disk, newest in sorted(stale, key=lambda r: -r[3]):
        print(f"    {item_id}  disk {stamp(on_disk)} -> steam {stamp(newest)}  {title[:52]}")

    if stale:
        print()
        print("  to apply: the update watcher does this itself once the server is empty.")
        print("  to force it now, seed just these ids with SteamCMD (validate) and")
        print("  restart. Do NOT delete appworkshop_108600.acf to do it — that makes")
        print("  all of them look missing and triggers a full, crash-prone re-download.")
        print("  ids: " + " ".join(i for i, _, _, _ in stale))
    return 0


if __name__ == "__main__":
    sys.exit(main())
