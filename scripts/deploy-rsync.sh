#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 6 ]]; then
  echo "Usage: deploy-rsync.sh PROJECT_ROOT HOST USER SERVICE_PATH PORT RELEASE_ID" >&2
  exit 2
fi

project_root="$1"
ssh_host="$2"
ssh_user="$3"
service_path="$4"
listen_port="$5"
release_id="$6"

[[ "$ssh_host" =~ ^[A-Za-z0-9.-]+$ ]] || { echo "Invalid SSH host" >&2; exit 2; }
[[ "$ssh_user" =~ ^[a-z_][a-z0-9_-]*$ ]] || { echo "Invalid SSH user" >&2; exit 2; }
[[ "$listen_port" =~ ^[0-9]+$ ]] || { echo "Invalid listen port" >&2; exit 2; }
(( listen_port >= 1 && listen_port <= 65535 )) || { echo "Invalid listen port" >&2; exit 2; }
[[ "$release_id" =~ ^[0-9TZ-]+[a-f0-9]{8}$ ]] || { echo "Invalid release id" >&2; exit 2; }

expected_prefix="/home/$ssh_user/services/"
service_path_pattern="^/home/$ssh_user/services/[A-Za-z0-9._-]+(/[A-Za-z0-9._-]+)*$"
if [[ ! "$service_path" =~ $service_path_pattern || "$service_path" == *".."* ]]; then
  echo "Service path must be a child of $expected_prefix" >&2
  exit 2
fi

remote="$ssh_user@$ssh_host"
remote_release="$service_path/releases/$release_id"

ssh -o BatchMode=yes "$remote" \
  'test -x "$HOME/.local/node/bin/node" && test -x "$HOME/.local/npm-global/bin/pm2"' || {
    echo "Remote runtime is missing. Run npm run deploy:bootstrap once." >&2
    exit 3
  }

ssh -o BatchMode=yes "$remote" "mkdir -p -- '$remote_release' '$service_path/shared'"

rsync --archive --compress --checksum \
  --chmod=Du=rwx,Dgo=rx,Fu=rw,Fgo=r \
  "$project_root/dist" \
  "$project_root/package.json" \
  "$project_root/package-lock.json" \
  "$project_root/ecosystem.config.cjs" \
  "$remote:$remote_release/"

ssh -o BatchMode=yes "$remote" bash -s -- \
  "$service_path" "$release_id" "$listen_port" <<'REMOTE_DEPLOY'
set -euo pipefail

service_path="$1"
release_id="$2"
listen_port="$3"
release_path="$service_path/releases/$release_id"
current_link="$service_path/current"
next_link="$service_path/current.next"
previous_release="$(readlink "$current_link" 2>/dev/null || true)"

export PATH="$HOME/.local/node/bin:$HOME/.local/npm-global/bin:$PATH"
export INKPULSE_LISTEN_HOST="127.0.0.1"
export INKPULSE_LISTEN_PORT="$listen_port"

runtime_environment="$service_path/shared/runtime.env"
if [[ -f "$runtime_environment" ]]; then
  if [[ -L "$runtime_environment" ]]; then
    echo "Refusing to source a symlinked runtime environment" >&2
    exit 4
  fi
  chmod 600 -- "$runtime_environment"
  set -a
  # shellcheck disable=SC1090
  source "$runtime_environment"
  set +a
fi

cd "$release_path"
npm ci --omit=dev --no-audit --no-fund

ln -sfn -- "releases/$release_id" "$next_link"
mv -Tf -- "$next_link" "$current_link"

rollback() {
  echo "Deployment health check failed; restoring the previous release." >&2
  if [[ -n "$previous_release" ]]; then
    ln -sfn -- "$previous_release" "$next_link"
    mv -Tf -- "$next_link" "$current_link"
    cd "$current_link"
    pm2 startOrReload ecosystem.config.cjs --env production --update-env || true
  else
    rm -f -- "$current_link"
    pm2 delete inkpulse >/dev/null 2>&1 || true
  fi
}
trap rollback ERR

cd "$current_link"
pm2 startOrReload ecosystem.config.cjs --env production --update-env

healthy=false
for _ in {1..10}; do
  if curl --fail --silent --show-error \
    "http://127.0.0.1:$listen_port/health" >/dev/null; then
    healthy=true
    break
  fi
  sleep 1
done

[[ "$healthy" == true ]]
pm2 save
trap - ERR

printf 'DEPLOYED_RELEASE=%s\n' "$release_id"
REMOTE_DEPLOY
