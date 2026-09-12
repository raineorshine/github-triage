import type { TimelineEvent } from './timeline'

/**
 * Auto Done: which unread threads can be marked done without you looking at
 * them, judged purely on the activity since you last read them. Deterministic —
 * five rules, a short list of blockers, and everything else keeps the thread.
 *
 *   commit                    new commits (or a force-push) on an open pull request
 *   review-request            a review requested of someone else
 *   closed-not-participating  closed or merged, and you never took part
 *   closed-read               closed or merged after you had read it, with nothing else since
 *   draft                     a draft pull request with no mention of you
 *
 * Blockers hold in every case: an @-mention of you in anything new, a review
 * requested of you (or of a team), an assignment to you. Any event that none of
 * the rules covers — a comment, a review, a reopen, a type this code has never
 * seen — keeps the thread, and so does a window that could not be seen whole.
 *
 * The rules are per event, with two exceptions. `closed-not-participating` and
 * `draft` are judged on state: a discussion you were never part of, or a draft
 * nobody has pointed at you, is not for you whatever was said in it — mentions
 * aside. `closed-read`, by contrast, wants the close to be the only news.
 *
 * The API facts these rules rest on — the sticky `reason`, the baseline
 * `last_read_at`, what the timeline's `since` hides — are in
 * docs/notification-activity.md.
 */

export type Rule = 'commit' | 'review-request' | 'closed-not-participating' | 'closed-read' | 'draft'

export interface Verdict {
  verdict: 'done' | 'keep'
  /** The rule that dismissed it; null when kept. */
  rule: Rule | null
  /** One line for a badge title or a log: what allowed the dismissal, or what stopped it. */
  detail: string
}

export const RULE_LABELS: Record<Rule, string> = {
  commit: 'new commits on an open pull request',
  'review-request': 'review requested of someone else',
  'closed-not-participating': 'closed, and you never took part',
  'closed-read': 'closed after you read it',
  draft: 'draft pull request with no mention of you',
}

export interface ActivitySubject {
  type: 'Issue' | 'PullRequest'
  /** OPEN, CLOSED, or (pull requests) MERGED. */
  state: string
  isDraft: boolean
  viewerDidAuthor: boolean
  author: string | null
  createdAt: string
  body: string
}

export interface Activity {
  /** The login the token belongs to; mentions are matched against it. */
  viewer: string
  /** Where the window starts — the thread's last_read_at. Null means the whole thread. */
  lastReadAt: string | null
  /**
   * GitHub's own "participating" flag for the thread: you opened it, commented,
   * reviewed, were assigned, were asked to review, or were mentioned.
   */
  participating: boolean
  subject: ActivitySubject
  /** The timeline since `lastReadAt`, normalized by timeline.ts. */
  events: TimelineEvent[]
  /** The timeline had more pages than were fetched, so `events` is incomplete. */
  truncated: boolean
}

/** `@login` as a whole word: not `@login-bot`, not `mail@login.example`. */
export function mentionPattern(login: string): RegExp {
  const escaped = login.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`(^|[^\\w-])@${escaped}(?![\\w-])`, 'i')
}

const KIND_LABELS: Record<Exclude<TimelineEvent['kind'], 'neutral' | 'unknown' | 'mentioned'>, string> = {
  opened: 'opened',
  commit: 'commit',
  'force-push': 'force-push',
  comment: 'comment',
  review: 'review',
  'review-comment': 'review comment',
  'review-requested': 'review request',
  assigned: 'assignment',
  closed: 'close',
  merged: 'merge',
  reopened: 'reopen',
  'ready-for-review': 'marked ready for review',
}

function describe(e: TimelineEvent): string {
  switch (e.kind) {
    case 'neutral':
      return e.typename
    case 'unknown':
      return `unknown event ${e.typename}`
    case 'mentioned':
      return 'mention'
    default:
      return `${KIND_LABELS[e.kind]} by ${e.actor ?? 'someone'}`
  }
}

const keep = (detail: string): Verdict => ({ verdict: 'keep', rule: null, detail })
const done = (rule: Rule): Verdict => ({ verdict: 'done', rule, detail: RULE_LABELS[rule] })

export function evaluate(a: Activity): Verdict {
  const me = a.viewer
  const mention = mentionPattern(me)

  // The thread's own opening is activity too when it happened inside the
  // window: a new pull request is not "new commits on an open pull request".
  const openedInWindow = a.lastReadAt === null || a.subject.createdAt > a.lastReadAt
  const events: TimelineEvent[] = openedInWindow
    ? [{ kind: 'opened', at: a.subject.createdAt, actor: a.subject.author, body: a.subject.body }, ...a.events]
    : a.events

  // Blockers hold whatever else is true, so they get their look before
  // anything is filtered out.
  for (const e of events) {
    if (e.kind === 'mentioned') {
      if (e.mentioned === me) return keep('you were mentioned')
      continue
    }
    if ('body' in e && mention.test(e.body)) return keep(`mentioned in a ${describe(e)}`)
    if (e.kind === 'review-requested') {
      const r = e.reviewer
      if (r.kind === 'user' && r.name === me) return keep('review requested of you')
      if (r.kind === 'team') return keep(`review requested of team ${r.name ?? '?'}`)
      if (r.kind === 'unknown') return keep('review requested of someone the API did not name')
    }
    if (e.kind === 'assigned' && e.assignee === me) return keep('assigned to you')
  }
  if (a.truncated) return keep('more activity than could be fetched')

  // Your own actions and events that never notify are not activity to judge.
  // Mentions and assignments of other people never notify you either.
  const notifying = events.filter(e => e.kind !== 'neutral' && e.kind !== 'mentioned' && e.kind !== 'assigned')
  const active = notifying.filter(e => !('actor' in e && e.actor !== null && e.actor === me))
  if (active.length === 0) {
    return keep(notifying.length > 0 ? 'only your own activity' : 'no visible activity')
  }

  const pr = a.subject.type === 'PullRequest'
  const closed = a.subject.state !== 'OPEN'

  if (pr && a.subject.isDraft) {
    if (a.subject.viewerDidAuthor) {
      const said = active.find(e => e.kind === 'comment' || e.kind === 'review' || e.kind === 'review-comment')
      if (said) return keep(`${describe(said)} on your draft`)
    }
    const unscanned = events.reduce((n, e) => n + (e.kind === 'review' ? e.unscanned : 0), 0)
    if (unscanned > 0) {
      return keep(`${unscanned} review comment${unscanned === 1 ? '' : 's'} could not be scanned for a mention`)
    }
    return done('draft')
  }

  if (closed && !a.participating) return done('closed-not-participating')

  const closeAllowed = closed && a.lastReadAt !== null
  const hasClose = active.some(e => e.kind === 'closed' || e.kind === 'merged')
  let commits = false
  let requests = false
  for (const e of active) {
    switch (e.kind) {
      case 'commit':
      case 'force-push':
        if (a.subject.state === 'OPEN') {
          commits = true
          break
        }
        // Commits before a close you are allowed to skip ride along with it.
        if (hasClose && closeAllowed) break
        return keep(`${describe(e)} on a closed pull request`)
      case 'review-requested':
        requests = true
        break
      case 'closed':
      case 'merged':
        if (closeAllowed) break
        return keep(`${describe(e)}, and you had not read it`)
      default:
        return keep(describe(e))
    }
  }
  if (hasClose) return done('closed-read')
  if (commits) return done('commit')
  if (requests) return done('review-request')
  return keep('no visible activity')
}
