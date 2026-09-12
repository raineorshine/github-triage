import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeTimeline, timelineItemFields, type RawTimelineNode } from './timeline.ts'

const READ = '2026-09-10T00:00:00Z'
const OLD = '2026-09-09T00:00:00Z'
const NEW = '2026-09-11T00:00:00Z'

test('comments, closes and mentions carry their actor and body', () => {
  const events = normalizeTimeline(
    [
      { __typename: 'IssueComment', createdAt: NEW, body: 'hi', author: { login: 'bob' } },
      { __typename: 'ClosedEvent', createdAt: NEW, actor: { login: 'alice' } },
      { __typename: 'MentionedEvent', createdAt: NEW, actor: { login: 'raineorshine' } },
    ],
    READ,
  )
  assert.deepEqual(events, [
    { kind: 'comment', at: NEW, actor: 'bob', body: 'hi' },
    { kind: 'closed', at: NEW, actor: 'alice' },
    { kind: 'mentioned', at: NEW, mentioned: 'raineorshine' },
  ])
})

test('a review folds its inline comments in and counts what was not fetched', () => {
  const events = normalizeTimeline(
    [
      {
        __typename: 'PullRequestReview',
        createdAt: NEW,
        body: '',
        author: { login: 'carol' },
        comments: { totalCount: 12, nodes: [{ createdAt: NEW, body: 'nit', author: { login: 'carol' } }] },
      },
    ],
    READ,
  )
  assert.deepEqual(events, [
    { kind: 'review', at: NEW, actor: 'carol', body: '', unscanned: 11 },
    { kind: 'review-comment', at: NEW, actor: 'carol', body: 'nit' },
  ])
})

test('a review thread contributes only the comments inside the window', () => {
  const events = normalizeTimeline(
    [
      {
        __typename: 'PullRequestReviewThread',
        comments: {
          totalCount: 2,
          nodes: [
            { createdAt: OLD, body: 'old', author: { login: 'carol' } },
            { createdAt: NEW, body: 'new', author: { login: 'dave' } },
          ],
        },
      },
    ],
    READ,
  )
  assert.deepEqual(events, [{ kind: 'review-comment', at: NEW, actor: 'dave', body: 'new' }])
})

test('commits take their date, author and message from the commit', () => {
  const node: RawTimelineNode = {
    __typename: 'PullRequestCommit',
    commit: { committedDate: NEW, message: 'fix: it', author: { user: null } },
  }
  assert.deepEqual(normalizeTimeline([node], READ), [{ kind: 'commit', at: NEW, actor: null, body: 'fix: it' }])
})

test('review requests classify the reviewer', () => {
  const at = NEW
  const actor = { login: 'alice' }
  const events = normalizeTimeline(
    [
      { __typename: 'ReviewRequestedEvent', createdAt: at, actor, requestedReviewer: { __typename: 'User', login: 'bob' } },
      { __typename: 'ReviewRequestedEvent', createdAt: at, actor, requestedReviewer: { __typename: 'Team', name: 'core' } },
      { __typename: 'ReviewRequestedEvent', createdAt: at, actor, requestedReviewer: { __typename: 'Bot', login: 'copilot' } },
      { __typename: 'ReviewRequestedEvent', createdAt: at, actor, requestedReviewer: null },
    ],
    READ,
  )
  assert.deepEqual(
    events.map(e => (e.kind === 'review-requested' ? e.reviewer : null)),
    [
      { kind: 'user', name: 'bob' },
      { kind: 'team', name: 'core' },
      { kind: 'bot', name: 'copilot' },
      { kind: 'unknown', name: null },
    ],
  )
})

test('listed bookkeeping is neutral; anything unlisted is unknown', () => {
  const events = normalizeTimeline(
    [
      { __typename: 'LabeledEvent' },
      { __typename: 'ConvertToDraftEvent' },
      { __typename: 'PullRequestCommitCommentThread' },
      { __typename: 'SomethingGitHubAddsNextYear' },
    ],
    READ,
  )
  assert.deepEqual(events, [
    { kind: 'neutral', typename: 'LabeledEvent' },
    { kind: 'neutral', typename: 'ConvertToDraftEvent' },
    { kind: 'unknown', typename: 'PullRequestCommitCommentThread' },
    { kind: 'unknown', typename: 'SomethingGitHubAddsNextYear' },
  ])
})

test('the pull request selection is a superset of the issue one', () => {
  const issue = timelineItemFields(false)
  const pr = timelineItemFields(true)
  assert.ok(pr.startsWith(issue))
  assert.ok(!issue.includes('PullRequestCommit'))
  assert.ok(pr.includes('PullRequestReviewThread'))
})
