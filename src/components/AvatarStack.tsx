import type { Actor } from '@/lib/types'

/** Overlapping avatars for the people recently active on a thread. */
export default function AvatarStack({ actors }: { actors: Actor[] }) {
  if (actors.length === 0) return <span className="avatarStack" />
  return (
    <span className="avatarStack">
      {actors.map(actor => (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          key={actor.login}
          className="avatar"
          src={`${actor.avatarUrl}${actor.avatarUrl.includes('?') ? '&' : '?'}s=40`}
          alt={actor.login}
          title={actor.login}
          width={20}
          height={20}
        />
      ))}
    </span>
  )
}
