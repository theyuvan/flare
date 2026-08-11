'use client'

import { useAccount, useConnect, useDisconnect, useBalance, useSwitchChain } from 'wagmi'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { coston2, shorten } from '@/lib/chain'

export default function WalletConnect() {
  const { address, isConnected, chainId } = useAccount()
  const { connect, connectors, isPending } = useConnect()
  const { disconnect } = useDisconnect()
  const { switchChain } = useSwitchChain()
  const { data: balance } = useBalance({ address, chainId: coston2.id })

  // Discovered over EIP-6963 — MetaMask, Rabby, and friends all announce here.
  const injected = connectors.find((c) => c.type === 'injected') ?? connectors[0]

  if (!isConnected) {
    if (!injected) {
      return (
        <a
          className="text-xs underline"
          href="https://metamask.io/download"
          target="_blank"
          rel="noreferrer"
        >
          Install MetaMask
        </a>
      )
    }
    return (
      <Button size="sm" disabled={isPending} onClick={() => connect({ connector: injected })}>
        {isPending ? 'Connecting…' : 'Connect Wallet'}
      </Button>
    )
  }

  if (chainId !== coston2.id) {
    return (
      <Button size="sm" variant="destructive" onClick={() => switchChain({ chainId: coston2.id })}>
        Switch to Coston2
      </Button>
    )
  }

  return (
    <div className="flex items-center gap-2">
      {balance && (
        <Badge variant="secondary" className="font-mono text-xs">
          {Number(balance.formatted).toFixed(3)} {balance.symbol}
        </Badge>
      )}
      <span className="font-mono text-xs text-muted-foreground">{shorten(address!)}</span>
      <Button variant="outline" size="sm" onClick={() => disconnect()}>
        Disconnect
      </Button>
    </div>
  )
}
