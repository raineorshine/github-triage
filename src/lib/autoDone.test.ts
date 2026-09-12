import { test } from 'node:test'
import assert from 'node:assert/strict'
import { evaluate, mentionPattern, type Activity, type ActivitySubject } from './autoDone.ts'
import type { TimelineEvent } from './timeline.ts'

const ME = 'raineorshine'
const T0 = '2026-09-01T00:00:00Z'
const READ = '2026-09-10T00:00:00Z'
const T1 = '2026-09-11T00:00:00Z'
const T2 = '2026-09-12T00:00:00Z'

function subject(patch: Partial<ActivitySubject> = {}): ActivitySubject {
  return {
    type: 'PullRequest',
    state: 'OPEN',
    isDraft: false,
    viewerDidAuthor: false,
    author: 'alice',
    createdAt: T0,
    body: 'Fixes the thing.',
    ...patch,
  }
}

function activity(patch: Partial<Activity> = {}): Activity {
  return {
    viewer: ME,
    lastReadAt: READ,
    participating: false,
    subject: subject(),
    events: [],
    truncated: false,
    ...patch,
  }
}

const commit = (actor = 'alice', body = 'wip'): TimelineEvent => ({ kind: 'commit', at: T1, actor, body })
const comment = (actor = 'bob', body = 'looks fine'): TimelineEvent => ({ kind: 'comment', at: T1, actor, body })
const review = (actor = 'bob', body = '', unscanned = 0): TimelineEvent => ({ kind: 'review', at: T1, actor, body, unscanned })
const requested = (name: string | null, kind: 'user' | 'team' | 'bot' | 'unknown' = 'user'): TimelineEvent => ({
  kind: 'review-requested',
  at: T1,
  actor: 'alice',
  reviewer: { kind, name },
})
const closed = (actor = 'alice'): TimelineEvent => ({ kind: 'closed', at: T2, actor })
const merged = (actor = 'alice'): TimelineEvent => ({ kind: 'merged', at: T2, actor })
const neutral: TimelineEvent = { kind: 'neutral', typename: 'LabeledEvent' }

const verdict = (a: Activity) => evaluate(a).verdict
const rule = (a: Activity) => evaluate(a).rule
const detail = (a: Activity) => evaluate(a).detail

test('mention pattern matches the login as a whole word, case-insensitively', () => {
  const p = mentionPattern(ME)
  assert.ok(p.test('@raineorshine can you look?'))
  assert.ok(p.test('(cc @RaineOrShine)'))
  assert.ok(!p.test('@raineorshine-bot'))
  assert.ok(!p.test('@raineorshine2'))
  assert.ok(!p.test('mail@raineorshine.example'))
  assert.ok(!p.test('raineorshine without the at'))
})

test('rule 1: new commits on an open PR you had read', () => {
  const a = activity({ events: [commit(), { kind: 'force-push', at: T1, actor: 'alice' }] })
  assert.equal(rule(a), 'commit')
})

test('a comment alongside the commits keeps the thread', () => {
  const a = activity({ events: [commit(), comment('bob')] })
  assert.equal(verdict(a), 'keep')
  assert.equal(detail(a), 'comment by bob')
})

test('rule 2: review requested of another user or a bot', () => {
  assert.equal(rule(activity({ events: [requested('bob')] })), 'review-request')
  assert.equal(rule(activity({ events: [requested('copilot', 'bot')] })), 'review-request')
})

test('a review requested of you, a team, or nobody the API names keeps the thread', () => {
  assert.equal(detail(activity({ events: [requested(ME)] })), 'review requested of you')
  assert.equal(detail(activity({ events: [requested('core', 'team')] })), 'review requested of team core')
  assert.equal(verdict(activity({ events: [requested(null, 'unknown')] })), 'keep')
})

test('rule 3: closed without your participation, whatever was said', () => {
  const a = activity({
    lastReadAt: null,
    participating: false,
    subject: subject({ state: 'MERGED' }),
    events: [commit(), comment('bob'), review('carol', 'LGTM'), merged()],
  })
  assert.equal(rule(a), 'closed-not-participating')
})

test('rule 3 still yields to a mention', () => {
  const base = {
    lastReadAt: null,
    participating: false,
    subject: subject({ state: 'CLOSED', type: 'Issue' as const }),
  }
  assert.equal(detail(activity({ ...base, events: [comment('bob', 'ping @raineorshine'), closed()] })), 'mentioned in a comment by bob')
  assert.equal(detail(activity({ ...base, events: [{ kind: 'mentioned', at: T1, mentioned: ME }, closed()] })), 'you were mentioned')
  assert.equal(
    detail(activity({ ...base, subject: subject({ state: 'CLOSED', body: 'as @raineorshine said' }), events: [closed()] })),
    'mentioned in a opened by alice',
  )
})

test('rule 4: closed after you read it, with nothing else since', () => {
  const a = activity({ participating: true, subject: subject({ state: 'CLOSED', type: 'Issue' }), events: [closed('bob')] })
  assert.equal(rule(a), 'closed-read')
})

