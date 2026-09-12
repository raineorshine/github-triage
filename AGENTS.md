# github-triage

Next.js App Router. `npm run typecheck`, `npm run lint`, `npm run build`. The dev
server is a launchd agent, not something to start — see "The live slot" below.

## Direction

The inbox shows what is being asked of you, not why you were notified. Every
change moves it toward that — a decision-oriented view — and away from
notification noise, analysis, review and monitoring. A column, filter or count
that answers "why" or "how much" rather than "what do I decide" does not belong.

## Constraints

- **No persistent state.** No database, no cache, no sync. GitHub is the source
  of truth; filters live in the URL. The one file the app writes is the Auto
  Done audit log (`lib/sweep.ts`): append-only and never read back, a record of
  writes GitHub cannot list, not state. Adding anything the app *reads* needs a
  deliberate decision, not a convenience.
- **Page loads never write.** The Auto Done sweep runs only on
  `POST /api/auto-done` — from the launchd timer, the inbox button, or
  `npm run auto-done:run` — and is a dry run unless told to apply. The user's
  tab reloading, or a worktree preview being polled, must never change the
  inbox.
- **GitHub calls run one at a time.** Never `Promise.all` two of them: the
  secondary rate limit forbids concurrent requests for one user, and its 403
  shuts the inbox for minutes. Serial costs a page load a few hundred
  milliseconds; see docs/notification-activity.md.
- **The token is server-side only.** It is read in `lib/github.ts` via
  `getToken()`. Never pass it into a client component or a `NEXT_PUBLIC_` var.
- **Notifications are REST-only**; GraphQL cannot list them. Enrichment is a
  second, batched GraphQL query — keep it to one round trip.
- Route the page as `force-dynamic` with `cache: 'no-store'`. A cached inbox is
  a wrong inbox.

## Conventions

- Plain CSS in `app/globals.css` using the Primer-derived custom properties at
  the top. No CSS-in-JS, no utility framework.
- State-to-icon mapping lives in `lib/display.ts` (`stateKind`) and
  `components/StateIcon.tsx`. Add new subject types in both.
- Keep React state updaters pure — StrictMode double-invokes them. Mutate refs
  outside the updater.
- Auto Done's rules are `lib/autoDone.ts`, pure and covered by `npm test`; a
  change to what gets dismissed goes there with a test. Every GraphQL timeline
  item type is classified in `lib/timeline.ts`, and one it has never seen keeps
  the thread — so a new GitHub event is safe until it is listed as neutral
  there. What the notifications API and the timeline actually say — the sticky
  `reason`, what `since` hides, where a mention can be — is in
  docs/notification-activity.md; read it before changing either file.
- `Thread.reason` is not a signal. It is GitHub's sticky record of why you are
  subscribed, kept for the audit log; nothing shown or decided reads it.

## Workflow

Solo developer, no PRs. Each session works on its own branch in a worktree under
`.claude/worktrees/`; the main checkout stays on `main`, and it is what the live
slot serves. A finished change is squashed onto `origin/main` and pushed from the
worktree.

### The live slot

`http://localhost:3100` is the tab the user triages their real inbox in. A launchd
agent (`scripts/dev-service.sh`) runs `next dev` there from the main checkout; it
starts at login and outlives every session, so it should already be up. Leave it
running when the work is done. Never start a second `npm run dev` — it collides
with the agent on the pinned port — and never start the server as a tracked
background task, which is killed at session teardown.

```sh
npm run dev:status   # running? serving which checkout? bound to the port?
npm run dev:restart  # reload it, e.g. after editing next.config.ts or .env.local
npm run dev:logs     # follow the server log
```

If the agent is not installed on this machine, `npm run dev:install` sets it up;
see README.md > Running the dev server in the background. **If localhost:3100 is
down, or shows a token error, suspect the agent before the code** — start with
`npm run dev:status`.

Because the agent serves the main checkout, shipping is what puts a change in
front of the user: the ship fast-forwards the local `main`, and `next dev`
hot-reloads it.

### Verifying and testing

**Editing is parallel, the live slot is serial.** A worktree runs its own
`next dev` on a private port for anything the Browser pane can check —
`preview_start` with the `github-triage (worktree)` configuration — and needs no
lock for it. That configuration leaves the port to the Browser pane, which
hands it over as `PORT`; pinning one there would collide between worktrees.
After a visible change, show a screenshot of what it renders. Stop
that preview as soon as the check is done: the Browser pane polls it, and every
poll reads the inbox. One `next dev` runs per checkout (Next locks
`.next/dev/lock`), so it must also be stopped before the branch goes in the slot.
Putting a branch *at* localhost:3100, for the user's own look, goes through the
mutex in `scripts/triage-test-lock.sh`, which points the agent at the worktree
and back again on release.

