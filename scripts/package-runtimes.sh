#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
output_dir=${1:?usage: package-runtimes.sh OUTPUT_DIR}
code_server_version=4.132.0-dsh.1
code_server_repo=iMMIQ/code-server
code_server_commit=9912ccb8c41e39e1d229fdb706d861f98c897603
package_version=$(node -p "require('$repo_root/package.json').version")
archive_dir=${CODE_SERVER_ARCHIVE_DIR:-}
download_dir=
work_dir=$(mktemp -d)

source_commit=$(git -C "$repo_root/third_party/code-server" rev-parse HEAD)
if [[ "$source_commit" != "$code_server_commit" ]]; then
  echo "code-server submodule $source_commit does not match v$code_server_version ($code_server_commit)" >&2
  exit 1
fi

if [[ -z "$archive_dir" ]]; then
  download_dir=$(mktemp -d)
  archive_dir=$download_dir
fi

cleanup() {
  rm -rf "$work_dir"
  if [[ -n "$download_dir" ]]; then rm -rf "$download_dir"; fi
}
trap cleanup EXIT

mkdir -p "$output_dir"
output_dir=$(cd "$output_dir" && pwd)
pnpm --reporter=silent --dir "$repo_root" pack --pack-destination "$work_dir" >/dev/null
thin_package="$work_dir/dsh-code-server-$package_version.tgz"

checksum_for() {
  case "$1" in
    linux-amd64) echo c308f9a81363dca830121f3c0f99f32c5a728768c5aff45b0708ba06d380014a ;;
    linux-arm64) echo 1dd2c722b967696d233cfc6530e4661555785211820c0631d3453a727089204c ;;
    macos-amd64) echo b359f6e0cc69879e0334fe599bc1e296e030242e7b6994eb459db1ca760a58a0 ;;
    macos-arm64) echo 05b7f571ae8378acde3efe1bad4eb6c09fef25ac4d1f638c9db33b11b2fefbdc ;;
    *) return 1 ;;
  esac
}

descriptor_for() {
  case "$1" in
    linux-amd64) printf '%s\n' '{"platform":"linux","arch":"x64","version":"4.132.0-dsh.1"}' ;;
    linux-arm64) printf '%s\n' '{"platform":"linux","arch":"arm64","version":"4.132.0-dsh.1"}' ;;
    macos-amd64) printf '%s\n' '{"platform":"darwin","arch":"x64","version":"4.132.0-dsh.1"}' ;;
    macos-arm64) printf '%s\n' '{"platform":"darwin","arch":"arm64","version":"4.132.0-dsh.1"}' ;;
    *) return 1 ;;
  esac
}

targets=${DSH_RUNTIME_TARGETS:-"linux-amd64 linux-arm64 macos-amd64 macos-arm64"}
for target in $targets; do
  archive="code-server-$code_server_version-$target.tar.gz"
  archive_path="$archive_dir/$archive"
  if [[ ! -f "$archive_path" ]]; then
    curl --fail --location --retry 3 \
      "https://github.com/$code_server_repo/releases/download/v$code_server_version/$archive" \
      --output "$archive_path"
  fi
  printf '%s  %s\n' "$(checksum_for "$target")" "$archive_path" | sha256sum --check --status

  stage="$work_dir/stage-$target"
  mkdir -p "$stage"
  tar -xzf "$thin_package" -C "$stage"
  mkdir -p "$stage/package/vendor/code-server"
  tar -xzf "$archive_path" --strip-components=1 -C "$stage/package/vendor/code-server"
  # Drop the bundled node binary; DSH runs the runtime on its own node via
  # NODE_EXEC_PATH. The wrapper sed covers archives built before the
  # NODE_EXEC_PATH fallback landed in the fork and is a no-op on newer ones.
  sed -i.bak 's|^exec "$ROOT/lib/node" "$ROOT" "$@"$|exec "${NODE_EXEC_PATH:-$ROOT/lib/node}" "$ROOT" "$@"|' \
    "$stage/package/vendor/code-server/bin/code-server"
  rm -f "$stage/package/vendor/code-server/bin/code-server.bak"
  rm -rf "$stage/package/vendor/code-server/lib/node"
  descriptor_for "$target" > "$stage/package/vendor/code-server/dsh-runtime.json"
  test -x "$stage/package/bin/dsh-code-server-runtime"
  test -x "$stage/package/vendor/code-server/bin/code-server"
  test ! -e "$stage/package/vendor/code-server/lib/node"
  test -f "$stage/package/vendor/code-server/LICENSE"
  test -f "$stage/package/vendor/code-server/ThirdPartyNotices.txt"

  tar --format=posix --hard-dereference --sort=name --mtime='@499162500' --owner=0 --group=0 --numeric-owner \
    -czf "$output_dir/dsh-code-server-$package_version-$target.tgz" \
    -C "$stage" package
done
