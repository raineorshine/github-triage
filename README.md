# github-triage

A triage-focused replacement for [github.com/notifications](https://github.com/notifications).

GitHub is the source of truth. The app stores nothing — no database, no cache, no
sync. Every page load reads live from the GitHub API, and filters live in the URL.

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

Two requests per page load:

1. `GET /notifications` — the thread list. Returns only title, repo, reason and
   timestamp: no issue state, no labels, no avatars.
2. One GraphQL query — hydrates every thread in the list with state, labels,
   participants, comment count and diff size. Aliases are grouped by repository,
   so a repo with ten notifications is looked up once, not ten times.

That is ~2 of 5000 hourly API points per load. A load takes ~2.5s: ~0.4s for the
REST list, ~2s for GraphQL hydration.

`all=true` is the equivalent of GitHub's Inbox: it returns read *and* unread
threads, and already excludes ones marked Done.

## What the API cannot do

- **Saved and Done have no REST endpoint.** You can mark a thread done
  (`DELETE /notifications/threads/:id`), but you cannot list what is already
  saved or done. Those two sidebar entries are shown disabled.
- **Notifications are REST-only.** The GraphQL API does not expose them, which is
  why hydration is a second request rather than one combined query.
- **No actor list per notification.** GitHub's own UI shows who triggered the
  activity; the API does not return it. Recent commenters (falling back to the
  author) stand in for it.

## Layout

```
src/
  lib/
    types.ts      shared shapes: RestNotification → Thread
    github.ts     REST + GraphQL clients, hydration, thread writes
    display.ts    reason labels, relative time, state → icon mapping
  components/
    Sidebar.tsx           URL-encoded filters, counts from the loaded page
    NotificationList.tsx  selection state (client)
    NotificationRow.tsx   one row
    StateIcon.tsx         octicon + colour per issue/PR state
  app/
    page.tsx      fetches and filters, server-rendered
scripts/
  dev-service.sh        the launchd agent that serves localhost:3100
  triage-test-lock.sh   the mutex for serving a worktree there under test
```

`markThreadRead`, `markThreadDone` and `unsubscribeThread` are implemented in
`lib/github.ts` and not yet wired to the UI.
