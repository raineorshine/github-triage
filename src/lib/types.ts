/** Raw notification thread as returned by GET /notifications. */
export interface RestNotification {
  id: string
  unread: boolean
  reason: string
  updated_at: string
  last_read_at: string | null
  subject: {
    title: string
    url: string | null
    latest_comment_url: string | null
    type: string
  }
  repository: {
    id: number
    name: string
    full_name: string
    private: boolean
    html_url: string
    owner: { login: string; avatar_url: string }
  }
  url: string
  subscription_url: string
}

export interface Actor {
  login: string
  avatarUrl: string
}

export interface Label {
  name: string
  color: string
}

/** The subset of issue/PR data we pull from GraphQL to enrich a thread. */
export interface Subject {
  typename: 'Issue' | 'PullRequest'
  number: number
  url: string
  state: string
  /** Issues only: COMPLETED | NOT_PLANNED | REOPENED */
  stateReason: string | null
  isDraft: boolean
  merged: boolean
  author: Actor | null
  labels: Label[]
  commentCount: number
  /** Most recent commenters, newest last. Approximates the notification's actors. */
  recentActors: Actor[]
  /** PRs only. Feeds the effort gradient. */
  additions: number | null
  deletions: number | null
  changedFiles: number | null
  reviewDecision: string | null
}

/** A notification joined with its hydrated subject. */
export interface Thread {
  id: string
  unread: boolean
  reason: string
  updatedAt: string
  title: string
  repo: string
  repoUrl: string
  private: boolean
  /** Falls back to the repo URL when the subject could not be resolved. */
  htmlUrl: string
  type: string
  number: number | null
  subject: Subject | null
}
