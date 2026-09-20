#!/usr/bin/env bash
set -euo pipefail

node_version="${1:-24.21.0}"
if [[ ! "$node_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  echo "Invalid Node.js version: $node_version" >&2
  exit 2
fi

archive="node-v${node_version}-linux-x64.tar.xz"
release_url="https://nodejs.org/download/release/v${node_version}"
install_root="$HOME/.local"
node_directory="$install_root/node-v${node_version}-linux-x64"
temporary_directory="$(mktemp -d)"
trap 'rm -rf -- "$temporary_directory"' EXIT

mkdir -p -- "$install_root" "$install_root/npm-global"

if [[ ! -x "$node_directory/bin/node" ]]; then
  cd "$temporary_directory"
  curl --fail --silent --show-error --location --remote-name \
    "$release_url/$archive"
  curl --fail --silent --show-error --location --remote-name \
    "$release_url/SHASUMS256.txt"
  grep "  $archive\$" SHASUMS256.txt | sha256sum --check --strict -
  tar -xJf "$archive" -C "$install_root"
fi

ln -sfn -- "$node_directory" "$install_root/node"
export PATH="$install_root/node/bin:$install_root/npm-global/bin:$PATH"

npm install --global --prefix "$install_root/npm-global" "pm2@6"

node --version
npm --version
pm2 --version
