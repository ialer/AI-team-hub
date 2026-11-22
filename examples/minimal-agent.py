#!/usr/bin/env python3
"""最小 Python agent —— 只用标准库，连 requests 都不需要装。"""
import json
import os
import time
import urllib.request

HUB = os.environ.get("HUB", "http://127.0.0.1:8899")
ID = os.environ.get("ID", "py-agent")
TOK = os.environ["TOK"]          # node server/tokens.mjs py-agent


def call(path, payload=None, timeout=70):
    url = f"{HUB}{path}"
    data = None
    headers = {"X-Agent-Id": ID, "X-Agent-Token": TOK}
    if payload is not None:
        data = json.dumps(payload).encode()
        headers["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=headers,
                                 method="POST" if data else "GET")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read() or b"{}")


call("/api/agent/hello", {})
print(f"[{ID}] connected to {HUB}")

session = None
while True:
    try:
        resp = call(f"/api/agent/poll?agent={ID}&timeout=50")
        session = resp.get("sessionId") or session

        for ev in resp.get("events", []):
            msg_id = ev["msgId"]
            text = ev.get("text", "")
            print(f"[{ID}] wake #{msg_id}: {text[:60]}")

            # ── 你的逻辑放这里 ──
            answer = f"收到：{text}"

            payload = {"msgId": msg_id, "text": answer}
            if session:
                payload["sessionId"] = session
            call("/api/agent/reply", payload)
    except Exception as e:
        print(f"[{ID}] error: {e}")
        time.sleep(3)