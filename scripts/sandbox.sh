#!/usr/bin/env bash
# Starts or stops the full TransferHub sandbox (API, worker, web) from production builds.
#   scripts/sandbox.sh start    build, migrate, seed demo data if empty, start all three
#   scripts/sandbox.sh stop     stop all three
#   scripts/sandbox.sh status   show what is running
# Logs go to .sandbox/logs. Requires .env (copy .env.example).
set -euo pipefail
cd "$(dirname "$0")/.."
RUN=.sandbox
mkdir -p "$RUN/logs"

stop_one() {
  local name=$1
  if [[ -f "$RUN/$name.pid" ]]; then
    local pid
    pid=$(cat "$RUN/$name.pid")
    # Each service runs in its own process group (setsid), so this also stops child processes
    # such as next-server that a wrapper like pnpm starts.
    if kill -0 "$pid" 2>/dev/null; then kill -- "-$pid" 2>/dev/null || kill "$pid"; echo "stopped $name ($pid)"; fi
    rm -f "$RUN/$name.pid"
  fi
}

start_one() {
  local name=$1; shift
  setsid nohup "$@" >"$RUN/logs/$name.log" 2>&1 < /dev/null &
  echo $! >"$RUN/$name.pid"
  echo "started $name ($!)"
}

port_free() {
  ! (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null
}

case "${1:-}" in
  start)
    for port in 3000 "${API_PORT:-4000}"; do
      if ! port_free "$port"; then
        echo "Port $port is already in use. Run '$0 stop' or stop the process using it first." >&2
        exit 1
      fi
    done
    set -a; . ./.env; set +a
    pnpm build >/dev/null
    pnpm db:migrate
    pnpm db:seed
    start_one api node apps/api/dist/main.js
    start_one worker node apps/worker/dist/main.js
    start_one web pnpm --dir apps/web start
    sleep 6
    curl -fsS "http://localhost:${API_PORT:-4000}/health/ready" && echo
    echo "Open http://localhost:3000 — demo password Sandbox!2026"
    ;;
  stop)
    stop_one web; stop_one worker; stop_one api
    ;;
  status)
    for n in api worker web; do
      if [[ -f "$RUN/$n.pid" ]] && kill -0 "$(cat "$RUN/$n.pid")" 2>/dev/null; then echo "$n running"; else echo "$n stopped"; fi
    done
    ;;
  *)
    echo "usage: $0 start|stop|status" >&2; exit 2 ;;
esac
