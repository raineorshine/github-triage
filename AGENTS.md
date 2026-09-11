# github-triage

Next.js App Router. `npm run dev`, `npm run build`, `npx eslint .`.

## Constraints

- **No persistent state.** No database, no cache, no background sync. GitHub is
  the source of truth; filters live in the URL. Adding storage needs a deliberate
  decision, not a convenience.
- **The token is server-side only.** It is read in `lib/github.ts` via
  `getToken()`. Never pass it into a client component or a `NEXT_PUBLIC_` var.
- **Notifications are REST-only**; GraphQL cannot list them. Enrichment is a
  second, batched GraphQL query — keep it to one round trip.
- Route the page as `force-dynamic` with `cache: 'no-store'`. A cached inbox is
  a wrong inbox.

## Conventions

- Plain CSS in `app/globals.css` using the Primer-derived custom properties at
  the top. No CSS-in-JS, no utility framework.
- State-to-icon mapping lives in `lib/display.ts` (`stateKind`) and
  `components/StateIcon.tsx`. Add new subject types in both.
- Keep React state updaters pure — StrictMode double-invokes them. Mutate refs
  outside the updater.
