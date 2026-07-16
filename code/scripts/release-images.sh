#!/usr/bin/env bash
# Publishes both service images for a release — called by semantic-release
# (.releaserc.json publishCmd) with the new version, cwd = code/.
#
# Lockstep versioning: one version, one image per service, both tagged
# v<version> (immutable in ECR). SERVICE_VERSION is baked into each image so
# every log line carries the version that wrote it.
set -euo pipefail

VERSION="${1:?usage: release-images.sh <version>}"

# ECR_REGISTRY is set by CI after the ECR login step. When it's absent (e.g.
# AWS isn't wired into GitHub Actions yet), the release still tags the commit
# and publishes release notes — it just skips the images.
if [[ -z "${ECR_REGISTRY:-}" ]]; then
  echo "ECR_REGISTRY is not set — skipping image publish for v${VERSION}" >&2
  exit 0
fi

API_REPOSITORY="${API_ECR_REPOSITORY:?set API_ECR_REPOSITORY (the api's ECR repo name)}"
HYDRATOR_REPOSITORY="${HYDRATOR_ECR_REPOSITORY:?set HYDRATOR_ECR_REPOSITORY (the hydrator's ECR repo name)}"

build_and_push() {
  local service="$1" repository="$2"
  local image="${ECR_REGISTRY}/${repository}:v${VERSION}"

  docker build --platform linux/amd64 \
    -f "${service}/Dockerfile" \
    --build-arg SERVICE_VERSION="${VERSION}" \
    -t "${image}" .
  docker push "${image}"
  echo "published ${image}"
}

build_and_push api "${API_REPOSITORY}"
build_and_push hydrator "${HYDRATOR_REPOSITORY}"
