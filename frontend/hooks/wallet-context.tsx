'use client'

import { useState, type ReactNode } from 'react'
import { WagmiProvider, createConfig, http } from 'wagmi'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { coston2 } from '@/lib/chain'

// No explicit connector list: wagmi discovers injected wallets (MetaMask, Rabby,
// …) over EIP-6963 by default. Importing from 'wagmi/connectors' would pull the
// whole barrel in, including Coinbase's SDK and its unresolvable optional deps.
export const wagmiConfig = createConfig({
  chains: [coston2],
  transports: { [coston2.id]: http() },
  ssr: true,
})

export function WalletProvider({ children }: { children: ReactNode }) {
  // One client per mount — a module-level client leaks state between requests.
  const [queryClient] = useState(() => new QueryClient())

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  )
}
