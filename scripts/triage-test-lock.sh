#!/bin/sh
# Mutex for the live slot: http://localhost:3100.
#
# There is one URL the user keeps open, and one launchd agent serving it
# (scripts/dev-service.sh). A worktree edits, typechecks, builds and runs its
# own dev server on a private port freely, but putting a branch *at* that URL
# means pointing the agent at the worktree -- and while it does, the tab the user
# triages their real inbox in is running unshipped code. One URL, one pair of
# eyes: editing is parallel, testing is serial.
#
# What the agent served before is recorded inside the lock -- which checkout,
# and whether it was running -- so release points it back at exactly that, and
# a lock abandoned by a dead session is still recoverable by `break`.
#
#   acquire [label] [session]
#                     take the lock and record what the live slot serves;
#                     `session` names the Claude session holding it, so a denied
#                     request can say which chat to go to (falls back to
#                     $TRIAGE_SESSION)
#   wait [label] [session]
#                     acquire if it is free, otherwise take a ticket and block
#                     until it is. No polling and no loop to write: the release
#                     wakes the oldest waiter through a fifo. Run it in the
#                     background and the session is told the moment it holds the
#                     lock; interrupting it leaves the queue. It is bounded:
#                     after $TRIAGE_WAIT_STALE (30m) it gives up and reports
#                     what it was waiting on, whatever the reason.
#   install           point the live slot at this worktree and wait until the
#                     page answers; refused unless this session holds the lock
#   release           point the live slot back at what it served before, and
#                     drop the lock
#                     --keep     drop the lock, leave the live slot as it is
#                     --force    restore even if the live slot changed
#                     --if-mine  no-op unless this session took the lock
#   status            who holds it, since when, whether stale, who is queued
#   break             force-release a lock left behind by a dead session
#   dequeue           clear the queue; the recovery for a ticket that cannot be
#                     pruned, which `break` does not touch
#
# TRIAGE_ROOT and TRIAGE_SERVICE point the lock and the service it drives
# elsewhere, so all of it can be exercised from a scratch git repo against a
# stub that keeps the served checkout in a file. A harness that sets a variable
# in front of a shell function call keeps it set afterwards under sh, so give
# each call's overrides a subshell of their own.
#
# The handoff is only as good as the holder's copy of this script: a worktree on
# a branch from before a change to the queue releases the way its own copy
# says, and a waiter that expects otherwise sleeps until some other session
# releases. Rebasing that worktree on main is what fixes it.
set -eu

ROOT=${TRIAGE_ROOT:-$(git worktree list --porcelain | head -1 | sed 's/^worktree //')}
LOCK="$ROOT/.claude/triage-test.lock"
# Outside the lock directory, which release deletes: the queue has to outlive
# the handoff it exists to order.
QUEUE="$ROOT/.claude/triage-test.queue"
STALE_SECONDS=${TRIAGE_LOCK_STALE:-1800}
# How long a `wait` waits before giving up. Its own value, not STALE_SECONDS:
# `break` documents TRIAGE_LOCK_STALE=0 for forcing a live lock open, and a
# shell that exports that must not turn every wait into an instant refusal.
WAIT_STALE=${TRIAGE_WAIT_STALE:-1800}
LIVE_PORT=${TRIAGE_DEV_PORT:-3100}
SERVICE=${TRIAGE_SERVICE:-$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)/dev-service.sh}

SELF=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
# The worktree identifies the owner, but the user's question when a request is
# denied is "which of my chats is that?" -- so record the session too. The id is
# in the environment -- the desktop app's host id, or the CLI's own where there
# is no host -- and the human-readable title is not, so the caller passes it.
SESSION_ID=${CLAUDE_CODE_HOST_SESSION_ID:-${CLAUDE_CODE_SESSION_ID:-}}

