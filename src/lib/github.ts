import { evaluate, type ActivitySubject, type Verdict } from './autoDone'
import { normalizeTimeline, timelineItemFields, type RawTimelineNode, type TimelineEvent } from './timeline'
import type { Actor, RestNotification, Subject, Thread } from './types'

const API = 'https://api.github.com'
/** Pages of the notification listing a full read walks, at most. */
const MAX_PAGES = 10
/** timelineItems takes at most 100 per page; a window needing more is fetched in follow-up rounds. */
const TIMELINE_PAGE = 100
const TIMELINE_ROUNDS = 3

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
  // No data at all is a broken query, and that one is worth hearing about.
  if (body.data == null && body.errors) {
    throw new Error(`GitHub GraphQL → ${JSON.stringify(body.errors)}`)
  }
  return body.data as T
}

export interface ListOptions {
  /** Include read threads. GitHub's "Inbox" view is all=true; it still excludes Done. */
  all?: boolean
  /** Only threads the user is directly participating in. */
  participating?: boolean
  perPage?: number
  page?: number
  /** Walk every page rather than the first: the sweep wants the whole inbox. */
  allPages?: boolean
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

export async function fetchAllNotifications(opts: ListOptions = {}): Promise<RestNotification[]> {
  const perPage = opts.perPage ?? 50
  const all: RestNotification[] = []
  for (let page = 1; page <= MAX_PAGES; page++) {
    const batch = await fetchNotifications({ ...opts, perPage, page })
    all.push(...batch)
    if (batch.length < perPage) break
  }
  return all
}

/** One thread, fresh. The sweep re-reads a thread this way right before marking it done. */
export async function fetchThread(id: string): Promise<RestNotification> {
  return rest<RestNotification>(`/notifications/threads/${id}`)
}

/**
 * The unread threads GitHub counts you as participating in: opened, commented,
 * reviewed, assigned, asked to review, or mentioned. Its own definition, one
 * request, rather than a participants list per thread.
 */
export async function fetchParticipatingIds(): Promise<Set<string>> {
  const list = await fetchAllNotifications({ all: false, participating: true })
  return new Set(list.map(n => n.id))
}

/** Pulls the issue/PR number off a subject API url, e.g. .../pulls/2065 → 2065. */
function subjectNumber(n: RestNotification): number | null {
  const match = n.subject.url?.match(/\/(\d+)$/)
  return match ? Number(match[1]) : null
}

const SUBJECT_FIELDS = `
  __typename
  id
  number
  url
  author { login avatarUrl }
  labels(first: 8) { nodes { name color } }
  comments(last: 3) { totalCount nodes { author { login avatarUrl } } }
`

/** What Auto Done needs on top: who opened the thread, and the timeline since it was last read. */
function activityFields(n: RestNotification, isPullRequest: boolean): string {
  const since = n.last_read_at ? `, since: ${JSON.stringify(n.last_read_at)}` : ''
  return `
    createdAt
    body
    viewerDidAuthor
    timelineItems(first: ${TIMELINE_PAGE}${since}) {
      pageInfo { hasNextPage endCursor }
      nodes { ${timelineItemFields(isPullRequest)} }
    }`
}

interface RawTimelinePage {
  pageInfo: { hasNextPage: boolean; endCursor: string | null }
  nodes: RawTimelineNode[]
}

interface RawSubject {
  __typename: 'Issue' | 'PullRequest'
  id: string
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
  createdAt?: string
  body?: string | null
  viewerDidAuthor?: boolean
  timelineItems?: RawTimelinePage
}

/** The activity Auto Done judges, as hydrated for one thread. */
export interface HydratedActivity {
  subject: ActivitySubject
  events: TimelineEvent[]
  truncated: boolean
}

export interface Hydration {
  /** The login the token belongs to. */
  viewer: string | null
  threads: Map<string, { subject: Subject; activity: HydratedActivity | null }>
}

/** A thread whose timeline did not fit in one page. */
interface Pending {
  id: string
  nodeId: string
  isPullRequest: boolean
  since: string | null
  cursor: string
  nodes: RawTimelineNode[]
}

/**
 * Fetches the remaining timeline pages for threads whose window overflowed one
 * page, a round at a time, all threads in one query per round. Whatever still
 * has more after the last round is reported truncated.
 */
async function fetchMoreTimeline(pending: Pending[]): Promise<Set<string>> {
  let open = pending
  for (let round = 0; round < TIMELINE_ROUNDS && open.length > 0; round++) {
    const fields = open
      .map((p, i) => {
        const since = p.since ? `, since: ${JSON.stringify(p.since)}` : ''
        const type = p.isPullRequest ? 'PullRequest' : 'Issue'
        return `q${i}: node(id: ${JSON.stringify(p.nodeId)}) {
          ... on ${type} {
            timelineItems(first: ${TIMELINE_PAGE}, after: ${JSON.stringify(p.cursor)}${since}) {
              pageInfo { hasNextPage endCursor }
              nodes { ${timelineItemFields(p.isPullRequest)} }
            }
          }
        }`
      })
      .join('\n')
    const data = await graphql<Record<string, { timelineItems: RawTimelinePage } | null>>(`query {\n${fields}\n}`)
    const next: Pending[] = []
    open.forEach((p, i) => {
      const page = data?.[`q${i}`]?.timelineItems
      if (!page) {
        // A thread that stopped answering is one whose window we cannot see whole.
        next.push(p)
        return
      }
      p.nodes.push(...page.nodes)
      if (page.pageInfo.hasNextPage && page.pageInfo.endCursor) {
        next.push({ ...p, cursor: page.pageInfo.endCursor })
      }
    })
    open = next
  }
  return new Set(open.map(p => p.id))
}

export interface HydrateOptions {
  /** Which threads also get their activity fetched, for Auto Done. */
  activity?: (n: RestNotification) => boolean
}

/**
 * Fetches issue/PR state, labels, participants and diff size for every thread in
 * one GraphQL round trip. Aliases are grouped by repository so a repo with ten
 * notifications is looked up once rather than ten times. Threads selected by
 * `activity` also bring the timeline since they were last read; only a window
 * longer than a page costs a further round trip.
 */
export async function hydrate(
  notifications: RestNotification[],
  options: HydrateOptions = {},
): Promise<Hydration> {
  const empty: Hydration = { viewer: null, threads: new Map() }
  const hydratable = notifications.filter(
    n => (n.subject.type === 'Issue' || n.subject.type === 'PullRequest') && subjectNumber(n),
  )
  if (hydratable.length === 0) return empty

  const byRepo = new Map<string, RestNotification[]>()
  for (const n of hydratable) {
    const list = byRepo.get(n.repository.full_name) ?? []
    list.push(n)
    byRepo.set(n.repository.full_name, list)
  }

  // alias → notification, so we can put the response back together
  const aliases = new Map<string, RestNotification>()
  const repoBlocks: string[] = []

  ;[...byRepo.entries()].forEach(([fullName, group], repoIndex) => {
    const [owner, name] = fullName.split('/')
    const fields = group
      .map((n, i) => {
        const alias = `n${repoIndex}_${i}`
        aliases.set(alias, n)
        const withActivity = options.activity?.(n) ?? false
        return `${alias}: issueOrPullRequest(number: ${subjectNumber(n)}) {
          ... on Issue { ${SUBJECT_FIELDS} state stateReason ${withActivity ? activityFields(n, false) : ''} }
          ... on PullRequest {
            ${SUBJECT_FIELDS}
            state isDraft merged additions deletions changedFiles reviewDecision
            ${withActivity ? activityFields(n, true) : ''}
          }
        }`
      })
      .join('\n')
    repoBlocks.push(
      `r${repoIndex}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) {\n${fields}\n}`,
    )
  })

  type Raw = { viewer?: { login: string } | null } & Record<string, Record<string, RawSubject | null> | null | { login: string } | undefined>
  const data = await graphql<Raw>(`query {\nviewer { login }\n${repoBlocks.join('\n')}\n}`)

  const result: Hydration = { viewer: data?.viewer?.login ?? null, threads: new Map() }
  const pending: Pending[] = []
  const nodesById = new Map<string, RawTimelineNode[]>()
  for (const [key, repo] of Object.entries(data ?? {})) {
    if (!/^r\d+$/.test(key) || !repo) continue
    for (const [alias, raw] of Object.entries(repo as Record<string, RawSubject | null>)) {
      const n = aliases.get(alias)
      if (!n || !raw) continue
      let activity: HydratedActivity | null = null
      if (raw.timelineItems && raw.createdAt) {
        const nodes = [...raw.timelineItems.nodes]
        nodesById.set(n.id, nodes)
        const { hasNextPage, endCursor } = raw.timelineItems.pageInfo
        if (hasNextPage && endCursor) {
          pending.push({
            id: n.id,
            nodeId: raw.id,
            isPullRequest: raw.__typename === 'PullRequest',
            since: n.last_read_at,
            cursor: endCursor,
            nodes,
          })
        }
        activity = {
          subject: {
            type: raw.__typename,
            state: raw.state,
            isDraft: raw.isDraft ?? false,
            viewerDidAuthor: raw.viewerDidAuthor ?? false,
            author: raw.author?.login ?? null,
            createdAt: raw.createdAt,
            body: raw.body ?? '',
          },
          events: [],
          truncated: false,
        }
      }
      result.threads.set(n.id, { subject: normalize(raw), activity })
    }
  }

  const truncated = pending.length > 0 ? await fetchMoreTimeline(pending) : new Set<string>()
  for (const [id, entry] of result.threads) {
    if (!entry.activity) continue
    const n = notifications.find(x => x.id === id)
    entry.activity.events = normalizeTimeline(nodesById.get(id) ?? [], n?.last_read_at ?? null)
    entry.activity.truncated = truncated.has(id)
  }
  return result
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

/** Unread issues and pull requests are what Auto Done judges. */
function judged(n: RestNotification): boolean {
  return n.unread && (n.subject.type === 'Issue' || n.subject.type === 'PullRequest')
}

/**
 * Notifications joined with their hydrated subjects — the shape the UI renders —
 * each unread issue or PR carrying Auto Done's verdict on it. Three requests
 * when there is something to judge: the listing, the hydration, and the
 * participating listing that rule 3 reads.
 */
export async function listThreads(opts: ListOptions = {}): Promise<Thread[]> {
  const notifications = opts.allPages
    ? await fetchAllNotifications(opts)
    : await fetchNotifications(opts)
  // In the participating view every thread is participating by construction.
  const needsParticipation = !opts.participating && notifications.some(judged)
  // One request at a time, not Promise.all: GitHub's secondary rate limit
  // forbids concurrent requests for one user, and a 403 there shuts the inbox
  // for minutes.
  const hydration = await hydrate(notifications, { activity: judged })
  const participating = needsParticipation ? await fetchParticipatingIds() : null
  return notifications.map(n => {
    const hydrated = hydration.threads.get(n.id) ?? null
    const subject = hydrated?.subject ?? null
    let autoDone: Verdict | null = null
    if (hydrated?.activity && hydration.viewer) {
      autoDone = evaluate({
        viewer: hydration.viewer,
        lastReadAt: n.last_read_at,
        participating: participating ? participating.has(n.id) : true,
        subject: hydrated.activity.subject,
        events: hydrated.activity.events,
        truncated: hydrated.activity.truncated,
      })
    }
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
      lastReadAt: n.last_read_at,
      autoDone,
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
