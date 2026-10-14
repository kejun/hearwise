#!/usr/bin/env bash
set -euo pipefail
# Official, fixed, checksum-verified verification-only Linux toolchain.
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || {
  echo 'This installer supports Linux x86_64 only; install the pinned lean-toolchain for other hosts.' >&2
  exit 1
}
target="${1:?Usage: scripts/setup-revision-lean.sh INSTALL_DIRECTORY}"
mkdir -p "$target"
archive="$(mktemp "$target/lean-download.XXXXXX")"
trap 'rm -f "$archive"' EXIT
curl --fail --location --proto '=https' --proto-redir '=https' --retry 2 --connect-timeout 20 --max-time 600 \
  https://github.com/leanprover/lean4/releases/download/v4.35.0/lean-4.35.0-linux.tar.zst -o "$archive"
printf '%s  %s\n' '7289597a44543246c9227b8cae501767e095ce17f6d448b95fc4a8dc97268f6d' "$archive" | sha256sum --check -
tar --zstd -xf "$archive" -C "$target"
"$target/lean-4.35.0-linux/bin/lean" --version
printf 'Add this directory to PATH: %s/lean-4.35.0-linux/bin\n' "$target"
