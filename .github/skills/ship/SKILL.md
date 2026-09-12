---
name: ship
description: "Finish a change in github-triage: release the test lock, run the gates, commit, rebase on origin/main, squash, push to origin/main, fast-forward the local main the live slot serves, and extract the session's learnings. Use only when the user explicitly asks for the change to be shipped, landed, or pushed to main — never because a change looks finished."
---

# Ship (finish change → land on main)

Solo-developer workflow. Take the current branch (usually in a worktree), squash it to a single
commit, and push it to `origin/main`. No PR.

**Shipping is asked for, never inferred.** A change that is finished, tested and clean is a change
ready to ship, not one to ship — say so and stop. Only the user saying to ship, land, merge or push
it starts this procedure — or a skill the user invoked whose own procedure ends in one, `learn` and
`learn-organize` among them. There the ask arrived with the invocation, and stopping to put it again
is the thing those skills say not to do.

**Entered from `learn` or `learn-organize`, land the learnings alone.** What those skills hand over
is their own edits, not the branch: commit only the files the skill edited (never `git add -A`),
leave the test lock where it is, and skip step 9 — it would invoke `learn` again. Step 1 still
applies if the skill touched anything but prose. If the branch has other work — commits ahead of
`origin/main`, or changes the skill did not make — put the learnings commit on `origin/main` by
itself instead of running steps 3–5, so nothing unfinished goes with it:

```bash
C=$(git rev-parse HEAD) && T=$(mktemp -d)/ship && git fetch origin && git worktree add --detach "$T" origin/main && git -C "$T" cherry-pick "$C" && git -C "$T" push origin HEAD:main; git worktree remove --force "$T"
```

Then carry on at step 6. The branch keeps its own copy of the commit, and its later ship drops it on
the rebase as already applied.

`origin/main` is the source of truth, not the local `main` ref: another session may have pushed
without the main checkout being able to fast-forward, so local `main` can be behind what you must
land on. Pushing from the worktree keeps shipping independent of whatever the main checkout is
doing.

## Procedure

### 0. Prefix the session title with 🚀, then release the test lock

Read the session's title (`mcp__ccd_session_mgmt__get_session` with `"self"`) and set it back with a
`🚀 ` prefix (`mcp__ccd_session_mgmt__set_session_title`), replacing any existing lifecycle prefix
rather than stacking — a shipping session was usually `📦 ` a moment ago. Do this **now**, before any
of the work: the sidebar should say what the session is doing while it is doing it. Step 7 puts the
title back if the ship does not land. Do not report either. See AGENTS.md "Session titles".

```bash
./scripts/triage-test-lock.sh release --if-mine
```

If this branch was tested via the `test` skill, localhost:3100 is still serving this worktree and
the lock is still held. Releasing points the live slot back at the main checkout, which step 6 then
brings up to date. `--if-mine` releases only a lock *this session* took: no lock means the branch
needed no testing (a comment fix) and is safe to ship, and another session's lock is theirs. Both
are silent no-ops — do not report them.

Ship the change you *tested* — if the branch moved after the last test, re-test before shipping.

### 1. Gates (must pass before committing)

```bash
npm run typecheck && npm run lint && npm test && npm run build
```

Fix every finding and re-run until clean. `next build` is the only one of the four that compiles
the App Router's server/client split and the route config, so a tree that typechecks and lints can
still fail it.

`npm test` covers the Auto Done rules and the timeline classification, nothing that renders. If what
the inbox shows changed, it should have gone through the `test` skill already; a green build is not
evidence that a row still renders.

Build output (`.next/`) is ignored. Never commit it, and never commit `.env.local` — in a worktree
it is a symlink to the main checkout's, holding the token.

### 2. Commit all staged and unstaged changes

Generate the message from the diff. This repo uses Conventional Commits — `feat:`, `fix:`, `docs:`,
`chore:` — with a lower-case subject under about 60 characters, and a body that says why rather than
what.

A change that never reached the live slot — the user asked for the ship, or the lock was held by
another session for the whole of it — says so in the body too, in a line of its own. It is the one
thing a later reader cannot recover: the diff is in the commit and the build is implied, but whether
anybody looked at the thing is not written anywhere else.

A change that adds a write to the user's GitHub, or moves where the token is read, says so plainly
in the body: those are the two constraints in AGENTS.md whose breach costs the user something real.

### 3. Rebase on origin/main

```bash
git fetch origin && git rebase origin/main
```

Resolve conflicts, preferring the branch changes unless clearly wrong, then `git add` and
`git rebase --continue`, repeating until it completes.

**"Prefer the branch" is about changes, not about whole files.** A worktree cut before something
landed holds the old copy of every file that change touched, and a session that rewrote one of those
files from its own context hands the rebase a pre-feature version of the lot rather than a hunk.
Preferring that side reverts the other change with no marker and no mention of it in the message.
So before resolving a conflict in a file this branch did not set out to change, ask what else is in
it:

```bash
git log --oneline $(git merge-base HEAD origin/main)..origin/main -- <file>
```

Anything listed there that your side does not contain is about to be undone. Where the two sides
added separate things rather than alternatives, keep both.

