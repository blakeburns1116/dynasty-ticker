#!/usr/bin/env bash
# grab.sh LOGIN OUTPUT.jpg
# Capture ONE frame from a live Twitch stream, as cheaply as possible.
# Requests 720p (good enough to read the score bug, far less bandwidth than
# source) and pulls a single frame via ffmpeg. Exit 0 on success, non-zero if
# the channel isn't live / no playable stream.
set -euo pipefail
login="${1:?usage: grab.sh LOGIN OUTPUT.jpg}"
out="${2:?usage: grab.sh LOGIN OUTPUT.jpg}"

# Prefer 720p to keep bandwidth down; fall back through common qualities.
url="$(streamlink --stream-url "twitch.tv/${login}" 720p,720p60,480p,best 2>/dev/null || true)"
if [ -z "${url}" ]; then
  echo "no playable stream for ${login}" >&2
  exit 1
fi

# -ss 1 skips a second so we don't grab a keyframe mid-transition; one frame only.
ffmpeg -y -loglevel error -ss 1 -i "${url}" -frames:v 1 -q:v 3 "${out}" </dev/null
echo "wrote ${out}"
