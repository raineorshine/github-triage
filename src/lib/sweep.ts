import { appendFile, mkdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { Rule } from './autoDone'
import { fetchThread, listThreads, markThreadDone } from './github'
import type { Thread } from './types'

/**
 * One Auto Done sweep: list every unread thread, judge each, and — in apply
 * mode — mark the dismissible ones done. Marking done is the one write in this
 * app that cannot be undone or even listed afterwards, so every dismissal (and,
 * dry-run, every one that would have happened) goes to an append-only audit
 * log, the single file this app writes.
 */

export const AUDIT_LOG =
  process.env.AUTO_DONE_LOG ?? join(homedir(), 'Library', 'Logs', 'github-triage-auto-done.jsonl')

export type SweepMode = 'dry-run' | 'apply'

export interface SweepOptions {
  /** Mark threads done. Without it the sweep only reports. */
  apply: boolean
  /** Restrict the sweep to these thread ids — the inbox button sends the rows it shows. */
  ids?: string[]
}

export type Outcome = 'done' | 'would-done' | 'skipped' | 'failed' | 'kept'

export interface ThreadOutcome {
  id: string
  repo: string
  number: number | null
  type: string
  title: string
  url: string
  reason: string
  updatedAt: string
  lastReadAt: string | null
  rule: Rule | null
  detail: string
  outcome: Outcome
  note?: string
}

export interface SweepReport {
  mode: SweepMode
  startedAt: string
  finishedAt: string
  /** Unread threads listed. */
  unread: number
  /** Of those, issues and pull requests that were judged. */
  evaluated: number
  done: number
  skipped: number
  failed: number
  kept: number
  threads: ThreadOutcome[]
  auditLog: string
}

async function audit(entry: Record<string, unknown>): Promise<void> {
  try {
    await mkdir(dirname(AUDIT_LOG), { recursive: true })
    await appendFile(AUDIT_LOG, `${JSON.stringify(entry)}\n`)
  } catch (e) {
    console.error(`auto-done: could not write ${AUDIT_LOG}:`, e)
  }
}

function outcomeOf(t: Thread, outcome: Outcome, note?: string): ThreadOutcome {
  return {
    id: t.id,
    repo: t.repo,
    number: t.number,
    type: t.type,
    title: t.title,
    url: t.htmlUrl,
    reason: t.reason,
    updatedAt: t.updatedAt,
    lastReadAt: t.lastReadAt,
    rule: t.autoDone?.rule ?? null,
    detail: t.autoDone?.detail ?? '',
    outcome,
    ...(note ? { note } : {}),
  }
}

export async function sweep(opts: SweepOptions): Promise<SweepReport> {
  const mode: SweepMode = opts.apply ? 'apply' : 'dry-run'
  const startedAt = new Date().toISOString()
  const unread = await listThreads({ all: false, allPages: true })
  const only = opts.ids ? new Set(opts.ids) : null
  const outcomes: ThreadOutcome[] = []

  for (const t of unread) {
    if (!t.autoDone || (only && !only.has(t.id))) continue
    if (t.autoDone.verdict === 'keep') {
      outcomes.push(outcomeOf(t, 'kept'))
      continue
    }
    if (!opts.apply) {
      outcomes.push(outcomeOf(t, 'would-done'))
      continue
    }
    // The race: anything landing between the judgement and the DELETE would be
    // hidden by it. Re-read the thread immediately before, and only go ahead
    // if it is exactly what was judged — the window is then one request wide.
    try {
      const fresh = await fetchThread(t.id)
      if (!fresh.unread) {
        outcomes.push(outcomeOf(t, 'skipped', 'read since it was judged'))
        continue
      }
      if (fresh.updated_at !== t.updatedAt || fresh.last_read_at !== t.lastReadAt) {
        outcomes.push(outcomeOf(t, 'skipped', 'changed since it was judged'))
        continue
      }
      await markThreadDone(t.id)
      outcomes.push(outcomeOf(t, 'done'))
    } catch (e) {
      outcomes.push(outcomeOf(t, 'failed', e instanceof Error ? e.message : String(e)))
    }
  }

  const count = (outcome: Outcome) => outcomes.filter(o => o.outcome === outcome).length
  const finishedAt = new Date().toISOString()
  for (const o of outcomes) {
    if (o.outcome !== 'kept') await audit({ ts: finishedAt, event: o.outcome, mode, ...o })
  }
  const report: SweepReport = {
    mode,
    startedAt,
    finishedAt,
    unread: unread.length,
    evaluated: outcomes.length,
    done: count('done'),
    skipped: count('skipped'),
    failed: count('failed'),
    kept: count('kept'),
    threads: outcomes,
    auditLog: AUDIT_LOG,
  }
  await audit({
    ts: finishedAt,
    event: 'sweep',
    mode,
    unread: report.unread,
    evaluated: report.evaluated,
    done: report.done,
    wouldDone: count('would-done'),
    skipped: report.skipped,
    failed: report.failed,
    kept: report.kept,
    cwd: process.cwd(),
  })
  return report
}
