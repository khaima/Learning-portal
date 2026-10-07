#!/usr/bin/env bash
# After a deploy: wait until the API's health check answers 200 with this
# release (a fresh deploy can take a minute or two to start).
#   scripts/wait-for-api.sh <health url> <release>
url=$1
release=$2
for attempt in $(seq 1 24); do
  body=$(curl -s --max-time 20 "$url" || true)
  if echo "$body" | jq -e --arg r "$release" '.ok == true and .release == $r' >/dev/null 2>&1; then
    echo "✓ $url — up, release $release"
    exit 0
  fi
  echo "waiting ($attempt): ${body:-no answer}"
  sleep 10
done
echo "::error::$url didn't answer with release $release within 4 minutes"
exit 1
