# github-triage

A triage-focused replacement for [github.com/notifications](https://github.com/notifications).

GitHub is the source of truth. The app stores nothing — no database, no cache, no
sync. Every page load reads live from the GitHub API, and filters live in the URL.
The one thing kept, in the browser, is the theme picked under the gear: System,
GitHub light, Monokai Classic or Monokai.

## Setup

```bash
npm install
echo "GITHUB_TOKEN=$(gh auth token)" > .env.local
npm run dev:install
```

Serves at http://localhost:3100 (pinned — 3000 is commonly taken), from a
launchd agent that starts at login; see
[Running the dev server in the background](#running-the-dev-server-in-the-background).
`npm run dev` runs the same server in a terminal instead — stop the agent first
with `npm run dev:stop`, or the two collide on the port.

Any token with the `repo` scope works — that scope covers reading *and* writing
notification threads. The token is read server-side only; it never reaches the
browser.

### Running the dev server in the background

The dev server runs as a [launchd](https://www.launchd.info) user agent rather
than in a terminal, so it is up whenever you are logged in and survives the
terminal or session that started it.

| Script                  | What it does                                                                     |
| ----------------------- | -------------------------------------------------------------------------------- |
| `npm run dev:install`   | Install the agent, start it, and have it start at every login.                   |
| `npm run dev:uninstall` | Stop the agent and remove it, so it no longer starts at login.                   |
| `npm run dev:start`     | Start the agent.                                                                 |
| `npm run dev:stop`      | Stop the agent until you start it again or log in again.                         |
| `npm run dev:restart`   | Restart the agent, such as after editing `next.config.ts` or `.env.local`.       |
| `npm run dev:status`    | Report whether it is running, which checkout it serves, and whether it is bound. |
| `npm run dev:logs`      | Follow the server log; `npm run dev:logs -- -n 100` prints the tail and exits.   |

Notes:

- launchd agents run at login rather than at boot, so the server comes up once
  you are signed in.
- Output goes to `~/Library/Logs/github-triage-dev.log`.
- The agent serves the primary checkout, even when installed from a git
  worktree. While a branch is under test, `scripts/triage-test-lock.sh` points it
  at that worktree and points it back on release; `npm run dev:status` says
  which checkout it is serving.
- It runs the same node your shell does, resolved to a path that survives a
  reboot, since launchd does not read your shell config. Override it with
  `TRIAGE_NODE_BIN=/path/to/node/bin npm run dev:install`.
- launchd restarts the server if it exits unexpectedly.
- Install and start refuse while something else holds port 3100, since `next dev`
  exits rather than falling back to another port.

## How data is fetched

Two requests per page load, three when there is something for Auto Done to
judge:

1. `GET /notifications` — the thread list. Returns only title, repo, reason and
   timestamp: no issue state, no labels, no avatars.
2. One GraphQL query — hydrates every thread in the list with state, labels,
   participants, comment count and diff size. Aliases are grouped by repository,
   so a repo with ten notifications is looked up once, not ten times. For each
   unread issue or PR it also brings the timeline since `last_read_at`, which
   is what [Auto Done](#auto-done) judges; a window longer than a page costs one
   more round trip.
3. `GET /notifications?participating=true` — only when the list has an unread
   issue or PR: GitHub's own answer to "did I take part in this", which one of
   the Auto Done rules asks.

That is a handful of the 5000 hourly API points per load. A load takes ~2.5s:
~0.4s for the REST list, ~2s for GraphQL hydration.

`all=true` is the equivalent of GitHub's Inbox: it returns read *and* unread
threads, and already excludes ones marked Done.

## Auto Done

Unread threads whose new activity needs no look from you are marked done
automatically. A thread is judged only on what happened since you last read it
(`last_read_at`; a thread never read is judged whole), by five deterministic
rules in `src/lib/autoDone.ts`:

| Rule                       | Dismisses when the new activity is…                                                    |
| -------------------------- | -------------------------------------------------------------------------------------- |
| `commit`                   | commits or a force-push on an open pull request                                        |
| `review-request`           | a review requested of someone else                                                     |
| `closed-not-participating` | anything — the thread is closed or merged, and you never took part in it               |
| `closed-read`              | the close or merge itself (commits before it ride along), on a thread you had read     |
| `draft`                    | anything — the pull request is a draft, unless it is yours and someone commented on it |

Three blockers override every rule: an `@`-mention of you in anything new, a
review requested of you (or of a team), and an assignment to you. Any other
event — a comment, a review, a reopen, a type the code has never seen — keeps
the thread, as does a window that could not be fetched whole. Labels,
milestones, references and the rest of GitHub's bookkeeping never make a thread
unread and are ignored, and so is your own activity; `src/lib/timeline.ts`
classifies every timeline item type. `npm test` runs the rules against
fixtures. [docs/notification-activity.md](docs/notification-activity.md) records
what the GitHub API actually reports about a thread's activity, which the
rules are built on.

Two things run the sweep:

- **The timer.** `npm run auto-done:install` installs a launchd agent that
  POSTs to `/api/auto-done` on localhost:3100 every five minutes — as a dry
  run, which only logs what it would mark done. Once the `auto` badges in the
  inbox have earned your trust, `npm run auto-done:install -- --apply` switches
  it to marking them done.
- **The button.** Every row Auto Done would dismiss carries an `auto` badge
  (hover it for the rule), and `Auto done · N` in the list header marks those
  rows done on click, after a confirmation.

| Script                                   | What it does                                                                     |
| ---------------------------------------- | -------------------------------------------------------------------------------- |
| `npm run auto-done:install [-- --apply]` | Install the timer, as a dry run unless `--apply`; re-run to switch modes.        |
| `npm run auto-done:uninstall`            | Stop the timer and remove it.                                                    |
| `npm run auto-done:start` / `:stop`      | Without removing it.                                                             |
| `npm run auto-done:status`               | Mode, interval, whether it is loaded, and the last sweep.                        |
| `npm run auto-done:run [-- --apply]`     | One sweep now, printing every verdict — the way to see why a thread is kept.     |
| `npm run auto-done:logs`                 | Follow the audit log; `-- -n 20` prints the tail and exits.                      |

Marking done is the one write GitHub cannot undo, or even list afterwards, so
every dismissal — and, in a dry run, every one that would have happened — is
appended to `~/Library/Logs/github-triage-auto-done.jsonl`, one JSON line each,
plus a summary line per sweep. It is the only file the app writes.

Between judging a thread and marking it done, something new could land and be
hidden under the Done. The sweep re-reads the thread immediately before the
DELETE and skips it if `updated_at`, `last_read_at` or `unread` moved, so that
window is one request wide. GitHub keeps your subscription through a Done, so
anything landing after it should bring the thread back.

## What the API cannot do

- **Saved and Done have no REST endpoint.** You can mark a thread done
  (`DELETE /notifications/threads/:id`), but you cannot list what is already
  saved or done. Those two sidebar entries are shown disabled.
- **Notifications are REST-only.** The GraphQL API does not expose them, which is
  why hydration is a second request rather than one combined query.
- **No actor list per notification.** GitHub's own UI shows who triggered the
  activity; the API does not return it. Recent commenters (falling back to the
  author) stand in for it.
- **No notification webhook.** Nothing pushes new notifications to you; the
  Auto Done timer polls, and `X-Poll-Interval` puts the floor at once a minute.
- **The `reason` is not the latest event.** It is the strongest reason you were
  ever notified for and stays put — a thread reads `mentioned` long after the
  mention was read — so nothing here shows or decides on it. Auto Done finds
  mentions in the activity itself; [docs/notification-activity.md](docs/notification-activity.md)
  has what the API does and does not say.

## Layout

```
src/
  lib/
    types.ts      shared shapes: RestNotification → Thread
    github.ts     REST + GraphQL clients, hydration, thread writes
    display.ts    relative time, state → icon mapping
    timeline.ts   GraphQL timeline items → events, neutral or unknown
    autoDone.ts   the Auto Done rules: activity → verdict (npm test)
    sweep.ts      one sweep: list, judge, re-check, mark done, audit log
    theme.ts      the named palettes, and the choice the browser keeps
  components/
    Sidebar.tsx           URL-encoded filters, counts from the loaded page
    NotificationList.tsx  selection state and the Auto done button (client)
    NotificationRow.tsx   one row
    StateIcon.tsx         octicon + colour per issue/PR state
    Settings.tsx          the gear and its popover, Popover API
    ThemeSelect.tsx       the theme select (client)
  app/
    layout.tsx              top bar, and the script that themes the first paint
    page.tsx                fetches and filters, server-rendered
    api/auto-done/route.ts  POST: one sweep, a dry run unless ?apply=1
scripts/
  dev-service.sh        the launchd agent that serves localhost:3100
  triage-test-lock.sh   the mutex for serving a worktree there under test
  auto-done-service.sh  the launchd timer that runs the sweep
```

`markThreadRead` and `unsubscribeThread` are implemented in `lib/github.ts` and
not yet wired to the UI; `markThreadDone` is what the Auto Done sweep calls.