test('rule 4 lets the commits before a merge ride along', () => {
  const a = activity({ participating: true, subject: subject({ state: 'MERGED' }), events: [commit(), commit(), merged()] })
  assert.equal(rule(a), 'closed-read')
})

test('a comment before the close keeps a thread you took part in', () => {
  const a = activity({ participating: true, subject: subject({ state: 'CLOSED' }), events: [comment('bob'), closed()] })
  assert.equal(detail(a), 'comment by bob')
})

test('a close you had never read keeps a thread you took part in', () => {
  const a = activity({ lastReadAt: null, participating: true, subject: subject({ state: 'MERGED', viewerDidAuthor: true, author: ME }), events: [merged('bob')] })
  assert.equal(detail(a), 'merge by bob, and you had not read it')
})

test('commits on a closed PR with no close in the window keep it', () => {
  const a = activity({ participating: true, subject: subject({ state: 'CLOSED' }), events: [commit()] })
  assert.equal(detail(a), 'commit by alice on a closed pull request')
})

test('rule 5: a draft PR with no mention, whatever the activity', () => {
  const a = activity({ subject: subject({ isDraft: true }), events: [commit(), comment('bob'), review('carol', 'nit')] })
  assert.equal(rule(a), 'draft')
})

test('rule 5 yields to a mention anywhere in the new activity', () => {
  const a = activity({ subject: subject({ isDraft: true }), events: [review('carol', '', 0), { kind: 'review-comment', at: T1, actor: 'carol', body: '@raineorshine thoughts?' }] })
  assert.equal(detail(a), 'mentioned in a review comment by carol')
})

test('comments on your own draft are kept; commits on it are not', () => {
  const mine = subject({ isDraft: true, viewerDidAuthor: true, author: ME })
  assert.equal(detail(activity({ subject: mine, events: [comment('bob')] })), 'comment by bob on your draft')
  assert.equal(rule(activity({ subject: mine, events: [commit('bob')] })), 'draft')
})

test('a draft with review comments that could not be scanned is kept', () => {
  const a = activity({ subject: subject({ isDraft: true }), events: [review('carol', '', 12)] })
  assert.equal(detail(a), '12 review comments could not be scanned for a mention')
})

test('a PR or issue opened in the window is activity of its own', () => {
  const opened = subject({ createdAt: T1 })
  assert.equal(detail(activity({ lastReadAt: null, subject: opened, events: [commit()] })), 'opened by alice')
  assert.equal(detail(activity({ lastReadAt: null, subject: subject({ createdAt: T1, type: 'Issue' }) })), 'opened by alice')
  assert.equal(rule(activity({ lastReadAt: null, subject: subject({ createdAt: T1, isDraft: true }), events: [commit()] })), 'draft')
  assert.equal(
    detail(activity({ lastReadAt: null, subject: subject({ createdAt: T1, isDraft: true, body: 'cc @raineorshine' }), events: [commit()] })),
    'mentioned in a opened by alice',
  )
})

test('neutral events are ignored, alone or alongside', () => {
  assert.equal(rule(activity({ events: [commit(), neutral, neutral] })), 'commit')
  assert.equal(detail(activity({ events: [neutral] })), 'no visible activity')
  assert.equal(detail(activity({ events: [] })), 'no visible activity')
})

test('your own actions are ignored', () => {
  assert.equal(detail(activity({ events: [comment(ME)] })), 'only your own activity')
  assert.equal(rule(activity({ events: [commit(ME), commit('bob')] })), 'commit')
  assert.equal(
    detail(activity({ events: [{ kind: 'review-requested', at: T1, actor: ME, reviewer: { kind: 'user', name: 'bob' } }] })),
    'only your own activity',
  )
})

test('an assignment to you blocks; to someone else it is ignored', () => {
  assert.equal(detail(activity({ events: [{ kind: 'assigned', at: T1, actor: 'alice', assignee: ME }] })), 'assigned to you')
  assert.equal(rule(activity({ events: [commit(), { kind: 'assigned', at: T1, actor: 'alice', assignee: 'bob' }] })), 'commit')
})

test('a mention of someone else is ignored', () => {
  assert.equal(rule(activity({ events: [commit(), { kind: 'mentioned', at: T1, mentioned: 'bob' }] })), 'commit')
})

test('a truncated window keeps the thread, unless a blocker is already visible', () => {
  assert.equal(detail(activity({ truncated: true, events: [commit()] })), 'more activity than could be fetched')
  assert.equal(detail(activity({ truncated: true, events: [comment('bob', '@raineorshine')] })), 'mentioned in a comment by bob')
})

test('anything the rules do not cover keeps the thread', () => {
  assert.equal(detail(activity({ events: [commit(), { kind: 'reopened', at: T1, actor: 'bob' }] })), 'reopen by bob')
  assert.equal(detail(activity({ events: [{ kind: 'ready-for-review', at: T1, actor: 'bob' }] })), 'marked ready for review by bob')
  assert.equal(detail(activity({ events: [{ kind: 'unknown', typename: 'PullRequestCommitCommentThread' }] })), 'unknown event PullRequestCommitCommentThread')
  assert.equal(detail(activity({ events: [review('bob', 'LGTM')] })), 'review by bob')
})
