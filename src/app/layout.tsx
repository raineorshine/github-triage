import type { Metadata } from 'next'
import Link from 'next/link'
import { MarkGithubIcon } from '@primer/octicons-react'
import './globals.css'

export const metadata: Metadata = {
  title: 'Notifications · Triage',
  description: 'A triage-focused view of GitHub notifications',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <header className="topbar">
          <Link className="topbarBrand" href="/">
            <MarkGithubIcon size={28} />
          </Link>
          <h1 className="topbarTitle">Notifications</h1>
        </header>
        {children}
      </body>
    </html>
  )
}
