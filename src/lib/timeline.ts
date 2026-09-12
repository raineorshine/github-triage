/**
 * The activity on a thread since you last read it, as GitHub's GraphQL timeline
 * reports it. Every item type GitHub can return is classified here, in one
 * place: as an event kind the rules in autoDone.ts reason about, as neutral
 * (it never generates a notification, so it cannot be what made the thread
 * unread), or — when it is not listed at all — as unknown, which keeps the
 * thread. A new item type from GitHub is therefore safe by default.
 *
 * timelineItemFields is the GraphQL selection that produces the raw nodes
 * normalizeTimeline reads; keep the two in step. What the timeline does and
 * does not report — `since` and commits, where a mention can hide — is in
 * docs/notification-activity.md.
 */

export interface Actor {
  login: string
}

export interface ReviewerRef {
  /** Teams block a dismissal (yours or not, the API cannot cheaply say); unknown keeps it too. */
  kind: 'user' | 'team' | 'bot' | 'unknown'
  name: string | null
}

export type TimelineEvent =
  /** The issue or PR itself, when it was opened inside the window. Synthesized by autoDone.ts. */
  | { kind: 'opened'; at: string; actor: string | null; body: string }
  | { kind: 'commit'; at: string | null; actor: string | null; body: string }
  | { kind: 'force-push'; at: string; actor: string | null }
  | { kind: 'comment'; at: string; actor: string | null; body: string }
  /** A review, with its inline comments already folded in as `review-comment` events. */
  | { kind: 'review'; at: string; actor: string | null; body: string; unscanned: number }
  | { kind: 'review-comment'; at: string | null; actor: string | null; body: string }
  | { kind: 'review-requested'; at: string; actor: string | null; reviewer: ReviewerRef }
  | { kind: 'assigned'; at: string; actor: string | null; assignee: string | null }
  /** GitHub's own record that someone was @-mentioned; `mentioned` is the person named. */
  | { kind: 'mentioned'; at: string; mentioned: string | null }
  | { kind: 'closed'; at: string; actor: string | null }
  | { kind: 'merged'; at: string; actor: string | null }
  | { kind: 'reopened'; at: string; actor: string | null }
  | { kind: 'ready-for-review'; at: string; actor: string | null }
  | { kind: 'neutral'; typename: string }
  | { kind: 'unknown'; typename: string }

/**
 * Item types that never make a thread unread: labels, projects, milestones,
 * references, merge-queue and deploy bookkeeping, and the viewer's own
 * subscription records. Converting to draft is here because GitHub does not
 * bump the notification for it; marking ready for review is not, since that is
 * exactly when a PR wants looking at.
 */
const NEUTRAL = new Set([
  'AddedToMergeQueueEvent',
  'AddedToProjectEvent',
  'AddedToProjectV2Event',
  'AddedToStackEvent',
  'ArchivedEvent',
  'AutoMergeDisabledEvent',
  'AutoMergeEnabledEvent',
  'AutoRebaseEnabledEvent',
  'AutoSquashEnabledEvent',
  'AutomaticBaseChangeFailedEvent',
  'AutomaticBaseChangeSucceededEvent',
  'BaseRefChangedEvent',
  'BaseRefDeletedEvent',
  'BaseRefForcePushedEvent',
  'BlockedByAddedEvent',
  'BlockedByRemovedEvent',
  'BlockingAddedEvent',
  'BlockingRemovedEvent',
  'CommentDeletedEvent',
  'ConnectedEvent',
  'ConvertToDraftEvent',
  'ConvertedFromDraftEvent',
  'ConvertedNoteToIssueEvent',
  'CrossReferencedEvent',
  'DemilestonedEvent',
  'DeployedEvent',
  'DeploymentEnvironmentChangedEvent',
  'DisconnectedEvent',
  'HeadRefDeletedEvent',
  'HeadRefRestoredEvent',
  'IssueCommentPinnedEvent',
  'IssueCommentUnpinnedEvent',
  'IssueFieldAddedEvent',
  'IssueFieldChangedEvent',
  'IssueFieldRemovedEvent',
  'IssueTypeAddedEvent',
  'IssueTypeChangedEvent',
  'IssueTypeRemovedEvent',
  'LabeledEvent',
  'LockedEvent',
  'MarkedAsDuplicateEvent',
  'MilestonedEvent',
  'MovedColumnsInProjectEvent',
  'ParentIssueAddedEvent',
  'ParentIssueRemovedEvent',
  'PinnedEvent',
  'ProjectV2ItemStatusChangedEvent',
  'PullRequestRevisionMarker',
  'ReferencedEvent',
  'RemovedFromMergeQueueEvent',
  'RemovedFromProjectEvent',
  'RemovedFromProjectV2Event',
  'RemovedFromStackEvent',
  'RenamedTitleEvent',
  'ReviewRequestRemovedEvent',
  'SubIssueAddedEvent',
  'SubIssueRemovedEvent',
  'SubscribedEvent',
  'TransferredEvent',
  'UnarchivedEvent',
  'UnassignedEvent',
  'UnlabeledEvent',
  'UnlockedEvent',
  'UnmarkedAsDuplicateEvent',
  'UnpinnedEvent',
  'UnsubscribedEvent',
  'UserBlockedEvent',
])

/** Inline comments fetched per review or review thread; more than this is reported as unscanned. */
export const REVIEW_COMMENT_LIMIT = 10

/**
 * Selection for a `timelineItems.nodes` list. Types only in the pull request
 * timeline are guarded by `isPullRequest`, because GraphQL refuses a fragment on
 * a type the union cannot hold.
 */
