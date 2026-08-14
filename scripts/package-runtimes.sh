#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
output_dir=${1:?usage: package-runtimes.sh OUTPUT_DIR}
code_server_version=4.132.0-dsh.1
code_server_repo=iMMIQ/code-server
code_server_commit=f144b4046bd58ebd4add18ae273095ffce7ff70f
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
    linux-amd64) echo 338be5e3820a1dda8578cf75015b79042aed80a8c32012840d92001f48d41d8a ;;
    linux-arm64) echo 24960d74e6d101c22d00e87cc8c1fbc721d6e829af309040c3e8f1242a507afc ;;
    macos-amd64) echo 8920ac3fa05ef0a8d234f58bd45f9018210e851abd2ab5f4ea0c79d160701355 ;;
    macos-arm64) echo 6948bfec21ec204b38115de4ed233d531e17c35e3f856ca3540ce21776290d94 ;;
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
  descriptor_for "$target" > "$stage/package/vendor/code-server/dsh-runtime.json"
  test -x "$stage/package/bin/dsh-code-server-runtime"
  test -x "$stage/package/vendor/code-server/bin/code-server"
  test -x "$stage/package/vendor/code-server/lib/node"
  test -f "$stage/package/vendor/code-server/LICENSE"
  test -f "$stage/package/vendor/code-server/ThirdPartyNotices.txt"

  tar --format=posix --hard-dereference --sort=name --mtime='@499162500' --owner=0 --group=0 --numeric-owner \
    -czf "$output_dir/dsh-code-server-$package_version-$target.tgz" \
    -C "$stage" package
done
