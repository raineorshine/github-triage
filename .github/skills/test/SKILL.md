---
name: test
description: "Put this branch in front of the user at localhost:3100 by pointing the live dev server at this worktree under a mutex, so parallel sessions do not clobber each other. Use for any change the user would see or touch in the inbox -- the list, the rows, the sidebar filters, the thread actions, the styling -- once it passes on a private port, and invoke it as part of delivering that change, not only when asked to test."
---

# Test (serve this branch at the live URL)

There is one URL the user keeps open, `http://localhost:3100`, and one launchd agent serving it from
the main checkout (`scripts/dev-service.sh`). A worktree runs its own dev server on a private port
freely, but putting a branch in front of the user means pointing that agent at the worktree — and
while it does, the tab they triage their real inbox in is running unshipped code. **Editing is
parallel, the live slot is serial.**

`scripts/triage-test-lock.sh` is that mutex. It records what the agent served *inside the lock*
before re-pointing it — which checkout, and whether it was running — so release puts back exactly
that, and a lock abandoned by a dead session is still recoverable.

**Most of it needs neither the lock nor the user.** The worktree's own server on a private port,
driven with the Browser pane, answers whether the page renders, what the rows say and how they look.
The lock is for the last step: the user's own look, in their own tab.

**And that step does not wait to be asked for.** A change the user would see or touch is not
delivered by a clean build: what they would look at is not in their tab until step 5 has put it
there, so a turn that ends "try it and tell me" before the install has parked them in front of the
inbox they already had. Run this skill as the last step of building such a change, and hand it over
from inside the lock.

## Division of labor

| Where | What it holds | Rule |
|---|---|---|
| `localhost:3100` (the dev service) | the tab the user triages in; serves the main checkout | Never re-pointed by hand. Moved only by `install` and `release`. |
| this worktree's `next dev`, private port | this branch, for the Browser pane | Free, parallel, lock-free — but not while the slot serves this worktree: one `next dev` per checkout. |
| `.claude/triage-test.lock/` (main checkout) | the mutex, and what the slot served before | Held only while this branch is in the slot. |

**Acquire late, release fast.** Typecheck, lint, build and the private-port server need no lock.
Take it only once you are about to put the branch in the slot.

## Procedure

### 1. Verify on a private port

A worktree has no `.env.local` — it is gitignored — so link the main checkout's. A link rather than
a copy keeps one file to rotate and nothing new holding the secret. Never read or print it. A
worktree made without dependencies needs them too: npm resolves the main checkout's from inside a
nested worktree, so typecheck and lint would pass against the wrong tree while `next` itself fails.

```bash
MAIN=$(git worktree list | head -1 | awk '{print $1}')
[ -e .env.local ] || ln -s "$MAIN/.env.local" .env.local
[ -d node_modules ] || npm ci
npm run typecheck && npm run lint
```

Start this worktree's server with `preview_start` and the `github-triage (worktree)` configuration
from `.claude/launch.json`: it binds a free port, never 3100. Then check it with the Browser pane —
`read_console_messages` for errors, `read_page` for the rows and the sidebar counts, a screenshot for
anything visual. After a visible change, show the user that screenshot.

Stop the server with `preview_stop` and close its tab as soon as the check is done — not at the end
of the session. For as long as it runs, the Browser pane polls it with `HEAD /` every few seconds,
and each poll renders the page, which reads `/notifications`: measured, an idle preview spends about
a sixth of the hourly REST budget the user's own inbox runs on.

**One `next dev` per checkout.** Next locks `.next/dev/lock`, and a second server in the same
directory exits on sight. So this preview and the live slot cannot both run this worktree: the
preview has to be stopped before step 5, which refuses while it is up, and while the slot serves
this worktree the way to look at it is the `github-triage (live)` configuration.

### 2. Check the lock

```bash
./scripts/triage-test-lock.sh status
```

It prints the holder, what the live slot serves, and everyone queued. **Never wait in a loop** —
`wait` blocks in the kernel and the queue is ordered, so a polling loop would only burn turns and
jump people.

