#!/bin/sh

# Runs `next dev` on localhost:3100 -- the live slot, the tab the user triages
# their real inbox in -- as a launchd user agent, so it starts at login and
# outlives every Claude session. Drive it through the npm run dev:* scripts; see
# README.md > Running the dev server in the background.
#
# It serves the primary checkout. The test lock (scripts/triage-test-lock.sh)
# points it at a worktree with `serve <dir>` for a hands-on look, and back again
# on release. Nothing else should call `serve`: it bypasses the lock.
#
# TRIAGE_DEV_LABEL, TRIAGE_DEV_PLIST, TRIAGE_DEV_LOG and TRIAGE_DEV_PORT exist
# to exercise this script without touching the real agent. Give such a run a
# port of its own, never 3100: a refusal test there refuses only while
# something else holds the port, and when nothing does, the test job binds it
# and serves the live slot.

set -eu

label=${TRIAGE_DEV_LABEL:-com.raineorshine.github-triage.dev}
plist=${TRIAGE_DEV_PLIST:-$HOME/Library/LaunchAgents/$label.plist}
log=${TRIAGE_DEV_LOG:-$HOME/Library/Logs/github-triage-dev.log}
port=${TRIAGE_DEV_PORT:-3100}
domain="gui/$(id -u)"
service="$domain/$label"
log_max_bytes=5242880

die() {
  echo "dev-service: $*" >&2
  exit 1
}

# The primary checkout. From a worktree --git-common-dir points at the primary
# checkout's .git, whose parent is the directory the agent serves by default.
repo_dir() {
  script_dir=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
  if common_dir=$(git -C "$script_dir" rev-parse --path-format=absolute --git-common-dir 2>/dev/null); then
    dirname "$common_dir"
  else
    dirname "$script_dir"
  fi
}

# launchd starts jobs with a minimal PATH and without reading shell rc files, so
# the plist needs an absolute node. fnm's PATH entry is a per-shell shim under a
# directory named for the shell's pid and is gone after a reboot, so prefer
# fnm's default alias: it is stable and follows `fnm default <version>`.
node_bin() {
  if [ -n "${TRIAGE_NODE_BIN:-}" ]; then
    printf '%s\n' "$TRIAGE_NODE_BIN"
    return 0
  fi

  fnm_bin="${FNM_DIR:-$HOME/.fnm}/aliases/default/bin"
  active=$(command -v node 2>/dev/null || true)

  case "$active" in
    *fnm_multishells*)
      if [ -x "$fnm_bin/node" ]; then
        printf '%s\n' "$fnm_bin"
        return 0
      fi
      ;;
  esac

  if [ -n "$active" ]; then
    dirname "$(realpath "$active")"
    return 0
  fi

  for candidate in "$fnm_bin/node" /opt/homebrew/bin/node /usr/local/bin/node; do
    if [ -x "$candidate" ]; then
      dirname "$candidate"
      return 0
    fi
  done

  return 1
}

plist_value() {
  plutil -extract "$1" raw -o - "$plist" 2>/dev/null
}

# The checkout the agent serves, read back from the plist: after `serve` it is
# no longer necessarily the primary checkout.
served_dir() {
  plist_value WorkingDirectory
}

is_loaded() {
  launchctl print "$service" >/dev/null 2>&1
}

job_pid() {
  launchctl print "$service" 2>/dev/null |
    sed -n 's/^[[:space:]]*pid = \([0-9][0-9]*\)$/\1/p'
}

port_pid() {
  lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null | head -1
}

# Whether a pid is the agent's own process or one of its descendants. npm runs
# next as a child, and next serves from a forked next-server, so the process
# holding the port is not the pid launchd reports.
belongs_to_job() {
  candidate=$1
  job=$2
  attempts=0
  while [ -n "$candidate" ] && [ "$candidate" -gt 1 ] && [ "$attempts" -lt 10 ]; do
    [ "$candidate" = "$job" ] && return 0
    candidate=$(ps -o ppid= -p "$candidate" 2>/dev/null | tr -d ' ')
    attempts=$((attempts + 1))
  done
  return 1
}