**The inbox is real.** Every load reads the user's live notifications, and the
thread writes (`markThreadRead`, `markThreadDone`, `unsubscribeThread`) change
them on github.com. Reading is free to use as a design tool: a script that
loads the token from `.env.local` (never printing it) and surveys the real
inbox is as harmless as a page load, and what the API actually returns is worth
more than what its docs say. Writes are the hazard. Done threads cannot be listed, so a Done cannot be undone
from here. Never drive a write against a thread the user has not named. The
`Auto done · N` button is such a write, for every badged row at once, and
`npm run auto-done:run -- --apply` is the same from the shell; the dry run —
the badges, `npm run auto-done:run`, the audit log lines it appends — is what
testing uses.

### Skills

`test` puts this branch in the live slot under the lock; `ship` lands it on
`origin/main`. Both live in `.github/skills/`, and `.claude/skills` is a symlink
to that directory — a diff naming `.github/skills/...` after an edit through
`.claude/skills/...` is the same file. Read the one that matches what you are
about to do, before doing it.

A change the user would see or touch is delivered from inside `test`'s lock, not
by a clean build: what they would look at is not in their tab until `install`
has put it there. **Shipping is asked for, never inferred** — a finished, tested
change is ready to ship, not one to ship.

### When there is no Mac

A session in a Linux container (`uname -s` is not `Darwin`) has no launchd and
so no live slot — and no `.env.local`, so the page cannot even render there. The
lock script refuses (its `npm run dev:install` hint is for a Mac), and `ship` is
not its to run either: the cloud harness wants a branch and a pull request
rather than a push to `main`. Typecheck, lint, tests and build still run.

Commit, push the branch the harness designates, and open the pull request it
asks for. Then, at the point `test` would run, queue a handoff card
(`spawn_task`) for a session on the user's Mac, and park. The card opens a
session with none of this conversation, so its prompt stands on its own: the
branch to fetch, what changed and where, the checks in the order they would
fail, what was never verified, and that fixes go to the same branch and pull
request. Say it is untested everywhere it will be read later — the response,
the PR body, and a line of its own in the commit body.

## Session titles

A lifecycle prefix on the session title says what a session is doing while it is
doing it, so the sidebar answers "which chat has the live slot" without opening
any of them. One prefix at a time, replaced rather than stacked, and **never
mentioned in the response** — not what it was set to, not that it was already
right. Every title carries one: a title without a prefix says nothing about the
session, and the sidebar cannot tell it from a chat that never had a stage at
all. A session is named by the harness and so begins without one; putting the
first prefix on that inherited title is part of the first response. A prefix
comes off only when another replaces it, so a session that has nothing left to
do keeps the one for the last stage it reached.

| | |
|---|---|
| `⏳ ` | implementing — the weakest of them; every other prefix takes precedence |
| `🔓 ` | about to take the lock — including queued and blocked on it — or just released it |
| `🔒 ` | holding the lock; localhost:3100 serves this branch |
| `📦 ` | tested, and shippable without re-testing |
| `🚀 ` | shipping, and shipped — it stays until the session starts something else |
| `🚙 ` | parked: the work is sound and waiting on the user — a decision, or a look at a branch already in front of them |
| `🪦 ` | dead end — kept for the findings, not to resume |
| `📚 ` | extracting learnings into `AGENTS.md`, `README.md` or the skills |

Set a prefix when the stage *starts*, not when it succeeds, and correct it if the
stage falls over: a title that only becomes true at the end is blank for the
whole stretch the sidebar is there to describe. `📚 ` goes on the moment a
`learn` skill is invoked, before anything is read — the skill does not set it
itself. The lock and ship prefixes are set by the skills that own them; the rest
are set by hand (`mcp__ccd_session_mgmt__set_session_title`), and nothing
reconciles a title against reality. Handing back is itself a stage: a response
that closes on something for the user to do — look at it, decide — is a park,
and `🚙 ` goes on before that response, since the idle dot cannot tell "waiting
on you" from "given up on". Waiting on a hands-on look is the exception: the
lock is held and localhost:3100 serves this branch for as long as they are
looking, so that stays `🔒 `, and it is `🚙 ` only once there is nothing to hold.

**Ask which session this is before renaming one.** `get_session "self"` is the
only answer, and it changes under a fork: a forked session carries the whole
transcript, the id it read earlier in that transcript, and a different id of its
own, so a rename that reuses the remembered one retitles the session it forked
*from* — generally the one still holding the lock, whose title is therefore the
one the sidebar most needs to be true. A fork also starts in the worktree of
whatever session it forked from; nothing stops a branch being checked out there,
and it moves that worktree under the other session's feet. Put it back on the
branch it was on when the work is landed.

A cloud session never reaches `🔒 `, `📦 ` or `🚀 `: it holds no lock, tests
nothing and ships nothing. It ends at `🚙 `.

This vocabulary, and the worktree-and-lock workflow around it, came from the
sibling `karabiner` and `axshot` repos; `~/projects/karabiner/docs/workflow.md`
is where the reasoning lives, and where to look first when a convention here
reads as thinner than it should.

<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->