If it says the dev service is not installed, there is no live slot to test in. Stop at step 1's
result and tell the user `npm run dev:install` is what the rest needs.

### 3. Acquire

Prefix this session's title with `🔓 ` first (`set_session_title`, replacing any existing lifecycle
prefix — see AGENTS.md "Session titles"). Set it before the acquire, not after; if the wait comes
back without the lock, replace it with whatever is true instead — `🚙 ` when that goes to the user,
`⏳ ` when the work carries on. Do not report this.

Take it with `wait`, in the background, whether or not the lock looked free:

```bash
./scripts/triage-test-lock.sh wait "what you are testing" "<this session's title>"
```

Pass this session's title as the second argument (read it from `get_session` with `"self"`). It is
recorded alongside the host session id, so a session denied the lock can name the chat that holds
it instead of only its worktree.

Free lock: it acquires and exits immediately. Held: this session takes a ticket and blocks until its
turn, and the run exits — notifying the session — the moment it holds the lock. Run it with
`run_in_background` so the wait costs nothing; the notification is the signal to carry on at step 4.
Waiting sessions are served in arrival order, and a plain `acquire` refuses to jump them.

It can also come back without the lock, and the exit says which: `acquired` on the last line means
step 4. `GAVE UP` means the wait hit its half-hour bound — the report says what it was waiting on,
and that goes to the user rather than being broken open here. And `this ticket was cleared` means
someone ran `dequeue`; re-run `wait` to take a new place.

Re-running from the same session is a no-op and will not re-record, so an interrupted session can
resume — but a *second* session on the same worktree is queued like any other, not handed the first
one's lock.

Once it reports `acquired`, swap the prefix to `🔒 `. Do not report this.

**A queued session is parked, not idle.** Stay `🔓 ` — it means "about to take the lock" — and say
which session is ahead. Keep doing lock-free work on the private port in the meantime, and stop that
preview before step 5. Cancelling the background task leaves the queue.

### 4. Rebase on origin/main

Fetch and rebase every time, not only when the branch looks behind. Several ships can land during a
single session, and the slot serves what the worktree has, so installing without rebasing puts the
user's tab on code that `main` has already replaced — shipped features missing from their inbox for
as long as the lock is held. Whether it is behind is not a thing to judge from what the session
remembers: the fetch answers it, and the answer costs nothing when it is no. Commit first if the tree
is dirty: a rebase refuses one, and the stash is shared with every other worktree.

```bash
git fetch origin && git rebase origin/main
```