# next dev takes an explicit port and exits when it is taken, so a foreign
# listener means a crash loop rather than a fallback port. Refuse up front.
require_free_port() {
  other=$(port_pid)
  [ -z "$other" ] && return 0
  pid=$(job_pid)
  [ -n "$pid" ] && belongs_to_job "$other" "$pid" && return 0
  die "port $port is held by pid $other ($(ps -o command= -p "$other" 2>/dev/null)) -- stop it first"
}

# A slot left on a worktree that was since removed has nothing to run, and
# launchd restarts it into the same failure however often it is kicked.
require_served_dir() {
  served=$(served_dir || true)
  [ -d "$served" ] || die "the checkout it serves is gone ($served) -- npm run dev:install points it back at the main checkout"
}

require_checkout() {
  dir=$1
  [ -f "$dir/package.json" ] || die "no package.json in $dir"
  [ -d "$dir/node_modules" ] || die "no node_modules in $dir -- run npm install there first"
  [ -e "$dir/.env.local" ] || die "no .env.local in $dir -- the inbox would render a token error (see README.md > Setup)"
}

write_plist() {
  bin=$1
  dir=$2
  mkdir -p "$(dirname "$plist")" "$(dirname "$log")"
  cat >"$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>$bin/node</string>
    <string>$bin/npm</string>
    <string>run</string>
    <string>dev</string>
    <string>--</string>
    <string>--port</string>
    <string>$port</string>
  </array>
  <key>WorkingDirectory</key>
  <string>$dir</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$bin:/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ProcessType</key>
  <string>Interactive</string>
  <key>StandardOutPath</key>
  <string>$log</string>
  <key>StandardErrorPath</key>
  <string>$log</string>
</dict>
</plist>
PLIST
  plutil -lint "$plist" >/dev/null || die "generated an invalid plist: $plist"
}

load() {
  # The agent appends to the log forever; truncate it here, while nothing holds
  # the file open, rather than letting it grow without bound.
  if [ -f "$log" ] && [ "$(wc -c <"$log")" -gt "$log_max_bytes" ]; then
    : >"$log"
  fi
  if ! out=$(launchctl bootstrap "$domain" "$plist" 2>&1); then
    die "launchctl bootstrap failed: ${out:-unknown error}"
  fi
}

unload() {
  out=$(launchctl bootout "$service" 2>&1) || case "$out" in
    # bootout reports EINPROGRESS while the job is still winding down
    *'in progress'*) ;;
    *) die "launchctl bootout failed: ${out:-unknown error}" ;;
  esac

  attempts=0
  while [ "$attempts" -lt 50 ] && is_loaded; do
    sleep 0.1
    attempts=$((attempts + 1))
  done

  # The next load binds the same port, and a server still letting go of it
  # would send the new one into a crash-and-throttle loop.
  attempts=0
  while [ "$attempts" -lt 50 ] && [ -n "$(port_pid)" ]; do
    sleep 0.1
    attempts=$((attempts + 1))
  done
}

# next needs a moment to bind after launchd forks the job. Wait for the port to
# be held by this job specifically: right after a reload the old server can
# still be letting go of it.
wait_for_port() {
  attempts=0
  while [ "$attempts" -lt 150 ]; do
    pid=$(job_pid)
    listener=$(port_pid)
    if [ -n "$pid" ] && [ -n "$listener" ] && belongs_to_job "$listener" "$pid"; then
      return 0
    fi
    sleep 0.1
    attempts=$((attempts + 1))
  done
}

cmd_install() {
  dir=$(repo_dir)
  require_checkout "$dir"
  bin=$(node_bin) || die 'could not find node -- set TRIAGE_NODE_BIN to its bin directory'
  [ -x "$bin/node" ] || die "no node executable in $bin"
  [ -e "$bin/npm" ] || die "no npm in $bin"

  require_free_port
  if is_loaded; then
    unload
  fi
  write_plist "$bin" "$dir"
  load

  echo "dev-service: installed $plist"
  echo "dev-service: using node $("$bin/node" -v) from $bin"
  echo 'dev-service: it will now start automatically at login'
  wait_for_port
  cmd_status
}

cmd_uninstall() {
  if is_loaded; then
    unload
  fi
  if [ -f "$plist" ]; then
    rm "$plist"
    echo "dev-service: removed $plist"
  else
    echo 'dev-service: not installed'
  fi
}

