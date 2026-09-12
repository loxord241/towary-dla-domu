#!/usr/bin/env bash
# Офлайн-батч визуализатора: рендер всех обоев манифеста во всех комнатах.
# Использование: ROOMS=vitalnia,bedroom,kids SAMPLES=96 ./batch.sh
# Идемпотентен: существующие {room}/{slug}.webp не перерендериваются.
set -u
cd "$(dirname "$0")"

BLENDER=${BLENDER:-$HOME/blender/blender-4.2.23-linux-x64/blender}
ROOMS=${ROOMS:-vitalnia,bedroom,kids}
RES_W=${RES_W:-1920}
RES_H=${RES_H:-1080}
SAMPLES=${SAMPLES:-96}
LIMIT=${LIMIT:-0}

mkdir -p out /tmp/viztex

render_room() {
  local slug="$1" tex="$2" roll="$3" room="$4"
  local out="out/$room/$slug.webp"
  if [ -f "$out" ]; then
    echo "skip $room/$slug"
    return 0
  fi
  echo "render $room/$slug (roll ${roll}cm)"
  "$BLENDER" --background --factory-startup -P build_scene.py -- \
    --room "$room" --texture "$tex" --roll-w "$roll" \
    --width "$RES_W" --height "$RES_H" --samples "$SAMPLES" \
    --format webp --quality 85 --out "$out" \
    || { echo "RENDERFAIL $room/$slug"; return 1; }
  return 0
}

node -e 'const m=require("./render-manifest.json");for(const i of m)console.log([i.slug,i.textureUrl,i.rollWidthCm||53].join("\t"))' > /tmp/viztex/list.tsv

count=0
while IFS=$'\t' read -r slug url roll; do
  tex="/tmp/viztex/$slug.${url##*.}"
  if [ ! -f "$tex" ]; then
    curl -sS -m 60 -o "$tex" "$url"
  fi
  for room in ${ROOMS//,/ }; do
    if [ -f "out/$room/$slug.webp" ]; then
      continue
    fi
    render_room "$slug" "$tex" "$roll" "$room"
    count=$((count+1))
  done
  if [ "$LIMIT" != "0" ] && [ "$count" -ge "$LIMIT" ]; then
    echo "LIMIT $LIMIT reached"
    break
  fi
done < /tmp/viztex/list.tsv

echo "batch done: $(find out -name '*.webp' | wc -l) frames"
