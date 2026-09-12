import type { Metadata } from 'next'
import Link from 'next/link'
import { MarkGithubIcon } from '@primer/octicons-react'
import Settings from '@/components/Settings'
import { THEME_BOOT_SCRIPT } from '@/lib/theme'
import './globals.css'

export const metadata: Metadata = {
  title: 'Notifications · Triage',
  description: 'A triage-focused view of GitHub notifications',
}

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body>
        {/* Before anything paints: the chosen theme onto <html>, which the
            server cannot know. suppressHydrationWarning covers the attribute
            it adds. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
        <header className="topbar">
          <Link className="topbarBrand" href="/">
            <MarkGithubIcon size={28} />
          </Link>
          <h1 className="topbarTitle">Notifications</h1>
          <Settings />
        </header>
        {children}
      </body>
    </html>
  )
}
