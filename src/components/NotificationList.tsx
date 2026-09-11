'use client'

import { useCallback, useMemo, useRef, useState } from 'react'
import NotificationRow from './NotificationRow'
import type { Thread } from '@/lib/types'

export default function NotificationList({ threads }: { threads: Thread[] }) {
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const lastToggled = useRef<string | null>(null)

  const toggle = useCallback(
    (id: string, shiftKey: boolean) => {
      // Read and move the anchor outside the updater. Mutating a ref inside one
      // makes it impure, and StrictMode's double-invoke would then collapse the
      // range to a single row on the second pass.
      const anchor = lastToggled.current
      lastToggled.current = id

      setSelected(prev => {
        const next = new Set(prev)
        // Shift-click extends the selection from the last toggled row, the way
        // GitHub's list does.
        if (shiftKey && anchor) {
          const from = threads.findIndex(t => t.id === anchor)
          const to = threads.findIndex(t => t.id === id)
          if (from !== -1 && to !== -1) {
            const [start, end] = from < to ? [from, to] : [to, from]
            const adding = !prev.has(id)
            for (let i = start; i <= end; i++) {
              if (adding) next.add(threads[i].id)
              else next.delete(threads[i].id)
            }
            return next
          }
        }
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      })
    },
    [threads],
  )

  const allSelected = threads.length > 0 && selected.size === threads.length
  const someSelected = selected.size > 0 && !allSelected

  const unreadCount = useMemo(() => threads.filter(t => t.unread).length, [threads])

  return (
    <div className="list">
      <div className="listHeader">
        <input
          type="checkbox"
          className="rowCheck"
          checked={allSelected}
          ref={el => {
            if (el) el.indeterminate = someSelected
          }}
          aria-label="Select all notifications"
          onChange={() =>
            setSelected(allSelected ? new Set() : new Set(threads.map(t => t.id)))
          }
        />
        <span className="listHeaderLabel">
          {selected.size > 0 ? `${selected.size} selected` : 'Select all'}
        </span>
        <span className="listHeaderSep">·</span>
        <button type="button" className="linkButton" disabled>
          Select by <span className="caret" />
        </button>
        <span className="listHeaderRight">
          {unreadCount} unread · {threads.length} shown
        </span>
      </div>

      {threads.length === 0 ? (
        <p className="empty">All caught up.</p>
      ) : (
        <ul className="rows">
          {threads.map(thread => (
            <NotificationRow
              key={thread.id}
              thread={thread}
              selected={selected.has(thread.id)}
              onToggle={toggle}
            />
          ))}
        </ul>
      )}
    </div>
  )
}
