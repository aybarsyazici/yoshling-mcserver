#!/usr/bin/env python3
r"""
Read facts out of Project Zomboid's own bytecode.

Runs ON the box, where the jar lives inside the game container. There is no
`javap` and no `strings` in these images, so the constant pool has to be read
directly — which is fine, because that is where the answers are.

Getting an answer from the jar has repeatedly beaten guessing. It is how we
established that `AntiCheat$Policy` is Ban=1 Kick=2 Log=3 Disabled=4 (the
anti-cheat .ini values are that enum), that `servermsg` goes to
`ChatServer.sendServerAlertMessageToServerChat` (a real broadcast, not a reply to
the caller), and that `teleportplayer` — not `teleport` — is the admin command.

    # first run only: lift the jar out of the container
    ssh BOX 'docker cp yoshling-pz:/home/steam/pz-dedicated/java/projectzomboid.jar /tmp/pz.jar'

    ssh BOX 'python3 - -- find AntiCheat'                      < scripts/pz-jar.py
    ssh BOX 'python3 - -- grep sendServerAlert'                < scripts/pz-jar.py
    ssh BOX 'python3 - -- strings "zombie/commands/serverCommands/TeleportPlayerCommand"' \
        < scripts/pz-jar.py

Put the arguments INSIDE the quoted remote command, and escape `$` — a nested
class name contains one, and it passes through two shells before python sees it.
Unescaped, `AntiCheat$Policy` becomes `AntiCheat`, which is a real class, so you
get a confident answer about the wrong thing rather than an error:

    ssh BOX 'python3 - -- enum "zombie/network/anticheats/AntiCheat\$Policy"' \
        < scripts/pz-jar.py
    #  Ban = 1 / Kick = 2 / Log = 3 / Disabled = 4

Modes:
  find <substring>    class names containing the substring (case-insensitive)
  grep <substring>    classes whose *contents* mention the substring
  strings <class>     printable constant-pool strings of one class
  enum <class>        static final int fields and their values — the reliable way
                      to turn a numeric .ini setting into a named meaning
"""

import re
import struct
import sys
import zipfile

JAR = "/tmp/pz.jar"


def open_jar() -> zipfile.ZipFile:
    try:
        return zipfile.ZipFile(JAR)
    except FileNotFoundError:
        sys.exit(
            f"{JAR} not found. Copy it out of the container first:\n"
            "  docker cp yoshling-pz:/home/steam/pz-dedicated/java/projectzomboid.jar /tmp/pz.jar"
        )


def normalise(name: str) -> str:
    return name if name.endswith(".class") else name + ".class"


def mode_find(z, needle: str) -> None:
    low = needle.lower()
    hits = [n for n in z.namelist() if n.endswith(".class") and low in n.lower()]
    for n in sorted(hits):
        print(f"  {n}")
    print(f"  --- {len(hits)} class(es) ---")


def mode_grep(z, needle: str) -> None:
    raw = needle.encode()
    count = 0
    for n in z.namelist():
        if not n.endswith(".class"):
            continue
        if raw in z.read(n):
            print(f"  {n}")
            count += 1
    print(f"  --- {count} class(es) mention {needle!r} ---")


def mode_strings(z, cls: str) -> None:
    data = z.read(normalise(cls))
    seen = []
    for s in re.findall(rb"[ -~]{3,}", data):
        text = s.decode("utf8", "replace")
        if text not in seen:
            seen.append(text)
    for text in seen:
        print(f"  {text[:120]}")


def _constant_pool(data: bytes):
    """(pool, offset_after_pool). Only the entries we need are decoded."""
    pos = 8  # magic + minor/major
    count = struct.unpack_from(">H", data, pos)[0]
    pos += 2
    pool, i = {}, 1
    while i < count:
        tag = data[pos]
        pos += 1
        if tag == 1:  # Utf8
            length = struct.unpack_from(">H", data, pos)[0]
            pos += 2
            pool[i] = data[pos : pos + length].decode("utf8", "replace")
            pos += length
        elif tag == 3:  # Integer
            pool[i] = struct.unpack_from(">i", data, pos)[0]
            pos += 4
        elif tag == 4:  # Float
            pos += 4
        elif tag in (5, 6):  # Long / Double take two pool slots
            pos += 8
            i += 1
        elif tag in (7, 8, 16, 19, 20):
            pos += 2
        elif tag == 15:
            pos += 3
        else:  # Fieldref, Methodref, InterfaceMethodref, NameAndType, InvokeDynamic…
            pos += 4
        i += 1
    return pool, pos


def mode_enum(z, cls: str) -> None:
    """
    Static final int constants, from each field's ConstantValue attribute.

    This is the trick worth remembering: a numeric server-config value is usually
    a Java enum or int constant, and reading the names off the class turns
    `AntiCheatHit=2` from a mystery number into "Kick" without any guessing.
    """
    data = z.read(normalise(cls))
    pool, pos = _constant_pool(data)
    pos += 6  # access_flags, this_class, super_class
    interfaces = struct.unpack_from(">H", data, pos)[0]
    pos += 2 + interfaces * 2

    field_count = struct.unpack_from(">H", data, pos)[0]
    pos += 2
    found = False
    for _ in range(field_count):
        _, name_idx, _, attr_count = struct.unpack_from(">HHHH", data, pos)
        pos += 8
        value = None
        for _ in range(attr_count):
            attr_name_idx, attr_len = struct.unpack_from(">HI", data, pos)
            pos += 6
            if pool.get(attr_name_idx) == "ConstantValue":
                value = pool.get(struct.unpack_from(">H", data, pos)[0])
            pos += attr_len
        if value is not None:
            print(f"  {pool.get(name_idx)} = {value}")
            found = True
    if not found:
        print("  (no static final constants — try `strings` on this class instead)")


def main() -> int:
    argv = [a for a in sys.argv[1:] if a != "--"]
    if len(argv) < 2:
        print(__doc__)
        return 64
    mode, arg = argv[0], argv[1]
    z = open_jar()
    dispatch = {"find": mode_find, "grep": mode_grep, "strings": mode_strings, "enum": mode_enum}
    if mode not in dispatch:
        print(f"unknown mode {mode!r}; expected one of {', '.join(dispatch)}", file=sys.stderr)
        return 64
    try:
        dispatch[mode](z, arg)
    except KeyError:
        print(f"class not found in jar: {arg}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
