#!/usr/bin/env bash
# grab.sh LOGIN OUTPUT.jpg
# Capture ONE frame from a live Twitch stream at the HIGHEST available quality.
# "best" always resolves to the top quality the streamer actually broadcasts
# (we can't exceed their source resolution). Exit 0 on success.
set -euo pipefail
login="${1:?usage: grab.sh LOGIN OUTPUT.jpg}"
out="${2:?usage: grab.sh LOGIN OUTPUT.jpg}"

# best first = highest the streamer sends; explicit fallbacks just in case.
url="$(streamlink --twitch-disable-ads --stream-url "twitch.tv/${login}" \
        best,1080p60,1080p,720p60,720p,480p 2>/dev/null || true)"
if [ -z "${url}" ]; then
  echo "no playable stream for ${login}" >&2
  exit 1
fi

# -ss 1 skips a second so we don't land on a keyframe mid-transition; one frame.
ffmpeg -y -loglevel error -ss 1 -i "${url}" -frames:v 1 -q:v 2 "${out}" </dev/null
echo "wrote ${out}"
