'use client'

import Link from 'next/link'
import { Manrope } from 'next/font/google'
import WalletConnect from '@/components/wallet-connect'
import GridScene from '@/components/grid-scene'

const manrope = Manrope({ subsets: ['latin'] })

const NAV = [
  { href: '/send', label: 'Send' },
  { href: '/receive', label: 'Receive' },
  { href: '/prove', label: 'Prove & Claim' },
  { href: '/history', label: 'History' },
]

const STEPS = [
  { n: '01', title: 'Register', body: 'Generate a secp256k1 meta-address. Share it like a username; the private half never leaves your device.' },
  { n: '02', title: 'Send', body: 'The sender derives a fresh one-time address over ECDH. Nothing on-chain ties it to you.' },
  { n: '03', title: 'Scan', body: 'Your browser matches announcements locally with @noble/curves. No server sees your key.' },
  { n: '04', title: 'Prove', body: 'A Groth16 proof runs in-tab via snarkjs WASM. A Poseidon nullifier blocks replays on-chain.' },
  { n: '05', title: 'Claim', body: 'Funds sweep to your real wallet. Two unlinked events remain on the chain record.' },
]

export default function Component() {
  return (
    <div className={`dark flare-accent relative min-h-screen bg-black text-white ${manrope.className}`}>
      <GridScene />

      <div className="relative z-10">
        <header className="p-4">
          <nav className="mx-auto flex max-w-6xl items-center justify-between gap-4">
            <Link href="/" className="text-xl font-bold tracking-tight">
              Flare<span className="text-[#ff6b1a]">Pay</span>
            </Link>
            <ul className="hidden gap-6 text-sm md:flex">
              {NAV.map((item) => (
                <li key={item.href}>
                  <Link href={item.href} className="text-white/70 transition-colors hover:text-white">
                    {item.label}
                  </Link>
                </li>
              ))}
            </ul>
            <WalletConnect />
          </nav>
        </header>

        <section className="mx-auto max-w-4xl px-4 pb-20 pt-24 text-center md:pt-32">
          <div className="mb-6 inline-block rounded-full border border-white/20 px-3 py-1 text-xs text-white/70">
            Flare Summer Signal Hackathon 2026 · Confidential Compute
          </div>
          <h1 className="mx-auto mb-6 max-w-3xl text-balance text-5xl font-bold leading-tight md:text-6xl">
            Private payments on Flare
          </h1>
          <p className="mx-auto mb-10 max-w-2xl text-balance text-lg text-white/70">
            Every payment lands at a fresh one-time address only you can recognise. Derived addresses for
            unlinkability, Groth16 proofs for ownership. No mixers, no bridges, no custodians.
          </p>
          <div className="flex flex-wrap items-center justify-center gap-3">
            <Link
              href="/receive"
              className="rounded-md bg-[#ff6b1a] px-6 py-3 font-bold text-black transition-colors hover:bg-[#ff8642]"
            >
              Get your meta-address
            </Link>
            <Link
              href="/send"
              className="rounded-md border border-white/25 px-6 py-3 font-bold transition-colors hover:bg-white/10"
            >
              Send a payment
            </Link>
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-4 pb-24">
          <div className="grid gap-4 md:grid-cols-5">
            {STEPS.map((step) => (
              <div key={step.n} className="rounded-lg border border-white/10 bg-black/40 p-5 backdrop-blur">
                <div className="mb-2 font-mono text-xs text-[#ff6b1a]">{step.n}</div>
                <h3 className="mb-2 font-semibold">{step.title}</h3>
                <p className="text-sm leading-relaxed text-white/60">{step.body}</p>
              </div>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-4xl px-4 pb-24">
          <div className="rounded-lg border border-white/10 bg-black/40 p-8 backdrop-blur">
            <h2 className="mb-4 text-2xl font-bold">Why zero-knowledge is the core</h2>
            <p className="mb-4 text-white/70">
              Claiming a derived payment requires proving you own it. Sign that with your meta-key and you have
              publicly linked the derived address to your identity — the privacy guarantee collapses.
            </p>
            <p className="text-white/70">
              Instead the key goes into a Circom circuit that outputs only a Poseidon commitment and a nullifier.
              The proof says <em>&ldquo;I know the key behind this meta-address&rdquo;</em> without showing it.
              The nullifier is registered on-chain, so the same proof can never be spent twice.
            </p>
          </div>
        </section>

        <footer className="border-t border-white/10 px-4 py-8">
          <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 text-sm text-white/50 md:flex-row">
            <span>© {new Date().getFullYear()} FlarePay — Built for the Flare Summer Signal Hackathon</span>
            <a
              className="transition-colors hover:text-white"
              href="https://coston2-explorer.flare.network"
              target="_blank"
              rel="noreferrer"
            >
              Running on Flare Coston2 Testnet
            </a>
          </div>
        </footer>
      </div>
    </div>
  )
}