die() { printf '%s\n' "$*" >&2; exit 1; }
field() { cat "$LOCK/$1" 2>/dev/null || printf '(unknown)'; }
age() {
  # Read fresh, never once at startup: a waiting session asks this from a loop
  # it entered long ago, and a lock that never appears to age is a lock `break`
  # never reaches. A lock not yet stamped is being taken right now, so age 0.
  now=$(date +%s)
  held=$(cat "$LOCK/acquired" 2>/dev/null || printf '%s' "$now")
  printf '%s' $(( now - held ))
}
holder_report() {
  printf 'held by   %s\n' "$(field label)"
  printf 'session   %s\n' "$(field session)"
  if [ -s "$LOCK/session_id" ]; then printf 'session id %s\n' "$(field session_id)"; fi
  printf 'worktree  %s\n' "$(field worktree)"
  printf 'branch    %s\n' "$(field branch)"
  printf 'age       %sm (stale after %sm)\n' "$(( $(age) / 60 ))" "$(( STALE_SECONDS / 60 ))"
}
# The worktree says who owns the lock, and when both sides know their session
# it has to be the same session too: two chats can share a worktree, and one of
# them holding the lock is not the other one's turn. Either side missing an id
# falls back to the worktree alone -- a plain shell.
owned() {
  [ "$(field worktree)" = "$SELF" ] || return 1
  [ -n "$SESSION_ID" ] && [ -s "$LOCK/session_id" ] || return 0
  [ "$(field session_id)" = "$SESSION_ID" ]
}
# STALE_SECONDS=0 means "treat any lock as abandoned" -- the documented override
# for breaking a live lock once the user has confirmed nobody is mid-test.
is_stale() { [ "$(age)" -ge "$STALE_SECONDS" ]; }

# --- the live slot -----------------------------------------------------------

served() { "$SERVICE" serving 2>/dev/null; }
service_running() { "$SERVICE" running 2>/dev/null; }

require_service() {
  [ -x "$SERVICE" ] || die "no dev service script at $SERVICE"
  served >/dev/null || die 'the dev service is not installed, so there is no live slot to test in.
Set it up with `npm run dev:install` (README.md > Running the dev server in the background).'
}

# Put the live slot back the way the lock found it: the same checkout, running
# or not. A checkout that has since been removed -- a worktree left in the slot
# by `release --keep` -- is replaced by the main checkout, which is the slot's
# resting state, rather than pointing the agent at a directory that is gone.
restore() {
  pre=$(field served_pre)
  if [ ! -d "$pre" ]; then
    printf 'what the slot served before (%s) is gone -- serving the main checkout instead\n' "$pre" >&2
    pre=$ROOT
  fi
  if [ "$(served || true)" != "$pre" ]; then
    "$SERVICE" serve "$pre" >/dev/null || return 1
    printf 'live slot serves %s again\n' "$pre"
  fi
  if [ "$(field was_running)" = no ]; then
    if service_running; then "$SERVICE" stop >/dev/null || return 1; fi
  elif ! service_running; then
    "$SERVICE" start >/dev/null || return 1
  fi
}

# Positive confirmation that the served tree renders, not only that a port is
# open. The first request compiles the page and reads the inbox, so this is also
# the wait for that. The page catches a failed listing and renders its own error
# with a 200, so the body is checked for that too. Either failure is the branch
# failing in the slot, which is a result, not an install failure.
answer() {
  out=$(curl -s --max-time 120 -w '\n%{http_code}' "http://localhost:$LIVE_PORT/" || true)
  code=$(printf '%s\n' "$out" | tail -n 1)
  if [ "$code" != 200 ]; then
    printf 'installed, but localhost:%s answered %s -- see npm run dev:logs\n' "$LIVE_PORT" "${code:-nothing}" >&2
  # The heading src/app/page.tsx renders when listing the notifications fails.
  elif printf '%s' "$out" | grep -q 'Could not load notifications'; then
    printf 'installed, but the page says it could not load notifications -- look at it\n' >&2
  else
    printf 'installed -- localhost:%s answers 200\n' "$LIVE_PORT"
  fi
}

