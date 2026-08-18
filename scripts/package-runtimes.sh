#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
output_dir=${1:?usage: package-runtimes.sh OUTPUT_DIR}
# The runtime version is owned by src/index.ts (BUNDLED_CODE_SERVER_VERSION);
# deriving it here keeps the packaged dsh-runtime.json and the host-side check
# from drifting apart — the mismatch that broke the v0.1.4 release boot.
code_server_version=$(node -p "require('node:fs').readFileSync('$repo_root/src/index.ts','utf8').match(/BUNDLED_CODE_SERVER_VERSION = '([^']+)'/)[1]")
code_server_repo=iMMIQ/code-server
code_server_commit=07f611cb3bb9d73f97fef164568eee015b3133d2
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
    # dsh.6: all four from the fork's v4.132.0-dsh.6 release (built by its
    # CI from 07f611cb; local builds are not byte-reproducible, so the
    # release archives are the source of truth).
    linux-amd64) echo 42c59b27c407b9d77c12ead93b897e0f168c7a672074cdfcce6dfd0bb34b3fc0 ;;
    linux-arm64) echo d48439e799da98b1ef9830b664e6b06ff093a122485f707ac43b22d0786ac6fb ;;
    macos-amd64) echo 5478057578f400814ba25b9b3dcdfc6d4f682d55c4e66368d76c15525ceef0ac ;;
    macos-arm64) echo 84900cf71f2db5138aa4e5ce8e918aaa688d6ad5bbe281beaae8eba73f764fb3 ;;
    *) return 1 ;;
  esac
}

descriptor_for() {
  case "$1" in
    linux-amd64) printf '%s\n' '{"platform":"linux","arch":"x64","version":"4.132.0-dsh.6"}' ;;
    linux-arm64) printf '%s\n' '{"platform":"linux","arch":"arm64","version":"4.132.0-dsh.6"}' ;;
    macos-amd64) printf '%s\n' '{"platform":"darwin","arch":"x64","version":"4.132.0-dsh.6"}' ;;
    macos-arm64) printf '%s\n' '{"platform":"darwin","arch":"arm64","version":"4.132.0-dsh.6"}' ;;
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
