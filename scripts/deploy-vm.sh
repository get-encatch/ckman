#!/usr/bin/env bash
# Build ckman (React UI + Go backend) and install it on a VM over SSH (see FORK.md).
# Usage: scripts/deploy-vm.sh user@host [ssh options, e.g. -i key.pem]
# Needs git and Docker where it runs (Node and Go run in containers).
# The VM needs systemd and sudo (or root).
set -euo pipefail

target=${1:?usage: scripts/deploy-vm.sh user@host [ssh options]}
shift
ssh_opts=("$@")

cd "$(dirname "$0")/.."
version=$(git describe --tags --always --dirty)
revision=$(git rev-parse HEAD)
user_flags=(--user "$(id -u):$(id -g)" -e HOME=/tmp)

echo "==> building web/"
docker run --rm "${user_flags[@]}" -v "$PWD":/w -w /w/web node:22-bookworm \
  sh -c 'npm ci --no-audit --no-fund && npm run build'
rm -rf static/dist/index.html static/dist/assets static/dist/.frontend.*
mkdir -p static/dist
cp -r web/dist/. static/dist/

echo "==> building ckman $version"
docker run --rm "${user_flags[@]}" -v "$PWD":/w -w /w \
  -e CGO_ENABLED=0 -e GOOS=linux -e GOARCH="${GOARCH:-amd64}" \
  -e GOCACHE=/tmp/go-cache -e GOPATH=/tmp/go \
  -e GOPROXY=https://proxy.golang.org,direct golang:1.24 \
  go build -o build/ckman \
  -ldflags "-X main.Version=$version -X main.GitCommitHash=$revision -X main.BuildTimeStamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)" .

stage=build/stage
rm -rf "$stage"
mkdir -p "$stage"
cp build/ckman "$stage/"
cp resources/{ckman.hjson,migrate.hjson,password,server.key,server.crt,ckman.service,postgres.sql} "$stage/"
tar -C "$stage" -czf build/ckman-deploy.tgz .

echo "==> installing on $target"
scp "${ssh_opts[@]}" build/ckman-deploy.tgz "$target":/tmp/ckman-deploy.tgz
ssh "${ssh_opts[@]}" "$target" 'sudo sh -s' <<'REMOTE'
set -eu
d=$(mktemp -d)
tar -xzf /tmp/ckman-deploy.tgz -C "$d"
rm -f /tmp/ckman-deploy.tgz

id ckman >/dev/null 2>&1 || useradd --system --create-home --shell /usr/sbin/nologin ckman
mkdir -p /etc/ckman/conf /etc/ckman/dbscript /var/log/ckman

# Config is installed only the first time; later deploys keep the VM's edits.
for f in ckman.hjson migrate.hjson password server.key server.crt; do
  [ -e "/etc/ckman/conf/$f" ] || install -m 640 "$d/$f" "/etc/ckman/conf/$f"
done
install -m 644 "$d/postgres.sql" /etc/ckman/dbscript/postgres.sql
install -m 644 "$d/ckman.service" /etc/systemd/system/ckman.service
install -m 755 "$d/ckman" /usr/local/bin/ckman
chown -R ckman:ckman /etc/ckman /var/log/ckman
chmod 750 /etc/ckman /var/log/ckman
rm -rf "$d"

systemctl daemon-reload
systemctl enable ckman >/dev/null 2>&1
systemctl restart ckman
sleep 3
systemctl --no-pager --lines=5 status ckman
REMOTE

echo
echo "Deployed $version. ckman listens on port 8808 on all interfaces;"
echo "see FORK.md before exposing it."