# The dev server already running in a checkout, if any. Next writes its pid and
# URL into <distDir>/lock and removes the file on exit, so a live pid there is a
# live server; `next dev` uses .next/dev as its distDir.
dev_lock_holder() {
  for f in "$1/.next/dev/lock" "$1/.next/lock"; do
    [ -s "$f" ] || continue
    pid=$(sed -n 's/.*"pid":\([0-9][0-9]*\).*/\1/p' "$f")
    [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null || continue
    url=$(sed -n 's/.*"appUrl":"\([^"]*\)".*/\1/p' "$f")
    printf 'pid %s%s' "$pid" "${url:+, $url}"
    return 0
  done
}


# --- the queue ---------------------------------------------------------------
#
# A session that found the lock held used to have nothing to do but ask again
# later. It takes a ticket instead and blocks on a fifo, so the kernel wakes it
# the moment the holder releases: a waiting session costs nothing while it
# waits, and the handoff has no gap for a third session to walk into.
#
# The order is arrival order and the handoff is addressed. A release signals
# exactly one ticket -- the oldest whose session is still alive -- and `take_lock`
# refuses anyone who is not at the head, so waiters neither race for the freed
# lock nor overtake each other. Nothing wedges if a signal misses: the woken
# session re-checks the lock rather than trusting the wake, and a lock taken by
# someone else just means waiting for that session's release to signal again.
#
# A ticket is identified by the process waiting on it, so a session killed
# mid-wait is pruned by the next scan instead of stalling everyone behind it.

# Tickets in arrival order, dropping any whose waiter is gone. A ticket is named
# `<position>.<pid>`, so it is complete the instant it exists: a directory
# claimed by a session that dies before it can describe itself is recognisably
# dead rather than a head everyone else has to queue behind forever.
queue_prune() {
  [ -d "$QUEUE" ] || return 0
  for t in $(ls "$QUEUE" 2>/dev/null | sort -t. -k1,1n -k2,2n); do
    # Anything not shaped `<position>.<pid>` is not a ticket -- a directory made
    # by hand, say. Reading its name as a pid would have it look alive whenever
    # some unrelated process owns that number, and it would sit at the head
    # refusing everyone.
    case $t in *.*) ;; *) rm -rf "$QUEUE/$t"; continue ;; esac
    kill -0 "${t#*.}" 2>/dev/null && printf '%s\n' "$t" || rm -rf "$QUEUE/$t"
  done
}
# Not `queue_prune | head -1`: closing that pipe early leaves a broken-pipe
# error in the middle of an otherwise clean wait.
queue_head() { set -- $(queue_prune); printf '%s\n' "${1:-}"; }
queue_report() {
  for t in $(queue_prune); do
    printf 'waiting   #%s  %s [%s]\n' \
      "${t%%.*}" "$(cat "$QUEUE/$t/session" 2>/dev/null)" "$(cat "$QUEUE/$t/label" 2>/dev/null)"
  done
}

# Wake one ticket. The fifo is opened read-write (`1<>`), which for a fifo never
# blocks -- so a release can never be held up by a waiter that died between the
# liveness check and the write, and a byte written just before a waiter blocks
# is still there when it reads.
wake_ticket() {
  [ -p "$QUEUE/$1/fifo" ] || return 0
  printf 'go\n' 1<>"$QUEUE/$1/fifo" 2>/dev/null || true
}

queue_signal() { wake_ticket "$(queue_head)"; }

# Send everyone home. The marker is what a waiter acts on: unlinking a fifo
# gives the process blocked on it no end-of-file, so a ticket that is only
# deleted leaves its session asleep for good, and the wake has to reach the
# waiter whether it gets there before or after the tickets go.
queue_dismiss() {
  for t in $(queue_prune); do
    : > "$QUEUE/$t/cleared" 2>/dev/null || true
    wake_ticket "$t"
  done
}

# Become the holder, or return 1 having changed nothing. The caller reports the
# denial, which differs between `acquire` and `wait`. $3 is the caller's own
# ticket if it has one: only the head of the queue may take a free lock, so an
# unticketed acquire falls in behind sessions that are already waiting rather
# than jumping them.
take_lock() {
  if [ -d "$LOCK" ]; then
    owned || return 1
    # Re-acquiring must not re-record: the snapshot would capture this branch
    # in the slot, and release would leave it there.
    printf 'already held by this worktree (snapshot preserved)\n'
    return 0
  fi
  head=$(queue_head)
  [ -z "$head" ] || [ "$head" = "${3:-}" ] || return 1
  mkdir -p "$(dirname "$LOCK")"
  mkdir "$LOCK" 2>/dev/null || return 1
  # Who owns it and when go in first, so a lock interrupted here is still one
  # its owner can release and one that ages into `break`'s reach. The time is
  # read here rather than once at startup: a `wait` reaches this long after it
  # started, and a lock stamped with the start would be born half-stale.
  printf '%s\n' "$SELF" > "$LOCK/worktree"
  printf '%s\n' "$(date +%s)" > "$LOCK/acquired"
  printf '%s\n' "$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo '(detached)')" > "$LOCK/branch"
  printf '%s\n' "$1" > "$LOCK/label"
  printf '%s\n' "$2" > "$LOCK/session"
  printf '%s\n' "$SESSION_ID" > "$LOCK/session_id"
  if service_running; then printf 'yes\n'; else printf 'no\n'; fi > "$LOCK/was_running"
  # Last and whole: a lock without this is one release refuses to restore from,
  # rather than one that points the live slot at an empty path.
  served > "$LOCK/served.tmp" && mv "$LOCK/served.tmp" "$LOCK/served_pre" || rm -f "$LOCK/served.tmp"
  printf 'acquired -- the live slot serves %s (%srunning)\n' \
    "$(field served_pre)" "$([ "$(field was_running)" = yes ] || printf 'not ')"
  # The record is restored faithfully, so a slot left on some worktree -- by a
  # `release --keep`, say -- goes back there after every test. Say so while it
  # is one lock wide, rather than let it outlive the worktree.
  if [ -s "$LOCK/served_pre" ] && [ "$(field served_pre)" != "$ROOT" ]; then
    printf 'note: that is not the main checkout, and release will put it back there\n'
  fi
}

