#!/bin/sh

# Runs the Auto Done sweep on a timer: a launchd user agent that POSTs to the
# live slot's /api/auto-done every five minutes -- scripts/dev-service.sh keeps
# the server there, and whatever it serves is what judges the inbox. Installed
# without --apply it is a dry run: the sweep only reports what it would mark
# done, to the audit log and the inbox's badges. With --apply it marks them
# done, which GitHub cannot undo.
#
#   install [--apply]   write the agent and start it; re-run to switch modes
#   uninstall           stop it and remove it
#   start | stop        without removing it
#   status              mode, interval, whether it is loaded, and the last sweep
#   run [--apply]       one sweep now, from the shell, printing the report
#   logs [tail args]    follow the audit log (-n 20 prints the tail and exits)
#
# The audit log is the app's, written by src/lib/sweep.ts: one JSON line per
# thread marked done -- or, dry-run, that would have been -- and one per sweep.
# The timer's own log holds a status line per run and nothing else.
#
# TRIAGE_AUTO_DONE_LABEL, _PLIST, _LOG, _INTERVAL and TRIAGE_DEV_PORT exist to
# exercise this script without touching the real agent; AUTO_DONE_LOG moves the
# audit log, and the app reads the same variable.

set -eu

label=${TRIAGE_AUTO_DONE_LABEL:-com.raineorshine.github-triage.auto-done}
plist=${TRIAGE_AUTO_DONE_PLIST:-$HOME/Library/LaunchAgents/$label.plist}
timer_log=${TRIAGE_AUTO_DONE_LOG:-$HOME/Library/Logs/github-triage-auto-done-timer.log}
audit_log=${AUTO_DONE_LOG:-$HOME/Library/Logs/github-triage-auto-done.jsonl}
interval=${TRIAGE_AUTO_DONE_INTERVAL:-300}
port=${TRIAGE_DEV_PORT:-3100}
domain="gui/$(id -u)"
service="$domain/$label"
endpoint="http://localhost:$port/api/auto-done"

die() {
  echo "auto-done: $*" >&2
  exit 1
}

# apply | dry-run, from an optional --apply
mode_arg() {
  case "${1:-}" in
    --apply) echo apply ;;
    '') echo dry-run ;;
    *) die "unknown option: $1" ;;
  esac
}

url_for() {
  if [ "$1" = apply ]; then
    printf '%s?apply=1\n' "$endpoint"
  else
    printf '%s\n' "$endpoint"
  fi
}

installed_mode() {
  if grep -q 'apply=1' "$plist" 2>/dev/null; then
    echo apply
  else
    echo dry-run
  fi
}

plist_value() {
  plutil -extract "$1" raw -o - "$plist" 2>/dev/null
}

is_loaded() {
  launchctl print "$service" >/dev/null 2>&1
}

write_plist() {
  url=$1
  mkdir -p "$(dirname "$plist")" "$(dirname "$timer_log")"
  # curl alone has no timestamp to print, so a shell prefixes one; the URL is
  # the only thing that differs between the two modes.
  cat >"$plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$label</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string>
    <string>-c</string>
    <string>printf '%s ' "\$(date -u +%Y-%m-%dT%H:%M:%SZ)"; /usr/bin/curl -sS -m 120 -o /dev/null -w '%{http_code} in %{time_total}s\n' -X POST '$url'</string>
  </array>
  <key>StartInterval</key>
  <integer>$interval</integer>
  <key>RunAtLoad</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$timer_log</string>
  <key>StandardErrorPath</key>
  <string>$timer_log</string>
</dict>
</plist>
PLIST
  plutil -lint "$plist" >/dev/null || die "generated an invalid plist: $plist"
}

load() {
  if ! out=$(launchctl bootstrap "$domain" "$plist" 2>&1); then
    die "launchctl bootstrap failed: ${out:-unknown error}"
  fi
}

unload() {
  out=$(launchctl bootout "$service" 2>&1) || case "$out" in
    *'in progress'*) ;;
    *) die "launchctl bootout failed: ${out:-unknown error}" ;;
  esac
  attempts=0
  while [ "$attempts" -lt 50 ] && is_loaded; do
    sleep 0.1
    attempts=$((attempts + 1))
  done
}

cmd_install() {
  mode=$(mode_arg "${1:-}")
  if is_loaded; then
    unload
  fi
  write_plist "$(url_for "$mode")"
  load
  echo "auto-done: installed $plist"
  echo "auto-done: $mode, every ${interval}s against $endpoint, starting at login"
  if [ "$mode" = apply ]; then
    echo 'auto-done: it marks threads done -- npm run auto-done:logs shows each one'
  else
    echo 'auto-done: dry run -- npm run auto-done:install -- --apply once the badges look right'
  fi
}

cmd_uninstall() {
  if is_loaded; then
    unload
  fi
  if [ -f "$plist" ]; then
    rm "$plist"
    echo "auto-done: removed $plist"
  else
    echo 'auto-done: not installed'
  fi
}

cmd_start() {
  [ -f "$plist" ] || die 'not installed -- run npm run auto-done:install'
  if is_loaded; then
    launchctl kickstart "$service" >/dev/null 2>&1 || true
  else
    load
  fi
  cmd_status
}

cmd_stop() {
  if is_loaded; then
    unload
    echo 'auto-done: stopped (npm run auto-done:start, or your next login, starts it again)'
  else
    echo 'auto-done: not running'
  fi
}

cmd_status() {
  if [ ! -f "$plist" ]; then
    echo 'timer:    not installed (run npm run auto-done:install)'
  else
    echo "timer:    installed ($label)"
    echo "mode:     $(installed_mode)"
    if is_loaded; then
      echo "state:    loaded, every $(plist_value StartInterval)s"
    else
      echo 'state:    stopped'
    fi
    echo "endpoint: $endpoint"
    echo "log:      $timer_log"
  fi
  echo "audit:    $audit_log"
  if [ -f "$audit_log" ]; then
    last=$(grep '"event":"sweep"' "$audit_log" | tail -n 1)
    [ -z "$last" ] || echo "last:     $last"
  fi
}

# Pretty-print the report with the node the project already needs, and pass it
# through untouched if it is not JSON (an HTML error page, say).
cmd_run() {
  mode=$(mode_arg "${1:-}")
  curl -sS -m 300 -X POST "$(url_for "$mode")" | node -e '
    let s = ""
    process.stdin.on("data", d => { s += d }).on("end", () => {
      try { console.log(JSON.stringify(JSON.parse(s), null, 2)) } catch { process.stdout.write(s) }
    })'
}

cmd_logs() {
  [ -f "$audit_log" ] || die "no audit log yet at $audit_log"
  if [ "$#" -gt 0 ]; then
    tail "$@" "$audit_log"
  else
    tail -n 20 -f "$audit_log"
  fi
}

command=${1:-}
[ "$#" -gt 0 ] && shift

case "$command" in
  install) cmd_install "$@" ;;
  uninstall) cmd_uninstall "$@" ;;
  start) cmd_start "$@" ;;
  stop) cmd_stop "$@" ;;
  status) cmd_status "$@" ;;
  run) cmd_run "$@" ;;
  logs) cmd_logs "$@" ;;
  *)
    echo 'usage: scripts/auto-done-service.sh install [--apply]|uninstall|start|stop|status|run [--apply]|logs' >&2
    exit 1
    ;;
esac
