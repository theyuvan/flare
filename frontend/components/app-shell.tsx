'use client'

import type { ReactNode } from 'react'
import dynamic from 'next/dynamic'
import { Manrope } from 'next/font/google'
import AppNav from '@/components/app-nav'

const manrope = Manrope({ subsets: ['latin'] })

// three.js is ~300kB and purely decorative here — split it into its own chunk
// so the forms are interactive before the background arrives.
const GridScene = dynamic(() => import('@/components/grid-scene'), {
  ssr: false,
  loading: () => <div className="fixed inset-0 bg-black" />,
})

export default function AppShell({
  title,
  description,
  children,
}: {
  title: string
  description: string
  children: ReactNode
}) {
  return (
    // `dark` switches the shadcn tokens; `flare-accent` swaps primary to orange.
    <div className={`dark flare-accent relative min-h-screen bg-black text-white ${manrope.className}`}>
      {/* Heavier overlay and fewer boxes than the landing page — texture, not
          competition, behind the forms. */}
      <GridScene boxes={5} overlay="from-black/85 via-black/80 to-black" />

      <div className="relative z-10">
        <AppNav />
        <main className="mx-auto max-w-3xl px-4 py-10">
          <div className="mb-8">
            <h1 className="text-3xl font-bold tracking-tight">{title}</h1>
            <p className="mt-2 text-sm leading-relaxed text-white/60">{description}</p>
          </div>
          <div className="space-y-6">{children}</div>
        </main>

        <footer className="border-t border-white/10 px-4 py-8">
          <div className="mx-auto max-w-3xl text-xs text-white/40">
            © {new Date().getFullYear()} FlarePay — Flare Coston2 Testnet
          </div>
        </footer>
      </div>
    </div>
  )
}
