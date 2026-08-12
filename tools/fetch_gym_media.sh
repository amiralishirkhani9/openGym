#!/usr/bin/env bash
#
# fetch_gym_media.sh — pull the whole exercise media set for offline packaging.
#
# openGym 1.4.x streamed 1324 animations + thumbnails from a pinned jsDelivr
# mirror, so the app needed a working connection to show any exercise at all.
# This downloads the set once so the build can bake it into the APK instead.
#
# Output: $DEST/gif/<id>.gif and $DEST/img/<id>.jpg (upstream 180x180 originals).
# Re-runnable: an already-complete file is skipped, so an interrupted run just
# continues. Failures are collected and printed at the end rather than aborting
# the whole batch, because a single CDN hiccup should not throw away 100 MB.

set -uo pipefail

BASE="https://cdn.jsdelivr.net/gh/hasaneyldrm/exercises-dataset@7455efae41b330c265e7cd4b78dfa848e7ce5ebd"
DEST="${DEST:-/tmp/exmedia}"
JOBS="${JOBS:-12}"
GIFLIST="${GIFLIST:-/tmp/giflist.txt}"
IMGLIST="${IMGLIST:-/tmp/imglist.txt}"

mkdir -p "$DEST/gif" "$DEST/img"

# One file: skip when it already looks complete, else fetch with a retry.
# A GIF under 1 KB is a truncated or error body, never a real animation.
fetch() {
  local url="$1" out="$2" min="$3"
  if [ -f "$out" ] && [ "$(stat -c%s "$out")" -ge "$min" ]; then return 0; fi
  curl -sfL --retry 3 --retry-delay 1 --max-time 120 -o "$out" "$url" || { echo "FAIL $url" >&2; return 1; }
  if [ "$(stat -c%s "$out")" -lt "$min" ]; then
    echo "SHORT $url" >&2; rm -f "$out"; return 1
  fi
}
export -f fetch

run_list() {
  local list="$1" sub="$2" dir="$3" min="$4"
  # xargs -P gives parallel downloads without a job-control race on the counter.
  # bash -c per file is cheap next to a network round trip.
  xargs -a "$list" -P "$JOBS" -I{} bash -c \
    'fetch "'"$BASE/$sub"'/{}" "'"$DEST/$dir"'/{}" '"$min" 2>>"$DEST/errors.log"
}

: > "$DEST/errors.log"
echo "==> animations ($(wc -l < "$GIFLIST") files)"
run_list "$GIFLIST" videos gif 1024
echo "==> thumbnails ($(wc -l < "$IMGLIST") files)"
run_list "$IMGLIST" images img 512

echo
echo "gif: $(ls "$DEST/gif" | wc -l) files, $(du -sh "$DEST/gif" | cut -f1)"
echo "img: $(ls "$DEST/img" | wc -l) files, $(du -sh "$DEST/img" | cut -f1)"
if [ -s "$DEST/errors.log" ]; then
  echo
  echo "failures ($(wc -l < "$DEST/errors.log")):"
  sort -u "$DEST/errors.log" | head -20
fi
