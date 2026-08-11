'use client'

import { useState } from 'react'
import { parseEther } from 'viem'
import { useAccount, useSendTransaction, usePublicClient } from 'wagmi'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import AppShell from '@/components/app-shell'
import { CopyField } from '@/components/copy-field'
import { API, txUrl, addressUrl, shorten } from '@/lib/chain'
import { isValidMetaAddress } from '@/lib/keys-browser'

type Derived = { derivedPub: string; ephemeralR: string; evmAddress: string }

export default function SendPage() {
  const { address, isConnected } = useAccount()
  const { sendTransactionAsync } = useSendTransaction()
  const publicClient = usePublicClient()

  const [metaAddress, setMetaAddress] = useState('')
  const [amount, setAmount] = useState('')
  const [derived, setDerived] = useState<Derived | null>(null)
  const [status, setStatus] = useState<'idle' | 'deriving' | 'sending' | 'announcing' | 'done'>('idle')
  const [sentHash, setSentHash] = useState('')
  const [error, setError] = useState('')

  async function derive() {
    setError('')
    setDerived(null)
    setSentHash('')
    if (!isValidMetaAddress(metaAddress.trim())) {
      setError('metaAddress must be a 66-char compressed secp256k1 pubkey starting with 02 or 03')
      return
    }
    setStatus('deriving')
    try {
      const res = await fetch(`${API}/address/derive`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ metaAddress: metaAddress.trim() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Derivation failed')
      setDerived(data)
      setStatus('idle')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
      setStatus('idle')
    }
  }

  async function send() {
    if (!derived) return
    setError('')
    setStatus('sending')
    try {
      // The payment goes straight to the one-time derived account. Nothing
      // on-chain links it back to the recipient's meta-address.
      const hash = await sendTransactionAsync({
        to: derived.evmAddress as `0x${string}`,
        value: parseEther(amount),
      })
      await publicClient?.waitForTransactionReceipt({ hash })
      setSentHash(hash)

      // Publish the hint so the recipient can find it while scanning.
      setStatus('announcing')
      const res = await fetch(`${API}/announcements`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          derivedAddress: derived.derivedPub,
          ephemeralR: derived.ephemeralR,
          evmAddress: derived.evmAddress,
          metadata: { txHash: hash },
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(`Payment sent, but the announcement failed: ${data.error}`)
      setStatus('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
      setStatus('idle')
    }
  }

  const busy = status !== 'idle' && status !== 'done'

  return (
    <AppShell
      title="Send a private payment"
      description="Derive a fresh one-time address from the recipient's public meta-address, pay it, then publish the hint."
    >
      {!isConnected && (
        <Alert className="glass">
          <AlertDescription>Connect your wallet to send a payment.</AlertDescription>
        </Alert>
      )}

      <Card className="glass">
        <CardHeader>
          <CardTitle className="text-base">Recipient</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="metaAddress">Recipient metaAddress</Label>
            <Input
              id="metaAddress"
              className="font-mono text-xs"
              placeholder="02…"
              value={metaAddress}
              onChange={(e) => setMetaAddress(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="amount">Amount (C2FLR)</Label>
            <Input
              id="amount"
              type="number"
              step="0.001"
              min="0"
              placeholder="1.0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <Button onClick={derive} disabled={busy || !metaAddress || !amount}>
            {status === 'deriving' ? 'Deriving…' : 'Derive derived address'}
          </Button>
        </CardContent>
      </Card>

      {derived && (
        <Card className="glass">
          <CardHeader>
            <CardTitle className="text-base">One-time derived address</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <CopyField label="Derived pubkey (announced on-chain)" value={derived.derivedPub} />
            <CopyField label="Ephemeral R (announced on-chain)" value={derived.ephemeralR} />
            <CopyField label="EVM address receiving the funds" value={derived.evmAddress} />

            <Button onClick={send} disabled={busy || !isConnected}>
              {status === 'sending'
                ? 'Confirm in wallet…'
                : status === 'announcing'
                  ? 'Publishing announcement…'
                  : `Send ${amount || '0'} C2FLR`}
            </Button>

            {status === 'done' && (
              <Alert className="glass">
                <AlertDescription className="space-y-1">
                  <div>
                    Sent to{' '}
                    <a className="underline" href={addressUrl(derived.evmAddress)} target="_blank" rel="noreferrer">
                      {shorten(derived.evmAddress)}
                    </a>{' '}
                    and announced.
                  </div>
                  <a className="underline" href={txUrl(sentHash)} target="_blank" rel="noreferrer">
                    View transaction
                  </a>
                </AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </AppShell>
  )
}