**A clean merge is not a working one.** Git conflicts on adjacent lines, not on meaning, and this
app has shapes that are kept in step by hand: a field added to `Thread` in `lib/types.ts` has to be
filled by the hydration in `lib/github.ts`, and a new subject type needs both `stateKind` in
`lib/display.ts` and `components/StateIcon.tsx`. A branch that landed first can have added an
assignment or a case your side has never seen; each merges without a marker, and where the field is
optional it typechecks too. So when a branch adds something that has to sit beside an existing one,
grep the existing one's uses in the merged files and look for the new one next to every one of them.

Re-run the step 1 gates after any rebase that brought code in: step 1 signed off on the tree as it
was before this step, which is not the tree being pushed. Re-test after one that touched behaviour —
the change you tested is no longer the change you have. Re-testing takes the lock again, so the
title goes back to `🔒 ` while it is held and to `🚀 ` when it is released.

Skip the rebase and step 4 if you are already on `main` in the main checkout — but not the fetch,
which is the same rule in its degenerate form: `git pull --ff-only` there, commit, and go straight
to step 5. Skipping it only moves the collision to the push, which step 5 then sends back here.

### 4. Squash all commits into one

```bash
git reset --soft origin/main && git commit -m "subject" -m "body"
```

Use a single message that describes the overall diff, with real newlines inside the quotes, never
escaped `\n`.

### 5. Push to origin/main

```bash
git push origin HEAD:main
```

This is the ship. It runs from the worktree and touches no other working tree.

**If the push is rejected as non-fast-forward:** someone else landed first. Nothing was lost. Go back
to **step 3**, redo **step 4** to re-squash onto the new base, and push again. Because `origin/main`
only advances by fast-forward, at most one branch wins each round and the others rebase and retry —
no merge commits, no clobbering.

### 6. Fast-forward the local main — this is what puts it live

```bash
MAIN=$(git worktree list | head -1 | awk '{print $1}') && git -C "$MAIN" merge --ff-only origin/main
```

The dev service serves the main checkout, and `next dev` hot-reloads what the fast-forward writes, so
this is the step that puts the shipped change at localhost:3100. If `package.json` or
`package-lock.json` changed, the main checkout needs the new modules, and the server a restart to
load them — but only a server that is serving the main checkout:

```bash
MAIN=$(git worktree list | head -1 | awk '{print $1}') && (cd "$MAIN" && npm ci) && { [ "$(scripts/dev-service.sh serving)" != "$MAIN" ] || npm run dev:restart; }
```

`npm ci`, not `npm install`: install can rewrite the main checkout's lockfile, and a dirty lockfile
there refuses every later fast-forward that touches it. When the slot is serving another session's
worktree, the restart is theirs to cause: their `release` re-serves the main checkout, which starts
a fresh server on the new modules.

**If another session holds the lock**, the live slot is serving their worktree, not `main`; their
release points it back at the main checkout, which by then holds this ship. That is one line in the
report — another lock is open, and the change reaches the slot when it is released — and not an
account of whose lock or a command for the user to run.

**If the fast-forward fails** with local changes, leave them — never `checkout --` someone's work
away. Whoever fast-forwards next picks up every commit that accumulated, so a skipped one costs
nothing but the delay. Say so in the report, since until then the live slot lacks the change that
was just shipped.

### 7. Correct the title if the ship did not land

The push in step 5 is what counts as shipped, whether or not step 6 could fast-forward. If it
succeeded, the `🚀 ` from step 0 stays — through the report and after it, until the session starts
something else and that stage's prefix replaces it. Never clear it to leave a bare title. If the
push failed, or the ship was abandoned before it, put the title back to the prefix that is true now:
`📦 ` for a tested branch, `⏳ ` if the work goes back to implementing, `🚙 ` if it waits on the user.
Do not report this step.

### 8. Post-ship

- `README.md` is hand-written, and so is its account of the app — "How data is fetched", "What the
  API cannot do", the Layout block, and the line saying which thread writes are wired to the UI.
  Check they still describe what shipped; nothing regenerates them.
- The branch is now on `origin/main`. If this worktree is finished with, it and the branch can be
  cleaned up from the main checkout:

  ```bash
  BRANCH=$(git branch --show-current) && MAIN=$(git worktree list | head -1 | awk '{print $1}') && git -C "$MAIN" worktree remove <this-worktree-path> && git -C "$MAIN" branch -d "$BRANCH"
  ```

  Only when the user confirms the worktree is no longer needed, and never while the live slot is
  serving it — `./scripts/triage-test-lock.sh status` says what it serves. `git branch -d` refuses
  while the local `main` is behind the pushed commit; wait for step 6 rather than forcing with `-D`.

### 9. Extract the learnings

Put `📚 ` on the title, then invoke the `learn` skill. A shipped change is the moment its lessons
are worth writing down: the branch is landed, nothing is pending, and whatever the session learned
about the app, the API or the workflow is still in context — an hour later it is in nobody's. This
is not optional and the user does not have to ask for it; it is the last stage of shipping.

`learn` does not set the prefix itself, which is why it goes on by hand first. Put `🚀 ` back when it
finishes: the session shipped, and that is the stage it rests at.

If `learn` finds nothing worth recording, that is a normal outcome — say so in one line and move on.

### 10. Print the completion message

Print `🚀 Shipped` as the last line of the response, after the learn report.
