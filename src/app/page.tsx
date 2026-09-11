import NotificationList from '@/components/NotificationList'
import Sidebar, { type Filters } from '@/components/Sidebar'
import { listThreads } from '@/lib/github'
import type { Thread } from '@/lib/types'

export const dynamic = 'force-dynamic'

/** View names map onto the two flags the notifications endpoint actually takes. */
function listOptions(view: string) {
  return {
    all: view !== 'unread',
    participating: view === 'participating',
    perPage: 50,
  }
}

function applyFilters(threads: Thread[], filters: Filters): Thread[] {
  return threads.filter(
    t =>
      (!filters.repo || t.repo === filters.repo) &&
      (!filters.reason || t.reason === filters.reason),
  )
}

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}) {
  const params = await searchParams
  const one = (key: string) => (Array.isArray(params[key]) ? params[key][0] : params[key])
  const filters: Filters = {
    view: one('view') ?? 'inbox',
    repo: one('repo'),
    reason: one('reason'),
  }

  let threads: Thread[] = []
  let error: string | null = null
  try {
    threads = await listThreads(listOptions(filters.view))
  } catch (e) {
    error = e instanceof Error ? e.message : String(e)
  }

  if (error) {
    return (
      <main className="layout">
        <div className="error">
          <h2>Could not load notifications</h2>
          <pre>{error}</pre>
        </div>
      </main>
    )
  }

  // The sidebar counts every thread in the view; the list shows what survives
  // the repo/reason filters.
  return (
    <main className="layout">
      <Sidebar threads={threads} filters={filters} />
      <NotificationList threads={applyFilters(threads, filters)} />
    </main>
  )
}