cmd_start() {
  [ -f "$plist" ] || die 'not installed -- run npm run dev:install'
  require_served_dir
  if is_loaded; then
    launchctl kickstart "$service" >/dev/null 2>&1 || true
  else
    require_free_port
    load
  fi
  wait_for_port
  cmd_status
}

cmd_stop() {
  if is_loaded; then
    unload
    echo 'dev-service: stopped (it starts again at your next login, or run npm run dev:start)'
  else
    echo 'dev-service: not running'
  fi
}

cmd_restart() {
  [ -f "$plist" ] || die 'not installed -- run npm run dev:install'
  require_served_dir
  require_free_port
  if is_loaded; then
    unload
  fi
  load
  wait_for_port
  cmd_status
}

# Point the agent at another checkout and (re)start it there. Called by the test
# lock's install and release; the node it runs is the one install resolved.
cmd_serve() {
  [ -f "$plist" ] || die 'not installed -- run npm run dev:install'
  [ -n "${1:-}" ] || die 'usage: serve <checkout>'
  dir=$(CDPATH='' cd -- "$1" && pwd) || die "no such directory: $1"
  require_checkout "$dir"
  node=$(plist_value ProgramArguments.0) || die "cannot read the node path from $plist"
  bin=$(dirname "$node")

  require_free_port
  if is_loaded; then
    unload
  fi
  write_plist "$bin" "$dir"
  load
  wait_for_port
  pid=$(job_pid)
  listener=$(port_pid)
  if [ -n "$pid" ] && [ -n "$listener" ] && belongs_to_job "$listener" "$pid"; then
    echo "dev-service: serving $dir on port $port"
  else
    die "started, but nothing of this service is listening on port $port -- see $log"
  fi
}

cmd_status() {
  if [ ! -f "$plist" ]; then
    echo 'service:  not installed (run npm run dev:install)'
    return 0
  fi

  echo "service:  installed ($label)"

  pid=$(job_pid)
  if [ -n "$pid" ]; then
    echo "state:    running (pid $pid)"
  elif is_loaded; then
    echo 'state:    loaded but not running (see the log)'
  else
    echo 'state:    stopped'
  fi

  served=$(served_dir || true)
  if [ ! -d "$served" ]; then
    echo "serving:  $served (gone -- npm run dev:install points it back at the main checkout)"
  elif [ "$served" = "$(repo_dir)" ]; then
    echo "serving:  $served (the main checkout)"
  else
    echo "serving:  $served (a worktree -- see scripts/triage-test-lock.sh status)"
  fi

  listener=$(port_pid)
  if [ -z "$listener" ]; then
    echo "port:     $port is not listening"
  elif [ -n "$pid" ] && belongs_to_job "$listener" "$pid"; then
    echo "port:     $port is listening"
  else
    echo "port:     $port is listening, but held by pid $listener, which is not this service"
  fi

  echo "log:      $log"
}

cmd_logs() {
  [ -f "$log" ] || die "no log yet at $log"
  if [ "$#" -gt 0 ]; then
    tail "$@" "$log"
  else
    tail -n 50 -f "$log"
  fi
}

# Machine-readable answers for the test lock.
cmd_serving() {
  [ -f "$plist" ] || exit 1
  served_dir
}

# Loaded, not "has a pid": `stop` and `start` act on loaded, and a job between
# KeepAlive respawns has no pid while still being one to stop.
cmd_running() {
  is_loaded
}

command=${1:-}
[ "$#" -gt 0 ] && shift

case "$command" in
  install) cmd_install "$@" ;;
  uninstall) cmd_uninstall "$@" ;;
  start) cmd_start "$@" ;;
  stop) cmd_stop "$@" ;;
  restart) cmd_restart "$@" ;;
  serve) cmd_serve "$@" ;;
  status) cmd_status "$@" ;;
  logs) cmd_logs "$@" ;;
  serving) cmd_serving "$@" ;;
  running) cmd_running "$@" ;;
  *)
    echo 'usage: scripts/dev-service.sh install|uninstall|start|stop|restart|status|logs' >&2
    exit 1
    ;;
esac