A rebase that stops on a conflict leaves the worktree mid-rebase, which is conflicts to resolve and
not a command to run again. Resolve them the way [`ship` step 3](../ship/SKILL.md#3-rebase-on-originmain)
says to; its traps are about the rebase rather than about shipping, and they apply here unchanged.

### 5. Install

```bash
./scripts/triage-test-lock.sh install
```

Refuses while another `next dev` is running in this worktree — stop step 1's preview first. Then it
points the dev service at this worktree, waits for it to bind, and requests the page; the first
request compiles the page and reads the inbox, so this is also the wait for that. `answers 200` on
the last line means the page compiled and did not render its own "Could not load notifications"
error. Anything else is this branch failing in the slot, which is a result: `npm run dev:logs` says
why. If the re-point itself fails, `install` puts the slot back on what it served before and says
so, and the lock stays held.

Working *in the main checkout* instead? Skip this step. The slot already serves your working tree —
every save is live in the user's tab — so just hold the lock, so that no worktree installs over you.

### 6. Look at it in the slot

Open `http://localhost:3100` in the Browser pane (`preview_start` with the `github-triage (live)`
configuration), confirm the rows rendered and the change is the one on screen, then close the tab.
The 200 said the page compiled, not that it shows the right thing; the user is the one who looks
next, and this is making sure what they will see is the branch and not the main checkout.

### 7. Hand it to the user

**Do not release yet if the change is one the user sees or touches.** Releasing points the slot back
at the main checkout, so the moment the lock drops there is nothing of the change left to try. Keep
it held, tell them localhost:3100 is serving this branch and what to look at, and wait for their
answer. That wait is this skill's own, not a gate on the next one: `ship` runs when the user says to
ship, tested or not, and their word is the answer this step was waiting for. Stay `🔒 ` while
waiting — the lock is held and the slot serves this branch, which is exactly what the prefix says.

**Iterate without releasing.** `next dev` watches the worktree it serves, so an edit here reloads in
the user's tab with no reinstall. Re-run `install` only when the server itself has to restart: after
`npm install`, or after editing `next.config.ts`. Look through `github-triage (live)` meanwhile — the
worktree preview would only die on the slot's lock.

### 8. Release

Swap the prefix to `🔓 ` before releasing. Do not report this.

```bash
./scripts/triage-test-lock.sh release
```

Points the slot back at what it served before, running or not, and drops the lock. Do this as soon
as the user has had their look; do not hold it while writing up results or shipping.

Then retitle: `📦 ` if the change passed and is worth shipping without re-testing, otherwise the
stage that is true — `⏳ ` back to implementing, `🚙 ` waiting on the user. Do not report this.

If the slot was re-pointed underneath you to some third checkout — another worktree, by hand —
release refuses rather than undoing that, and offers `--keep` (drop the lock, leave the slot alone)
or `--force` (restore anyway). Pick `--keep` only if that checkout is meant to stay in the slot. A
slot already back on what it served before is not drift, and release just finishes the job.

### 9. Ship

Release first, then follow the `ship` skill.

## Hazards

- **The inbox is real.** Every load reads the user's live notifications, which is harmless — about
  2 of 5000 hourly API points. The thread writes are not: marking read, marking Done and
  unsubscribing change their inbox on github.com, and a Done thread cannot even be listed afterwards.
  Never click a write control, in either server, on a thread the user has not named for it.
  `Auto done · N` in the list header is one, for every badged row at once, and
  `npm run auto-done:run -- --apply` is the same from the shell; the dry run (`npm run auto-done:run`,
  and the badges) is the test.
- **The tab is the user's.** `install` and `release` both restart the server, and the open tab
  reloads on the other side, dropping any selection it held. Say that it will happen when handing
  over rather than letting it land mid-triage.
- **Never `serve` by hand.** `scripts/dev-service.sh serve` is the lock's. Called directly, it
  re-points the slot with no record of what to put back.
- **Release before removing a worktree.** A slot pointed at a deleted directory has nothing to run,
  and launchd restarts it into the same failure until `release` or `break` points it elsewhere.
- **`.env.local` in a worktree is the main checkout's file.** Editing through the link edits theirs,
  and every server reading it.
- **Run the lock script from the worktree.** It takes its owner from the shell's working directory
  (`git rev-parse --show-toplevel`); run from the main checkout, `install` serves the main checkout
  and reports success.

## Stale locks

A lock older than 30 minutes is reported `STALE` by `status`. Breaking it restores the slot first:

```bash
./scripts/triage-test-lock.sh break
```

Breaking a lock that is *not* stale requires confirming with the user that no test is in flight,
then `TRIAGE_LOCK_STALE=0 ./scripts/triage-test-lock.sh break`. Never on a hunch — the holder may be
waiting on the user's look.

`break` recovers the lock and not the queue. A ticket whose waiting session is gone is pruned on
sight, but one whose recorded pid has been reused — across a reboot, say — looks alive forever, and
while it sits at the head every `acquire` is refused and every `wait` blocks behind a session that
does not exist. Clear it with:

```bash
./scripts/triage-test-lock.sh dequeue
```

It wakes the sessions it clears, so each one exits saying its ticket was cleared rather than sleeping
on a queue that is gone — but they do lose their place, so read the list it prints before running it.

If everything is wedged, the record is a plain file: `.claude/triage-test.lock/served_pre` in the
main checkout names the checkout the slot served before. Point the agent back at it with
`scripts/dev-service.sh serve <that path>` and delete the lock directory.