cmd=${1:-status}
LABEL=${2:-$(basename "$SELF")}
SESSION=${3:-${TRIAGE_SESSION:-(unnamed session)}}
case "$cmd" in

  acquire)
    require_service
    take_lock "$LABEL" "$SESSION" && exit 0
    if [ -d "$LOCK" ]; then
      printf 'LOCKED -- the session "%s" is testing.\n' "$(field session)" >&2
      holder_report >&2
      is_stale && printf '\nLock is stale; `break` it after confirming with the user.\n' >&2
    else
      printf 'QUEUED AHEAD -- the lock is free but older waiters have it promised.\n' >&2
      queue_report >&2
    fi
    printf '\n`%s wait` takes it as soon as it is your turn.\n' "$0" >&2
    exit 1
    ;;

  wait)
    require_service
    take_lock "$LABEL" "$SESSION" && exit 0

    # Take the ticket before looking again: enqueued first, a release racing
    # this can only signal a fifo nobody is reading yet, and the byte waits in
    # the pipe. Enqueued after, the signal would have gone to whoever was ahead
    # and this session would sleep through its own turn.
    mkdir -p "$QUEUE"
    STAGE="$QUEUE/.new.$$"
    TICKET="$STAGE"
    WAKE=
    ALARM=
    CANCEL=
    # However this ends, the ticket goes and the turn is passed on: a wait that
    # simply disappears leaves the sessions behind it asleep on a lock nobody
    # holds. `|| true` throughout, because set -e is in force inside a trap too
    # and the kills fail whenever the children were already reaped.
    trap 'st=$?; rm -rf "$TICKET" || true; kill $WAKE $ALARM 2>/dev/null || true; \
          [ -d "$LOCK" ] || queue_signal || true; \
          rmdir "$QUEUE" 2>/dev/null || true; exit $st' EXIT
    # A signal raises a flag rather than exiting where it lands. A trap runs
    # only between commands, and the command in progress is either a blocking
    # read -- which is why the read is a child, so the wait on it is
    # interruptible -- or an acquire that must not be abandoned half-made.
    trap 'CANCEL=1' INT TERM HUP

    rm -rf "$STAGE"
    mkdir "$STAGE"
    printf '%s\n' "$SELF" > "$STAGE/worktree"
    printf '%s\n' "$LABEL" > "$STAGE/label"
    printf '%s\n' "$SESSION" > "$STAGE/session"
    mkfifo "$STAGE/fifo"
    # Held open read-write for the whole wait, so a signal has somewhere to land
    # even in the moment between two blocking reads.
    exec 3<>"$STAGE/fifo"

    last=$(queue_prune | tail -1); last=${last%%.*}
    TICKET_N=$(( ${last:-0} + 1 ))
    # The ticket arrives complete, fifo and all, in one rename: it can never be
    # the head of the queue in a state where a release finds nothing to signal.
    # The name carries this pid, so the only way the target is taken is two
    # sessions asking for the same position at once.
    tries=0
    while ! mv "$STAGE" "$QUEUE/$TICKET_N.$$" 2>/dev/null; do
      # `dequeue` takes the whole directory, this ticket in the making with it.
      [ -d "$STAGE" ] || die 'the queue was cleared while this ticket was being made -- run `wait` again'
      mkdir -p "$QUEUE" || die "cannot create the queue at $QUEUE"
      TICKET_N=$(( TICKET_N + 1 ))
      tries=$(( tries + 1 ))
      [ "$tries" -lt 100 ] || die "cannot claim a place in the queue at $QUEUE"
    done
    TICKET="$QUEUE/$TICKET_N.$$"

    printf 'queued at #%s behind:\n' "$TICKET_N" >&2
    [ -d "$LOCK" ] && holder_report >&2 || true
    queue_report >&2

    # The wait is bounded, and one alarm is what makes the bound arrive. Every
    # way this could hang -- a holder whose session died, a signal that reached
    # nobody, a queue that stopped moving -- ends here instead of in a session
    # parked for good. Killing the waiter outright leaves the alarm to sleep out
    # its interval; it holds nothing, and a stray `sleep` afterwards is this.
    DEADLINE=$(( $(date +%s) + WAIT_STALE ))
    ( exec 3<&-; sleep "$WAIT_STALE"; printf 'go\n' 1<>"$TICKET/fifo" ) & ALARM=$!

    while :; do
      had_lock=; [ -d "$LOCK" ] && had_lock=1 || true
      if take_lock "$LABEL" "$SESSION" "$TICKET_N.$$"; then
        # A cancelled wait must not walk off holding the lock it was handed: the
        # live slot would be parked on a session that is no longer doing
        # anything. A lock it was already holding is not this wait's to drop.
        [ -n "$CANCEL" ] && [ -z "$had_lock" ] || exit 0
        rm -rf "$LOCK"
        printf 'cancelled -- dropped the lock it had just been handed\n' >&2
        exit 130
      fi
      [ -z "$CANCEL" ] || exit 130
      if [ "$(date +%s)" -ge "$DEADLINE" ]; then
        printf 'GAVE UP -- %sm at #%s in the queue.\n' "$(( WAIT_STALE / 60 ))" "$TICKET_N" >&2
        [ -d "$LOCK" ] && holder_report >&2 \
          || printf 'the lock is free and the queue is not moving\n' >&2
        printf '\nTake it to the user: `%s status`, then `break` or `dequeue`.\n' "$0" >&2
        exit 1
      fi
      # `dequeue` cleared the queue: nothing will be written to this fifo again,
      # so say so rather than sleep on it for good.
      [ -p "$TICKET/fifo" ] && [ ! -e "$TICKET/cleared" ] \
        || die 'this ticket was cleared -- run `wait` again to requeue'
      # Blocks in the kernel until a release hands this ticket the lock. A wake
      # is a prompt to try, not a promise: the loop re-checks and waits again.
      #
      # The child closes fd 3 and opens the fifo for reading only, so the write
      # end stays with the parent alone. Inheriting it would leave the child
      # blocked for good on a fifo it was itself keeping open, every time a
      # waiter is killed outright.
      ( exec 3<&-; read _ < "$TICKET/fifo" ) & WAKE=$!
      wait "$WAKE" || true
    done
    ;;

  install)
    require_service
    # Unlike an app slot there is no lock-free install: pointing the live slot
    # at a branch is the whole of what the lock guards, and a session working in
    # the main checkout needs no install -- the slot already serves its tree.
    [ -d "$LOCK" ] || die 'no lock held -- take it with `wait` first'
    if ! owned; then
      printf 'REFUSED -- the session "%s" has the live slot.\n' "$(field session)" >&2
      holder_report >&2
      exit 1
    fi
    [ -d "$SELF/node_modules" ] || die "no node_modules in $SELF -- run npm install first"
    # The token lives in the main checkout's .env.local, which is gitignored and
    # so absent from every worktree. Link it rather than copy it: one file to
    # rotate, and nothing new holding the secret.
    if [ ! -e "$SELF/.env.local" ] && [ ! -L "$SELF/.env.local" ]; then
      ln -s "$ROOT/.env.local" "$SELF/.env.local"
      printf 'linked .env.local from the main checkout\n'
    fi
    # Next allows one dev server per checkout, and a second exits the moment it
    # finds the first one's lock -- which here would be the agent, crash looping
    # behind a private-port preview that is still up. The agent's own server is
    # the exception: re-installing restarts it.
    if [ "$(served || true)" != "$SELF" ]; then
      holder=$(dev_lock_holder "$SELF")
      [ -z "$holder" ] || die "a next dev server is already running in $SELF ($holder).
