#!/usr/bin/env python3
"""Drives AgentBridge from Python over the local runtime, using only the standard library.

This is the language-neutral promise from spec 4.1 G8: no SDK, no Node, just HTTP and WebSocket.
The WebSocket handshake and frame parsing here are deliberately minimal - enough to prove an
external process can subscribe to the event stream.
"""

import base64
import json
import os
import socket
import struct
import sys
import urllib.request

BASE = sys.argv[1]
TOKEN = sys.argv[2]
HEADERS = {"Authorization": f"Bearer {TOKEN}", "Content-Type": "application/json"}

checks = []


def check(label, ok, detail=""):
    checks.append((label, ok, detail))


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(f"{BASE}{path}", data=data, headers=HEADERS, method=method)
    with urllib.request.urlopen(request) as response:
        raw = response.read()
        return response.status, (json.loads(raw) if raw else None)


status, health = call("GET", "/health")
check("GET /health", status == 200 and health["status"] == "ok")

status, providers = call("GET", "/providers")
claude = next((p for p in providers["items"] if p["id"] == "claude"), None)
check("GET /providers finds claude", claude is not None and claude["available"], str(claude))

status, tools = call("GET", "/tools")
names = sorted(t["name"] for t in tools["items"])
check("GET /tools lists the MCP tools", names == ["read_file", "write_file"], str(names))

status, session = call("POST", "/sessions", {"provider": "claude", "model": "sonnet", "mcp": ["filesystem"]})
check("POST /sessions", status == 201 and session["status"] == "ready", str(status))

# Subscribe over WebSocket before sending, so no event is missed.
host, port = BASE.replace("http://", "").split(":")
sock = socket.create_connection((host, int(port)))
key = base64.b64encode(os.urandom(16)).decode()
sock.sendall(
    f"GET /events?token={TOKEN} HTTP/1.1\r\n"
    f"Host: {host}:{port}\r\n"
    "Upgrade: websocket\r\nConnection: Upgrade\r\n"
    f"Sec-WebSocket-Key: {key}\r\nSec-WebSocket-Version: 13\r\n\r\n".encode()
)
handshake = sock.recv(4096)
check("WebSocket upgrade accepted", b"101" in handshake.split(b"\r\n")[0], handshake.split(b"\r\n")[0].decode())


def send_frame(payload):
    data = json.dumps(payload).encode()
    mask = os.urandom(4)
    masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
    header = struct.pack("!BB", 0x81, 0x80 | len(data)) if len(data) < 126 else struct.pack("!BBH", 0x81, 0xFE, len(data))
    sock.sendall(header + mask + masked)


def read_frame():
    header = sock.recv(2)
    if len(header) < 2:
        return None
    length = header[1] & 0x7F
    if length == 126:
        length = struct.unpack("!H", sock.recv(2))[0]
    elif length == 127:
        length = struct.unpack("!Q", sock.recv(8))[0]
    body = b""
    while len(body) < length:
        body += sock.recv(length - len(body))
    return json.loads(body)


ready = read_frame()
check("received the ready frame", ready["t"] == "ready", str(ready))

send_frame({"t": "subscribe", "sessionIds": [session["id"]], "events": ["message", "tool_call"]})
subscribed = read_frame()
check("subscription acknowledged", subscribed["t"] == "subscribed", str(subscribed))

status, turn = call("POST", f"/sessions/{session['id']}/messages", {"message": "reply with exactly: ok"})
check("POST message accepted", status == 202 and "turnId" in turn, str(status))

frame = read_frame()
event = frame["event"]
check("streamed a message event over WebSocket", event["type"] == "message", str(event.get("type")))
check("the response arrived", len(event.get("content", "")) > 0, repr(event.get("content")))
check("the event carries the session id", event["sessionId"] == session["id"])

status, _ = call("DELETE", f"/sessions/{session['id']}")
check("DELETE /sessions/:id", status == 204, str(status))

sock.close()

failed = 0
print("--- checks ---")
for label, ok, detail in checks:
    print(f"  {'PASS' if ok else 'FAIL'}  {label}" + (f"  ({detail})" if detail else ""))
    if not ok:
        failed += 1

print(f"\npython client check {'PASSED' if failed == 0 else 'FAILED'}")
sys.exit(0 if failed == 0 else 1)
