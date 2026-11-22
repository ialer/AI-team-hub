#!/bin/bash
# 最小 agent：纯 shell，只依赖 curl + jq。
# 演示 AGP 长轮询的全部契约 —— 没装 connector 也能接。
set -e

HUB="${HUB:-http://127.0.0.1:8899}"
ID="${ID:-shell-agent}"
TOK="${TOK:?set TOK to the value printed by: node server/tokens.mjs $ID}"

auth=(-H "X-Agent-Id: $ID" -H "X-Agent-Token: $TOK")

curl -s -X POST "$HUB/api/agent/hello" "${auth[@]}" \
  -H 'Content-Type: application/json' -d '{}' >/dev/null
echo "[$ID] connected to $HUB"

while :; do
  resp=$(curl -s "${auth[@]}" "$HUB/api/agent/poll?agent=$ID&timeout=50" || true)

  echo "$resp" | jq -c '.events[]?' 2>/dev/null | while read -r ev; do
    msg=$(jq -r '.msgId' <<<"$ev")
    txt=$(jq -r '.text'  <<<"$ev")
    from=$(jq -r '.from' <<<"$ev")
    echo "[$ID] wake #$msg from $from: $txt"

    body=$(jq -nc --argjson m "$msg" --arg t "收到（来自 $from）：$txt" \
             '{msgId:$m, text:$t}')
    curl -s -X POST "$HUB/api/agent/reply" "${auth[@]}" \
      -H 'Content-Type: application/json' -d "$body" >/dev/null
  done
done