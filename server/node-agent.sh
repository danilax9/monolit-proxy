#!/usr/bin/env bash
# Агент ноды monolit proxy. Раз в 30 секунд относит на основной сервер трафик людей и кто подключён,
# забирает оттуда конфиг Xray. Новый конфиг сначала проверяет сам Xray; не прошёл — остаётся прежний, ошибка уходит в админку.
# Сюда никто не подключается: нода сама ходит на основной сервер, портов управления на ней нет.
. /etc/monolit-node.env
X=/usr/local/bin/xray
CFG=/usr/local/etc/xray/config.json
API=127.0.0.1:10085
DIR=/var/lib/monolit-node
mkdir -p "$DIR"
ERR=""

while true; do
  SIG=$(cat "$DIR/sig" 2>/dev/null || echo -)
  # трафик копится в файле, пока основной сервер его не принял: связь пропала — ничего не теряется
  S=$("$X" api statsquery --server=$API -pattern 'user>>>mp-' -reset 2>/dev/null | tr -d '\n')
  case "$S" in \{*\}) [ "$S" != "{}" ] && echo "$S" >> "$DIR/spool" ;; esac
  [ -f "$DIR/spool" ] && tail -n 500 "$DIR/spool" > "$DIR/spool.tmp" && mv "$DIR/spool.tmp" "$DIR/spool"
  STATS=$(paste -sd, "$DIR/spool" 2>/dev/null)
  IPS=""
  for n in $("$X" api statsgetallonlineusers --server=$API 2>/dev/null | grep -o 'mp-[0-9][0-9-]*' | sort -u); do
    r=$("$X" api statsonlineiplist --server=$API -email "$n" 2>/dev/null | tr -d '\n')
    case "$r" in \{*\}) IPS="$IPS${IPS:+,}\"$n\":$r" ;; esac
  done
  VER=$("$X" version 2>/dev/null | head -1 | awk '{print $2}')
  LOAD=$(cut -d' ' -f1 /proc/loadavg)
  ACTIVE=$(systemctl is-active xray 2>/dev/null)
  BODY="{\"sig\":\"$SIG\",\"xray\":\"$VER\",\"load\":\"$LOAD\",\"active\":\"$ACTIVE\",\"err\":\"$(printf %s "$ERR" | base64 -w0)\",\"stats\":[$STATS],\"ips\":{$IPS}}"
  if printf %s "$BODY" | curl -fsS -m 25 -X POST -H "x-node-key: $MN_KEY" -H 'content-type: application/json' --data-binary @- "$MN_URL/sync" -o "$DIR/resp" 2>"$DIR/curl.err"; then
    : > "$DIR/spool"
    NEW=$(head -n 1 "$DIR/resp" | tr -d '\r\n')
    if [ -n "$NEW" ] && [ "$NEW" != "$SIG" ] && [ "$(wc -l < "$DIR/resp")" -ge 1 ] && [ "$(wc -c < "$DIR/resp")" -gt 40 ]; then
      tail -n +2 "$DIR/resp" > "$DIR/cand.json"
      if OUT=$("$X" run -test -c "$DIR/cand.json" 2>&1); then
        install -m 644 "$DIR/cand.json" "$CFG"
        systemctl restart xray
        echo "$NEW" > "$DIR/sig"
        ERR=""
      else
        ERR=$(printf %s "$OUT" | tail -n 3)
      fi
    fi
  fi
  sleep 30
done