Stop it first -- preview_stop, for a Browser pane preview -- then install again."
    fi
    # Recorded before the re-point, not after: `serve` rewrites the agent's
    # checkout before the point where it can fail, and a failure recorded after
    # would look to `release` like someone else moving the slot.
    printf '%s\n' "$SELF" > "$LOCK/installed"
    if ! "$SERVICE" serve "$SELF"; then
      if restore >/dev/null 2>&1; then
        rm -f "$LOCK/installed"
        die 'install failed -- the slot is back on what it served before; see npm run dev:logs'
      fi
      die 'install failed, and putting the slot back failed too -- see npm run dev:status'
    fi
    answer
    ;;

  release)
    mode=${2:-}
    # `ship` releases only a lock this session took. A branch that was never
    # tested holds no lock, and another session's lock is theirs to restore --
    # neither is worth a message, so both exit quietly. "This session" is what
    # owned() says, so a session with no id still releases its worktree's lock.
    if [ "$mode" = "--if-mine" ]; then
      [ -d "$LOCK" ] && owned || exit 0
      mode=
    fi
    [ -d "$LOCK" ] || { printf 'no lock held\n'; exit 0; }
    owned || { printf 'lock held by another session; refusing to release:\n' >&2; holder_report >&2; exit 1; }

    if [ "$mode" = "--keep" ]; then
      rm -rf "$LOCK"
      queue_signal
      printf 'lock dropped; live slot left as it is\n'
      exit 0
    fi

    [ -s "$LOCK/served_pre" ] || die "the lock never recorded what the live slot served (the acquire
