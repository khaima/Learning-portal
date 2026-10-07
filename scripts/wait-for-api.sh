#!/usr/bin/env bash
# After a deploy: wait until the API's health check answers 200 with this
# release (a fresh deploy can take a minute or two to start).
#   scripts/wait-for-api.sh <health url> <release>
url=$1
release=$2
for attempt in $(seq 1 24); do
  body=$(curl -s --max-time 20 "$url" || true)
  # The reply is compact JSON: {"ok":true,"database":"ok",…,"release":"<commit>",…}
  if echo "$body" | grep -q '"ok":true' && echo "$body" | grep -q "\"release\":\"$release\""; then
    echo "✓ $url — up, release $release"
    exit 0
  fi
  echo "waiting ($attempt): ${body:-no answer}"
  sleep 10
done
echo "::error::$url didn't answer with release $release within 4 minutes"
exit 1
