'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import WalletConnect from '@/components/wallet-connect'
import { cn } from '@/lib/utils'

const LINKS = [
  { href: '/send', label: 'Send' },
  { href: '/receive', label: 'Receive' },
  { href: '/prove', label: 'Prove & Claim' },
  { href: '/history', label: 'History' },
]

export default function AppNav() {
  const pathname = usePathname()

  return (
    <header className="sticky top-0 z-50 w-full border-b border-white/10 bg-black/60 backdrop-blur">
      <div className="mx-auto flex h-14 max-w-5xl items-center gap-6 px-4">
        <Link href="/" className="text-lg font-bold tracking-tight">
          Flare<span className="text-[#ff6b1a]">Pay</span>
        </Link>
        <nav className="hidden items-center gap-1 text-sm md:flex">
          {LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className={cn(
                'rounded-md px-3 py-1.5 transition-colors',
                pathname === link.href
                  ? 'bg-white/10 font-medium text-white'
                  : 'text-white/60 hover:text-white',
              )}
            >
              {link.label}
            </Link>
          ))}
        </nav>
        <div className="ml-auto">
          <WalletConnect />
        </div>
      </div>
    </header>
  )
}
