import { LockIcon } from '@primer/octicons-react'
import AvatarStack from './AvatarStack'
import StateIcon from './StateIcon'
import { stateKind, timeAgo } from '@/lib/display'
import type { Thread } from '@/lib/types'

interface Props {
  thread: Thread
  selected: boolean
  onToggle: (id: string, shiftKey: boolean) => void
}

export default function NotificationRow({ thread, selected, onToggle }: Props) {
  const actors = thread.subject?.recentActors ?? []
  return (
    <li className="row" data-unread={thread.unread} data-selected={selected}>
      {/* onClick, not onChange: React's checkbox onChange wraps the native `input`
          event, which carries no shiftKey. Click covers the keyboard path too,
          since space-activating a checkbox dispatches a click. */}
      <input
        type="checkbox"
        className="rowCheck"
        checked={selected}
        readOnly
        aria-label={`Select ${thread.title}`}
        onClick={e => onToggle(thread.id, e.shiftKey)}
      />

      <StateIcon kind={stateKind(thread)} />

      <span className="rowMain">
        <span className="rowRepo">
          {thread.private && <LockIcon size={12} />}
          {thread.repo}
          {thread.number != null && ` #${thread.number}`}
        </span>
        <a className="rowTitle" href={thread.htmlUrl} target="_blank" rel="noreferrer">
          {thread.title}
        </a>
        {/* Auto Done would dismiss this thread; say which rule, in the open. */}
        {thread.autoDone?.verdict === 'done' && (
          <span className="rowAuto">
            <span className="rowAutoBadge">auto</span>
            {thread.autoDone.detail}
          </span>
        )}
      </span>

      <AvatarStack actors={actors} />

      <time className="rowTime" dateTime={thread.updatedAt} title={new Date(thread.updatedAt).toLocaleString()}>
        {timeAgo(thread.updatedAt)}
      </time>
    </li>
  )
}