was interrupted), so there is nothing to restore. Drop it and leave the slot alone
with: $0 release --keep"

    # What the slot should serve right now: this worktree if it was installed,
    # or what it served at the acquire if not. Already back on what it served
    # before -- a `dev:install` by hand, or a restore that got that far before
    # failing -- is not drift either: restoring changes nothing about it.
    # Anything else means someone re-pointed it underneath us, and restoring
    # blindly would undo that.
    if [ -s "$LOCK/installed" ]; then expected=$(field installed); else expected=$(field served_pre); fi
    current=$(served || true)
    if [ "$mode" != "--force" ] && [ "$current" != "$expected" ] && [ "$current" != "$(field served_pre)" ]; then
      printf 'The live slot changed since this lock was taken: it serves %s.\n' "${current:-nothing}" >&2
      printf 'Restoring would point it away from that.\n\n' >&2
      printf '  keep the live slot as it is:  %s release --keep\n' "$0" >&2
      printf '  restore anyway:               %s release --force\n' "$0" >&2
      exit 1
    fi

    restore || die 'could not put the live slot back -- see npm run dev:status; the lock is still held'
    rm -rf "$LOCK"
    queue_signal
    printf 'released\n'
    ;;

  dequeue)
    # `break` recovers the lock; this recovers the queue. Needed when a ticket
    # cannot be pruned -- a pid the waiter no longer owns, reused across a
    # reboot -- which otherwise refuses every acquire and blocks every wait.
    [ -d "$QUEUE" ] || { printf 'queue is empty\n'; exit 0; }
    queue_report
    queue_dismiss
    rm -rf "$QUEUE"
    printf 'queue cleared -- the sessions that were waiting have been told to requeue\n'
    ;;

  status)
    if [ -d "$LOCK" ]; then
      owned && printf 'LOCKED by this worktree\n' || printf 'LOCKED by another session\n'
      holder_report
      is_stale && printf 'STALE -- presumed abandoned\n'
    else
      printf 'unlocked\n'
    fi
    current=$(served || true)
    printf 'live slot %s\n' "${current:-(dev service not installed)}"
    queue_report
    exit 0
    ;;

  break)
    [ -d "$LOCK" ] || { printf 'no lock held\n'; exit 0; }
    if ! is_stale; then
      printf 'Lock is only %sm old and may still be in use:\n' "$(( $(age) / 60 ))" >&2
      holder_report >&2
      printf 'Confirm with the user, then re-run with TRIAGE_LOCK_STALE=0.\n' >&2
      exit 1
    fi
    # A lock with no record was interrupted mid-acquire. The main checkout is
    # the slot's resting state, so that is where an abandoned one goes back to.
    [ -s "$LOCK/served_pre" ] || printf '%s\n' "$ROOT" > "$LOCK/served_pre"
    if restore; then
      printf 'restored the abandoned snapshot\n'
    else
      printf 'could not put the live slot back -- see npm run dev:status\n' >&2
    fi
    rm -rf "$LOCK"
    queue_signal
    printf 'lock broken\n'
    ;;

  *) die "unknown command: $cmd (acquire|wait|install|release|status|break|dequeue)" ;;
esac
