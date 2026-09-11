# github-triage

A triage-focused replacement for [github.com/notifications](https://github.com/notifications).

GitHub is the source of truth. The app stores nothing — no database, no cache, no
sync. Every page load reads live from the GitHub API, and filters live in the URL.

## Setup

```bash
echo "GITHUB_TOKEN=$(gh auth token)" > .env.local
npm run dev
```

Serves at http://localhost:3100 (pinned — 3000 is commonly taken).

Any token with the `repo` scope works — that scope covers reading *and* writing
notification threads. The token is read server-side only; it never reaches the
browser.

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
```

`markThreadRead`, `markThreadDone` and `unsubscribeThread` are implemented in
`lib/github.ts` and not yet wired to the UI.
