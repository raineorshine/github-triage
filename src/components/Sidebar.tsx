import Link from 'next/link'
import { BookmarkIcon, CheckIcon, InboxIcon, RepoIcon } from '@primer/octicons-react'
import { reasonLabel } from '@/lib/display'
import type { Thread } from '@/lib/types'

export interface Filters {
  view: string
  repo?: string
  reason?: string
}

function href(filters: Filters, patch: Partial<Filters>): string {
  const next = { ...filters, ...patch }
  const params = new URLSearchParams()
  if (next.view && next.view !== 'inbox') params.set('view', next.view)
  if (next.repo) params.set('repo', next.repo)
  if (next.reason) params.set('reason', next.reason)
  const query = params.toString()
  return query ? `/?${query}` : '/'
}

function countBy(threads: Thread[], key: (t: Thread) => string): [string, number][] {
  const counts = new Map<string, number>()
  for (const t of threads) counts.set(key(t), (counts.get(key(t)) ?? 0) + 1)
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
}

/**
 * Filters are encoded in the URL rather than stored, so the app keeps no state
 * of its own — GitHub stays the only source of truth.
 */
export default function Sidebar({ threads, filters }: { threads: Thread[]; filters: Filters }) {
  const repos = countBy(threads, t => t.repo)
  const reasons = countBy(threads, t => t.reason)

  return (
    <nav className="sidebar" aria-label="Notification filters">
      <ul className="navGroup">
        <li>
          <Link className="navItem" href={href(filters, { view: 'inbox' })} data-active={filters.view === 'inbox'}>
            <InboxIcon size={16} />
            Inbox
          </Link>
        </li>
        <li>
          <Link className="navItem" href={href(filters, { view: 'unread' })} data-active={filters.view === 'unread'}>
            <span className="unreadDot" />
            Unread
          </Link>
        </li>
        <li>
          <Link
            className="navItem"
            href={href(filters, { view: 'participating' })}
            data-active={filters.view === 'participating'}
          >
            <CheckIcon size={16} />
            Participating
          </Link>
        </li>
        <li>
          <span className="navItem" data-disabled title="GitHub's REST API does not expose saved threads">
            <BookmarkIcon size={16} />
            Saved
          </span>
        </li>
        <li>
          <span className="navItem" data-disabled title="GitHub's REST API does not expose done threads">
            <CheckIcon size={16} />
            Done
          </span>
        </li>
      </ul>

      <h2 className="navHeading">Reason</h2>
      <ul className="navGroup">
        {reasons.map(([reason, count]) => (
          <li key={reason}>
            <Link
              className="navItem"
              href={href(filters, { reason: filters.reason === reason ? undefined : reason })}
              data-active={filters.reason === reason}
            >
              <span className="navItemLabel">{reasonLabel(reason)}</span>
              <span className="navCount">{count}</span>
            </Link>
          </li>
        ))}
      </ul>

      <h2 className="navHeading">Repositories</h2>
      <ul className="navGroup">
        {repos.map(([repo, count]) => (
          <li key={repo}>
            <Link
              className="navItem"
              href={href(filters, { repo: filters.repo === repo ? undefined : repo })}
              data-active={filters.repo === repo}
              title={repo}
            >
              <RepoIcon size={16} />
              <span className="navItemLabel">{repo.split('/')[1]}</span>
              <span className="navCount">{count}</span>
            </Link>
          </li>
        ))}
      </ul>
    </nav>
  )
}