export function timelineItemFields(isPullRequest: boolean): string {
  const common = `
    __typename
    ... on IssueComment { createdAt body author { login } }
    ... on ClosedEvent { createdAt actor { login } }
    ... on ReopenedEvent { createdAt actor { login } }
    ... on MentionedEvent { createdAt actor { login } }
    ... on AssignedEvent { createdAt actor { login } assignee { ... on User { login } ... on Bot { login } ... on Mannequin { login } ... on Organization { login } } }`
  if (!isPullRequest) return common
  return `${common}
    ... on PullRequestCommit { commit { committedDate message author { user { login } } } }
    ... on HeadRefForcePushedEvent { createdAt actor { login } }
    ... on MergedEvent { createdAt actor { login } }
    ... on ReadyForReviewEvent { createdAt actor { login } }
    ... on ReviewRequestedEvent { createdAt actor { login } requestedReviewer { __typename ... on User { login } ... on Team { name } ... on Bot { login } ... on Mannequin { login } } }
    ... on PullRequestReview { createdAt body author { login } comments(first: ${REVIEW_COMMENT_LIMIT}) { totalCount nodes { createdAt body author { login } } } }
    ... on PullRequestReviewThread { comments(last: ${REVIEW_COMMENT_LIMIT}) { totalCount nodes { createdAt body author { login } } } }`
}

export interface RawComment {
  createdAt: string
  body: string | null
  author: Actor | null
}

/** One node of `timelineItems.nodes`, as selected by timelineItemFields. */
export interface RawTimelineNode {
  __typename: string
  createdAt?: string
  body?: string | null
  actor?: Actor | null
  author?: Actor | null
  assignee?: Actor | null
  commit?: {
    committedDate: string
    message: string
    author: { user: Actor | null } | null
  }
  requestedReviewer?: { __typename: string; login?: string; name?: string } | null
  comments?: { totalCount: number; nodes: RawComment[] }
}

const login = (a: Actor | null | undefined): string | null => a?.login ?? null

function reviewer(raw: RawTimelineNode['requestedReviewer']): ReviewerRef {
  if (!raw) return { kind: 'unknown', name: null }
  switch (raw.__typename) {
    case 'User':
      return { kind: 'user', name: raw.login ?? null }
    case 'Team':
      return { kind: 'team', name: raw.name ?? null }
    case 'Bot':
    case 'Mannequin':
      return { kind: 'bot', name: raw.login ?? null }
    default:
      return { kind: 'unknown', name: null }
  }
}

/** Inline comments of a review or review thread, restricted to the window. */
function reviewComments(
  raw: RawTimelineNode['comments'],
  since: string | null,
): { events: TimelineEvent[]; unscanned: number } {
  if (!raw) return { events: [], unscanned: 0 }
  const events: TimelineEvent[] = raw.nodes
    .filter(c => since === null || c.createdAt > since)
    .map(c => ({ kind: 'review-comment', at: c.createdAt, actor: login(c.author), body: c.body ?? '' }))
  return { events, unscanned: Math.max(0, raw.totalCount - raw.nodes.length) }
}

/**
 * Normalizes one page of timeline nodes. `since` is the window's start (the
 * thread's last_read_at), needed because a review thread's comments are not
 * themselves filtered by the timeline's `since`.
 */
export function normalizeTimeline(nodes: RawTimelineNode[], since: string | null): TimelineEvent[] {
  const events: TimelineEvent[] = []
  for (const n of nodes) {
    const at = n.createdAt ?? ''
    switch (n.__typename) {
      case 'IssueComment':
        events.push({ kind: 'comment', at, actor: login(n.author), body: n.body ?? '' })
        break
      case 'PullRequestReview': {
        const inline = reviewComments(n.comments, since)
        events.push({ kind: 'review', at, actor: login(n.author), body: n.body ?? '', unscanned: inline.unscanned })
        events.push(...inline.events)
        break
      }
      case 'PullRequestReviewThread': {
        // Replies also arrive as PullRequestReview items; the thread is scanned
        // as well so a mention in an old thread's new reply is not missed.
        const inline = reviewComments(n.comments, since)
        events.push(...inline.events)
        if (inline.unscanned > 0) {
          events.push({ kind: 'review', at, actor: null, body: '', unscanned: inline.unscanned })
        }
        break
      }
      case 'PullRequestCommit':
        events.push({
          kind: 'commit',
          at: n.commit?.committedDate ?? null,
          actor: login(n.commit?.author?.user),
          body: n.commit?.message ?? '',
        })
        break
      case 'HeadRefForcePushedEvent':
        events.push({ kind: 'force-push', at, actor: login(n.actor) })
        break
      case 'ReviewRequestedEvent':
        events.push({ kind: 'review-requested', at, actor: login(n.actor), reviewer: reviewer(n.requestedReviewer) })
        break
      case 'AssignedEvent':
        events.push({ kind: 'assigned', at, actor: login(n.actor), assignee: login(n.assignee) })
        break
      case 'MentionedEvent':
        // GitHub's actor here is the person mentioned, not the one who wrote it.
        events.push({ kind: 'mentioned', at, mentioned: login(n.actor) })
        break
      case 'ClosedEvent':
        events.push({ kind: 'closed', at, actor: login(n.actor) })
        break
      case 'MergedEvent':
        events.push({ kind: 'merged', at, actor: login(n.actor) })
        break
      case 'ReopenedEvent':
        events.push({ kind: 'reopened', at, actor: login(n.actor) })
        break
      case 'ReadyForReviewEvent':
        events.push({ kind: 'ready-for-review', at, actor: login(n.actor) })
        break
      default:
        events.push({ kind: NEUTRAL.has(n.__typename) ? 'neutral' : 'unknown', typename: n.__typename })
    }
  }
  return events
}
