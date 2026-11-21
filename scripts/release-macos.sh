#!/usr/bin/env bash
# The macOS release build. tauri-action runs it as its `tauriScript` (`bash scripts/release-macos.sh
# build <args>`) and afterwards uploads what it finds in the bundle folder, as it does for `pnpm tauri`.
#
# Tauri signs the app and the DMG; this script then notarizes the DMG and staples the ticket to it.
# Tauri could notarize as well, but it waits on Apple without a time limit: a slow notary queue once
# held a release for four hours until the runner lost its network. Here the wait has a deadline
# (NOTARY_TIMEOUT_MINUTES, default 40), a failed upload or status check is retried, and a submission
# that runs out of time is named so it can be looked up later.
#
# Notarizing the DMG also notarizes the signed app inside it, so the updater bundle (Mango.app.tar.gz,
# the same app) needs no submission of its own: macOS looks its ticket up online.
#
# Credentials come from the workflow's "Apple signing secrets" step, under names Tauri does not read:
# NOTARY_API_KEY (Key ID), NOTARY_API_ISSUER (Issuer ID), NOTARY_API_KEY_PATH (the .p8 file).
set -euo pipefail

pnpm tauri "$@"

[ "${1:-}" = build ] || exit 0

if [ -z "${APPLE_CERTIFICATE:-}" ]; then
  exit 0 # unsigned build: nothing Apple would notarize (the workflow already warned)
fi
if [ -z "${NOTARY_API_KEY:-}" ] || [ -z "${NOTARY_API_ISSUER:-}" ] || [ -z "${NOTARY_API_KEY_PATH:-}" ]; then
  echo "No notarization credentials: the DMG is signed but not notarized."
  exit 0
fi

target=""
prev=""
for arg in "$@"; do
  if [ "$prev" = --target ]; then target=$arg; fi
  prev=$arg
done
case "$target" in
  aarch64-apple-darwin) arch=aarch64 ;;
  x86_64-apple-darwin) arch=x64 ;;
  *) echo "::error::release-macos.sh needs --target aarch64-apple-darwin or x86_64-apple-darwin (got '$target')."; exit 1 ;;
esac
version=$(node -p "require('./package.json').version")
dmg="src-tauri/target/$target/release/bundle/dmg/Mango_${version}_${arch}.dmg"
if [ ! -f "$dmg" ]; then
  echo "::error::Tauri did not make $dmg."
  exit 1
fi

notary() {
  xcrun notarytool "$@" --key "$NOTARY_API_KEY_PATH" --key-id "$NOTARY_API_KEY" --issuer "$NOTARY_API_ISSUER"
}
json_field() {
  node -e 'let s = ""; process.stdin.on("data", d => s += d).on("end", () => { try { console.log(JSON.parse(s)[process.argv[1]] ?? "") } catch { console.log("") } })' "$1"
}

# Upload. Retried, since a dropped connection here is not Apple's verdict.
id=""
for attempt in 1 2 3; do
  if out=$(notary submit "$dmg" --no-wait --output-format json); then
    id=$(printf '%s' "$out" | json_field id)
    [ -n "$id" ] && break
    echo "notarytool answered without a submission id: $out"
  fi
  if [ "$attempt" = 3 ]; then
    echo "::error::Could not upload $dmg to Apple's notary service."
    exit 1
  fi
  echo "Upload failed (attempt $attempt of 3), trying again in $((attempt * 30)) s."
  sleep $((attempt * 30))
done
echo "Submitted $dmg to Apple: submission $id."

# Wait for the verdict, polling so a network error costs one poll instead of the whole run.
timeout_minutes=${NOTARY_TIMEOUT_MINUTES:-40}
deadline=$(($(date +%s) + timeout_minutes * 60))
status=""
while :; do
  if out=$(notary info "$id" --output-format json); then
    new=$(printf '%s' "$out" | json_field status)
    if [ "$new" != "$status" ]; then echo "Notarization: $new"; fi
    status=$new
    case "$status" in
      Accepted) break ;;
      Invalid | Rejected)
        notary log "$id" || true
        echo "::error::Apple did not notarize $dmg (submission $id: $status). Its log is above."
        exit 1
        ;;
    esac
  else
    echo "Could not reach Apple's notary service, trying again."
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "::error::Apple has not finished notarizing $dmg after $timeout_minutes minutes (submission $id, status: ${status:-unknown}). First submissions for a new team can take hours. Check it with 'xcrun notarytool info $id' and re-run the failed jobs."
    exit 1
  fi
  sleep 30
done

# Staple the ticket so the DMG opens without a network check. Apple's ticket server can lag the
# verdict by a little, so this is retried too.
for attempt in 1 2 3 4 5; do
  if xcrun stapler staple "$dmg"; then break; fi
  if [ "$attempt" = 5 ]; then
    echo "::error::Apple notarized $dmg (submission $id) but its ticket could not be stapled."
    exit 1
  fi
  sleep 30
done
xcrun stapler validate "$dmg"
