import type { Actor, RestNotification, Subject, Thread } from './types'

const API = 'https://api.github.com'

/**
 * The GitHub token, read server-side only. Never expose this to the client —
 * every GitHub call goes through a route handler or a server component.
 */
export function getToken(): string {
  const token = process.env.GITHUB_TOKEN
  if (!token) {
    throw new Error(
      'GITHUB_TOKEN is not set. Add it to .env.local — see .env.local.example.',
    )
  }
  return token
}

async function rest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${getToken()}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...init?.headers,
    },
    // Notifications are the live state we are triaging; never serve them stale.
    cache: 'no-store',
  })
  if (!res.ok) {
    throw new Error(`GitHub ${init?.method ?? 'GET'} ${path} → ${res.status} ${await res.text()}`)
  }
  return res.status === 205 || res.status === 204 ? (undefined as T) : res.json()
}

async function graphql<T>(query: string): Promise<T> {
  const res = await fetch(`${API}/graphql`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${getToken()}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query }),
    cache: 'no-store',
  })
  if (!res.ok) throw new Error(`GitHub GraphQL → ${res.status} ${await res.text()}`)
  const body = await res.json()
  // Partial failures are normal here: a repo we lost access to nulls out one
  // alias while the rest of the batch resolves. Keep the data, drop the noise.
  return body.data as T
}

export interface ListOptions {
  /** Include read threads. GitHub's "Inbox" view is all=true; it still excludes Done. */
  all?: boolean
  /** Only threads the user is directly participating in. */
  participating?: boolean
  perPage?: number
  page?: number
}

export async function fetchNotifications(opts: ListOptions = {}): Promise<RestNotification[]> {
  const params = new URLSearchParams({
    all: String(opts.all ?? true),
    participating: String(opts.participating ?? false),
    per_page: String(opts.perPage ?? 50),
    page: String(opts.page ?? 1),
  })
  return rest<RestNotification[]>(`/notifications?${params}`)
}

/** Pulls the issue/PR number off a subject API url, e.g. .../pulls/2065 → 2065. */
function subjectNumber(n: RestNotification): number | null {
  const match = n.subject.url?.match(/\/(\d+)$/)
  return match ? Number(match[1]) : null
}

const SUBJECT_FIELDS = `
  __typename
  number
  url
  author { login avatarUrl }
  labels(first: 8) { nodes { name color } }
  comments(last: 3) { totalCount nodes { author { login avatarUrl } } }
`

/**
 * Fetches issue/PR state, labels, participants and diff size for every thread in
 * one GraphQL round trip. Aliases are grouped by repository so a repo with ten
 * notifications is looked up once rather than ten times.
 */
export async function hydrate(
  notifications: RestNotification[],
): Promise<Map<string, Subject>> {
  const hydratable = notifications.filter(
    n => (n.subject.type === 'Issue' || n.subject.type === 'PullRequest') && subjectNumber(n),
  )
  if (hydratable.length === 0) return new Map()

  const byRepo = new Map<string, RestNotification[]>()
  for (const n of hydratable) {
    const list = byRepo.get(n.repository.full_name) ?? []
    list.push(n)
    byRepo.set(n.repository.full_name, list)
  }

  // alias → notification id, so we can put the response back together
  const aliases = new Map<string, string>()
  const repoBlocks: string[] = []

  ;[...byRepo.entries()].forEach(([fullName, group], repoIndex) => {
    const [owner, name] = fullName.split('/')
    const fields = group
      .map((n, i) => {
        const alias = `n${repoIndex}_${i}`
        aliases.set(alias, n.id)
        return `${alias}: issueOrPullRequest(number: ${subjectNumber(n)}) {
          ... on Issue { ${SUBJECT_FIELDS} state stateReason }
          ... on PullRequest {
            ${SUBJECT_FIELDS}
            state isDraft merged additions deletions changedFiles reviewDecision
          }
        }`
      })
      .join('\n')
    repoBlocks.push(
      `r${repoIndex}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {\n${fields}\n}`,
    )
  })

  type Raw = Record<string, Record<string, RawSubject | null> | null>
  const data = await graphql<Raw>(`query {\n${repoBlocks.join('\n')}\n}`)

  const result = new Map<string, Subject>()
  for (const repo of Object.values(data ?? {})) {
    if (!repo) continue
    for (const [alias, raw] of Object.entries(repo)) {
      const id = aliases.get(alias)
      if (id && raw) result.set(id, normalize(raw))
    }
  }
  return result
}

interface RawSubject {
  __typename: 'Issue' | 'PullRequest'
  number: number
  url: string
  state: string
  stateReason?: string | null
  isDraft?: boolean
  merged?: boolean
  additions?: number
  deletions?: number
  changedFiles?: number
  reviewDecision?: string | null
  author: Actor | null
  labels: { nodes: { name: string; color: string }[] }
  comments: { totalCount: number; nodes: { author: Actor | null }[] }
}

function normalize(raw: RawSubject): Subject {
  // Recent commenters read as "who is active on this thread"; fall back to the
  // author so dependabot PRs with no discussion still show a face.
  const candidates = [...raw.comments.nodes.map(c => c.author), raw.author].filter(
    (a): a is Actor => Boolean(a),
  )
  const recentActors: Actor[] = []
  for (const actor of candidates) {
    if (!recentActors.some(a => a.login === actor.login)) recentActors.push(actor)
  }

  return {
    typename: raw.__typename,
    number: raw.number,
    url: raw.url,
    state: raw.state,
    stateReason: raw.stateReason ?? null,
    isDraft: raw.isDraft ?? false,
    merged: raw.merged ?? false,
    author: raw.author,
    labels: raw.labels.nodes,
    commentCount: raw.comments.totalCount,
    recentActors: recentActors.slice(0, 3),
    additions: raw.additions ?? null,
    deletions: raw.deletions ?? null,
    changedFiles: raw.changedFiles ?? null,
    reviewDecision: raw.reviewDecision ?? null,
  }
}

/** Best-effort web url for a thread we could not hydrate. */
function fallbackUrl(n: RestNotification): string {
  const number = subjectNumber(n)
  if (!number) return n.repository.html_url
  const segment = n.subject.type === 'PullRequest' ? 'pull' : 'issues'
  return `${n.repository.html_url}/${segment}/${number}`
}

/** Notifications joined with their hydrated subjects — the shape the UI renders. */
export async function listThreads(opts: ListOptions = {}): Promise<Thread[]> {
  const notifications = await fetchNotifications(opts)
  const subjects = await hydrate(notifications)
  return notifications.map(n => {
    const subject = subjects.get(n.id) ?? null
    return {
      id: n.id,
      unread: n.unread,
      reason: n.reason,
      updatedAt: n.updated_at,
      title: n.subject.title,
      repo: n.repository.full_name,
      repoUrl: n.repository.html_url,
      private: n.repository.private,
      htmlUrl: subject?.url ?? fallbackUrl(n),
      type: n.subject.type,
      number: subject?.number ?? subjectNumber(n),
      subject,
    }
  })
}

export async function markThreadRead(id: string): Promise<void> {
  await rest(`/notifications/threads/${id}`, { method: 'PATCH' })
}

/** "Done" in GitHub's UI — removes the thread from the inbox listing entirely. */
export async function markThreadDone(id: string): Promise<void> {
  await rest(`/notifications/threads/${id}`, { method: 'DELETE' })
}

export async function unsubscribeThread(id: string): Promise<void> {
  await rest(`/notifications/threads/${id}/subscription`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ignored: true }),
  })
}
