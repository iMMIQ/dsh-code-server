#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
output_dir=${1:?usage: package-runtimes.sh OUTPUT_DIR}
code_server_version=4.132.0-dsh.5
code_server_repo=iMMIQ/code-server
code_server_commit=024c825037fda0f687b0247f1dd915fa88c8c1eb
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
    # dsh.5: all four from the fork's v4.132.0-dsh.5 release (built by its
    # CI from 024c8250; local builds are not byte-reproducible, so the
    # release archives are the source of truth).
    linux-amd64) echo cd58483a5606479ce7446b9313f352bb05a62ed48f0daf0a25a40b728474fd86 ;;
    linux-arm64) echo 6894eff09bb017330e7ece0e91d5bc57831f46284b787ca70aaed3118852e9d4 ;;
    macos-amd64) echo 73715f2141ab88135a402c59e55683346319cb73fe212cc789d93e79453ab84b ;;
    macos-arm64) echo 67baf6777be91175d602db44afbe821dad7fb07ce205bfc15ae5543568382cf5 ;;
    *) return 1 ;;
  esac
}

descriptor_for() {
  case "$1" in
    linux-amd64) printf '%s\n' '{"platform":"linux","arch":"x64","version":"4.132.0-dsh.5"}' ;;
    linux-arm64) printf '%s\n' '{"platform":"linux","arch":"arm64","version":"4.132.0-dsh.5"}' ;;
    macos-amd64) printf '%s\n' '{"platform":"darwin","arch":"x64","version":"4.132.0-dsh.5"}' ;;
    macos-arm64) printf '%s\n' '{"platform":"darwin","arch":"arm64","version":"4.132.0-dsh.5"}' ;;
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
  # npm auto-installed typescript as i18next's optional peer dependency;
  # nothing in the runtime requires it at runtime. Releases built after the
  # fork dropped it already pass this rm through as a no-op.
  rm -rf "$stage/package/vendor/code-server/node_modules/typescript"
  descriptor_for "$target" > "$stage/package/vendor/code-server/dsh-runtime.json"
  test -x "$stage/package/bin/dsh-code-server-runtime"
  test -x "$stage/package/vendor/code-server/bin/code-server"
  test ! -e "$stage/package/vendor/code-server/lib/node"
  test ! -e "$stage/package/vendor/code-server/node_modules/typescript"
  test -f "$stage/package/vendor/code-server/LICENSE"
  test -f "$stage/package/vendor/code-server/ThirdPartyNotices.txt"

  tar --format=posix --hard-dereference --sort=name --mtime='@499162500' --owner=0 --group=0 --numeric-owner \
    -czf "$output_dir/dsh-code-server-$package_version-$target.tgz" \
    -C "$stage" package
done
