#!/usr/bin/env bash
# grab.sh LOGIN OUTPREFIX [COUNT]
# Capture COUNT frames (~1 second apart) from a live Twitch stream in ONE pull,
# so we can vote across several screenshots without spawning many pipelines.
# Writes OUTPREFIX_1.jpg .. OUTPREFIX_COUNT.jpg. Exit 0 on success.
set -euo pipefail
login="${1:?usage: grab.sh LOGIN OUTPREFIX [COUNT]}"
prefix="${2:?usage: grab.sh LOGIN OUTPREFIX [COUNT]}"
count="${3:-5}"

# best first = highest the streamer sends; explicit fallbacks just in case.
url="$(streamlink --twitch-disable-ads --stream-url "twitch.tv/${login}" \
        best,1080p60,1080p,720p60,720p,480p 2>/dev/null || true)"
if [ -z "${url}" ]; then
  echo "no playable stream for ${login}" >&2
  exit 1
fi

# One ffmpeg pass, 1 frame/sec for COUNT frames — different moments for voting,
# one decode pipeline (light on memory).
ffmpeg -y -loglevel error -i "${url}" -vf fps=1 -frames:v "${count}" -q:v 2 "${prefix}_%d.jpg" </dev/null
echo "wrote ${count} frames to ${prefix}"
