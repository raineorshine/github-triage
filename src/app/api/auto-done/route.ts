import type { NextRequest } from 'next/server'
import { sweep } from '@/lib/sweep'

/**
 * POST /api/auto-done — one Auto Done sweep over the unread inbox.
 *
 * A dry run unless `?apply=1` (or a JSON body with `apply: true`) — the timer
 * in scripts/auto-done-service.sh is installed one way or the other. A body
 * with `ids` restricts the sweep to those threads: the inbox button sends the
 * rows it is showing. There is deliberately no GET: nothing that merely loads
 * a page of this app — the user's tab, a worktree preview being polled — may
 * write to GitHub.
 */
export async function POST(request: NextRequest) {
  let apply = request.nextUrl.searchParams.get('apply') === '1'
  let ids: string[] | undefined
  const body: unknown = await request.json().catch(() => null)
  if (body && typeof body === 'object') {
    const b = body as { apply?: unknown; ids?: unknown }
    if (b.apply === true) apply = true
    if (Array.isArray(b.ids)) ids = b.ids.map(String)
  }
  try {
    return Response.json(await sweep({ apply, ids }))
  } catch (e) {
    return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status: 500 })
  }
}
