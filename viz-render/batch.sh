#!/usr/bin/env bash
# Офлайн-батч визуализатора: рендер всех обоев манифеста во всех комнатах.
# Использование: ROOMS=vitalnia,bedroom,kids SAMPLES=96 ./batch.sh
# Идемпотентен: существующие {room}/{slug}.webp не перерендериваются.
set -u
cd "$(dirname "$0")"

BLENDER=${BLENDER:-$HOME/blender/blender-4.2.23-linux-x64/blender}
ROOMS=${ROOMS:-vitalnia,bedroom,kids}
# ПРОДАКШН-дефолты качества. Понижать только через MODE=preview
# (пишет в out-preview/, никогда не попадает в Storage).
RES_W=${RES_W:-1920}
RES_H=${RES_H:-1080}
SAMPLES=${SAMPLES:-128}
QUALITY=${QUALITY:-88}
OUT_DIR=${OUT_DIR:-out}
LIMIT=${LIMIT:-0}
if [ "${MODE:-production}" = "preview" ]; then
  RES_W=960; RES_H=540; SAMPLES=32; OUT_DIR=out-preview
  echo "PREVIEW mode: $RES_W x $RES_H / $SAMPLES smp -> $OUT_DIR (не для Storage)"
fi

mkdir -p "$OUT_DIR" /tmp/viztex

render_room() {
  local slug="$1" tex="$2" roll="$3" room="$4"
  local out="$OUT_DIR/$room/$slug.webp"
  if [ -f "$out" ]; then
    echo "skip $room/$slug"
    return 0
  fi
  echo "render $room/$slug (roll ${roll}cm)"
  "$BLENDER" --background --factory-startup -P build_scene.py -- \
    --room "$room" --texture "$tex" --roll-w "$roll" \
    --width "$RES_W" --height "$RES_H" --samples "$SAMPLES" \
    --format webp --quality "$QUALITY" --out "$out" \
    || { echo "RENDERFAIL $room/$slug"; return 1; }
  return 0
}

node -e 'const m=require("./render-manifest.json");for(const i of m)console.log([i.slug,i.textureUrl,i.rollWidthCm||53].join("\t"))' > /tmp/viztex/list.tsv

count=0
while IFS=$'\t' read -r slug url roll; do
  tex="/tmp/viztex/$slug.png"
  if [ ! -f "$tex" ]; then
    raw="/tmp/viztex/raw-$slug.${url##*.}"
    curl -sS -m 60 -o "$raw" "$url"
    # Резкое предпонижение: без этого Cycles минифицирует 1900px -> ~200px
    # билинейно + деноизер smear'ит — получается каша. Lanczos 1024px
    # оставляет весь различимый на экране детайл.
    PYTHONPATH=/tmp/pylibs python3 - "$raw" "$tex" <<'PY'
import sys
from PIL import Image
im = Image.open(sys.argv[1]).convert('RGB')
w = 1024
if im.width > w:
    im = im.resize((w, round(im.height * w / im.width)), Image.LANCZOS)
im.save(sys.argv[2], 'PNG')
PY
    rm -f "$raw"
  fi
  for room in ${ROOMS//,/ }; do
    if [ -f "$OUT_DIR/$room/$slug.webp" ]; then
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

echo "batch done: $(find "$OUT_DIR" -name '*.webp' | wc -l) frames"
