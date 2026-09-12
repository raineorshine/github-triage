# What GitHub tells you about a thread's activity

The Auto Done sweep (`src/lib/sweep.ts`) judges an unread thread on the activity
since you last read it, so it depends on exactly what the notifications REST API
and the GraphQL timeline do and do not say. This is what they turned out to do,
found by querying the real inbox while building it; the rules that read this
data are in `src/lib/autoDone.ts`, and the timeline classification in
`src/lib/timeline.ts`.

## The notification thread

`GET /notifications` returns, per thread: `unread`, `updated_at`, `last_read_at`
(null if you never opened it), `reason`, and the subject's API url. Nothing
about what happened.

- **`last_read_at` is the baseline.** GitHub moves it when you view the thread
  on github.com or mark it read through the API. It is the one record of "what
  I have seen" that needs no storage of our own.
- **`updated_at` moves only for notifying events.** A convert-to-draft an hour
  after the last notification left `updated_at` where it was; so do labels,
  milestones, projects and deploys. The race check in the sweep compares
  `updated_at`, `last_read_at` and `unread` against a fresh read of the thread
  right before the DELETE, which is exactly the set of fields a new notifying
  event would move.
- **`reason` is sticky.** It records the strongest reason you were ever
  notified for, not the latest event: a thread read `mention` while its unread
  window held two commits and a convert-to-draft, the mention being a day older
  than `last_read_at`. Nothing decision-shaped can be read off it. The row and
  the sidebar stopped showing it for that reason; it is kept on `Thread` for
  the audit log only.
- **`?participating=true` is GitHub's own answer to "did I take part".** One
  request for the whole inbox, covering opened, commented, reviewed, assigned,
  asked to review and mentioned. The GraphQL `participants` connection was the
  alternative and lost: its cost scales with the page size you ask for, and a
  viewer beyond the page would read as absent — a false "never took part",
  which is the unsafe direction.
- **`X-Poll-Interval` is 60 seconds.** There is no notification webhook for a
  user; polling is the only way to notice new threads, and once a minute is
  the floor.

## The timeline

`timelineItems(first:, since:)` on an Issue or PullRequest is the activity.

- **`since` filters commits too.** `PullRequestCommit` has no `createdAt`; the
  filter goes by the commit's date, so a push of old-dated commits (a rebase of
  work from before `last_read_at`) is invisible in the window. An unread thread
  with an empty window is therefore "something happened that we cannot see",
  and the rules keep it.
- **`totalCount` ignores `since`.** It is the whole timeline's length. Only
  `pageInfo.hasNextPage` says whether the window overflowed the page.
- **Pull request item types cannot be spread in an issue timeline.** A fragment
  on `PullRequestCommit` inside `... on Issue { timelineItems }` is a query
  error, so the selection is built per type (`timelineItemFields`).
- **Cost is small.** Eight threads with 100 items each, bodies included, cost
  one GraphQL point; the potential-node formula in the docs overstates it. Cost
  is not the reason to keep the selection tight.
- **Introspection is capped at two `__type` fields per query.** Split
  schema-discovery queries accordingly.

## Where a mention can be

An `@login` that should stop a dismissal can sit in: the issue or PR body, an
issue comment, a review's summary body, an inline review comment, or a commit
message. All five are scanned as text (`mentionPattern`).

`MentionedEvent` — actor is the person mentioned, not the writer — is created
for bodies and issue comments (observed) but was **not** created for a mention
inside an inline review comment (observed on the same thread). It is a second
signal, never the only one. Inline comments come nested under
`PullRequestReview.comments` and `PullRequestReviewThread.comments`; a reply
in an old thread arrives as a new single-comment review.

## Rate limits

GitHub's secondary rate limit forbids **concurrent requests for one user**. The
first page render that issued the participating listing in parallel with the
GraphQL hydration got a 403 telling it to wait "a few minutes", which is the
inbox down for that long. Every GitHub call in this app runs serially, including
the Browser pane's page renders, which are one request more each since Auto
Done.

## Done

`DELETE /notifications/threads/{id}` marks a thread done; it takes no
conditional header, and there is no API to undo it or list done threads. The
docs do not say whether new activity brings a done thread back to the inbox —
the subscription survives, so it should. A community report claims done
threads still come back from `GET /notifications?all=true`; not seen here.
