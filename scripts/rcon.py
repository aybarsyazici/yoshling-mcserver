#!/usr/bin/env python3
"""
Source RCON client. Speaks to Minecraft (25575) and Project Zomboid (27015).

Why this exists rather than a throwaway snippet each time: a naive client reads
the *auth* reply as the answer to the first command, so every response comes back
shifted by one. That is not a subtle failure — on 2026-09-15 it made a `players`
call look like it returned 0 when a player was connected, and that wrong reading
was reported as fact before being caught. Correlating replies properly is the
whole point of this file.

Usage (from the box, or anywhere that can reach the port):
    python3 rcon.py --host zomboid --port 27015 --password "$PW" players
    python3 rcon.py --host zomboid --port 27015 --password "$PW" \
        'servermsg "back in 5"' save

Project Zomboid's RCON port is NOT published to the host, so from the box you
need to be on the compose network — use scripts/pz-rcon.sh, which handles that.
"""

import argparse
import socket
import struct
import sys

SERVERDATA_RESPONSE_VALUE = 0
SERVERDATA_AUTH_RESPONSE = 2
SERVERDATA_EXECCOMMAND = 2
SERVERDATA_AUTH = 3


class RconError(Exception):
    pass


class Rcon:
    def __init__(self, host: str, port: int, password: str, timeout: float = 10.0):
        self.password = password
        self.timeout = timeout
        self.sock = socket.create_connection((host, port), timeout)
        self.sock.settimeout(timeout)
        self._buf = b""
        self._next_id = 1

    # ── framing ────────────────────────────────────────────────────────────
    def _send(self, req_id: int, req_type: int, body: str) -> None:
        payload = struct.pack("<ii", req_id, req_type) + body.encode("utf8") + b"\x00\x00"
        self.sock.sendall(struct.pack("<i", len(payload)) + payload)

    def _read_packet(self):
        """One (id, type, body) triple, or None if the peer closed."""
        while True:
            if len(self._buf) >= 4:
                size = struct.unpack("<i", self._buf[:4])[0]
                if len(self._buf) >= 4 + size:
                    frame = self._buf[4 : 4 + size]
                    self._buf = self._buf[4 + size :]
                    req_id, req_type = struct.unpack("<ii", frame[:8])
                    # trailing two NULs are padding, not content
                    return req_id, req_type, frame[8:-2].decode("utf8", "replace")
            chunk = self.sock.recv(4096)
            if not chunk:
                return None
            self._buf += chunk

    # ── protocol ───────────────────────────────────────────────────────────
    def authenticate(self) -> None:
        """
        The server answers auth with an empty RESPONSE_VALUE *and then* an
        AUTH_RESPONSE. Skipping to the AUTH_RESPONSE is what keeps every later
        reply aligned with its command; treating that empty packet as an answer
        is the off-by-one this class exists to prevent.
        """
        req_id = self._next_id
        self._next_id += 1
        self._send(req_id, SERVERDATA_AUTH, self.password)
        while True:
            pkt = self._read_packet()
            if pkt is None:
                raise RconError("connection closed during authentication")
            got_id, got_type, _ = pkt
            if got_type == SERVERDATA_AUTH_RESPONSE:
                if got_id == -1:
                    raise RconError("authentication failed — wrong password")
                return

    def command(self, cmd: str) -> str:
        """Send one command and return only its own reply."""
        req_id = self._next_id
        self._next_id += 1
        self._send(req_id, SERVERDATA_EXECCOMMAND, cmd)

        parts = []
        while True:
            try:
                pkt = self._read_packet()
            except socket.timeout:
                break  # server had nothing more to say
            if pkt is None:
                break
            got_id, got_type, body = pkt
            if got_type != SERVERDATA_RESPONSE_VALUE or got_id != req_id:
                continue  # not ours — never let it be mistaken for our answer
            parts.append(body)
            # A short grace period catches multi-packet replies without hanging
            # for the full timeout on the common single-packet case.
            self.sock.settimeout(0.4)
        self.sock.settimeout(self.timeout)
        return "".join(parts)

    def close(self) -> None:
        try:
            self.sock.close()
        except OSError:
            pass


def main() -> int:
    ap = argparse.ArgumentParser(description="Source RCON client")
    ap.add_argument("--host", required=True)
    ap.add_argument("--port", type=int, required=True)
    ap.add_argument("--password", required=True)
    ap.add_argument("--timeout", type=float, default=10.0)
    ap.add_argument("commands", nargs="+", help="one or more commands to run in order")
    args = ap.parse_args()

    try:
        rcon = Rcon(args.host, args.port, args.password, args.timeout)
        rcon.authenticate()
    except (OSError, RconError) as exc:
        print(f"rcon: {exc}", file=sys.stderr)
        return 1

    status = 0
    for cmd in args.commands:
        try:
            reply = rcon.command(cmd)
        except (OSError, RconError) as exc:
            print(f"rcon: {cmd!r}: {exc}", file=sys.stderr)
            status = 1
            break
        print(f"$ {cmd}")
        print(reply.strip() or "(no output)")
    rcon.close()
    return status


if __name__ == "__main__":
    sys.exit(main())
