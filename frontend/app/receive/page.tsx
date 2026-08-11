'use client'

import { useState } from 'react'
import { useAccount, useSendTransaction, usePublicClient } from 'wagmi'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import AppShell from '@/components/app-shell'
import { CopyField } from '@/components/copy-field'
import { API, txUrl, addressUrl, FAUCET_URL, shorten } from '@/lib/chain'
import { generateMetaAddress, isValidMetaPriv, type MetaKeys } from '@/lib/keys-browser'
import { scanAnnouncements, type OwnedPayment, type Announcement } from '@/lib/scan-browser'

export default function ReceivePage() {
  const { address, isConnected } = useAccount()
  const { sendTransactionAsync } = useSendTransaction()
  const publicClient = usePublicClient()

  const [keys, setKeys] = useState<MetaKeys | null>(null)
  const [registerHash, setRegisterHash] = useState('')
  const [registering, setRegistering] = useState(false)

  const [metaPriv, setMetaPriv] = useState('')
  const [scanning, setScanning] = useState(false)
  const [results, setResults] = useState<OwnedPayment[] | null>(null)
  const [error, setError] = useState('')

  // Generated in the browser — metaPriv is never transmitted anywhere.
  function generate() {
    setError('')
    const k = generateMetaAddress()
    setKeys(k)
    setMetaPriv(k.metaPriv)
    setRegisterHash('')
  }

  // Anchors metaAddress to the connected wallet: a zero-value self-send whose
  // calldata is SHA256(metaAddress). Proves wallet ownership on-chain.
  async function register() {
    if (!keys || !address) return
    setError('')
    setRegistering(true)
    try {
      const res = await fetch(`${API}/keys/build-register-tx`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ walletAddress: address, metaAddress: keys.metaAddress }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Could not build the registration transaction')

      const hash = await sendTransactionAsync({
        to: data.tx.to as `0x${string}`,
        data: data.tx.data as `0x${string}`,
        value: 0n,
      })
      await publicClient?.waitForTransactionReceipt({ hash })

      await fetch(`${API}/keys/finalize-registration`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ walletAddress: address, metaAddress: keys.metaAddress, txHash: hash }),
      })
      setRegisterHash(hash)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setRegistering(false)
    }
  }

  async function scan() {
    setError('')
    setResults(null)
    if (!isValidMetaPriv(metaPriv)) {
      setError('metaPriv must be 64 hex characters')
      return
    }
    setScanning(true)
    try {
      // Public announcement list — no private key involved in this request.
      const res = await fetch(`${API}/announcements?from=0&count=200`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to fetch announcements')

      // ECDH matching runs here in the browser. metaPriv never leaves the tab.
      const matched = scanAnnouncements(metaPriv.trim(), (data.announcements || []) as Announcement[])

      const withBalances = await Promise.all(
        matched.map(async (ann) => {
          try {
            const br = await fetch(`${API}/address/balance/${ann.evmAddress}`)
            const bd = await br.json()
            return { ...ann, balance: bd.balance as string | null }
          } catch {
            return ann
          }
        }),
      )
      setResults(withBalances)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setScanning(false)
    }
  }

  const funded = results?.filter((r) => r.balance != null && parseFloat(r.balance) > 0) ?? []

  return (
    <AppShell
      title="Receive privately"
      description="Generate a meta-address, anchor it to your wallet, then scan for payments that only you can recognise."
    >
      <Card className="glass">
        <CardHeader>
          <CardTitle className="text-base">1 · Generate your meta-address</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <Button onClick={generate} variant={keys ? 'outline' : 'default'}>
            {keys ? 'Generate a new pair' : 'Generate keypair'}
          </Button>

          {keys && (
            <>
              <CopyField label="metaAddress — share this publicly" value={keys.metaAddress} />
              <CopyField label="metaPriv — save it now, it is never stored" value={keys.metaPriv} secret />
              <Alert variant="destructive">
                <AlertDescription>
                  metaPriv is shown once and held only in this tab. Nothing writes it to storage or sends it to a
                  server. Lose it and any payments to this meta-address are unrecoverable.
                </AlertDescription>
              </Alert>

              <div className="flex items-center gap-3">
                <Button onClick={register} disabled={!isConnected || registering}>
                  {registering ? 'Confirm in wallet…' : 'Anchor on-chain'}
                </Button>
                {!isConnected && <span className="text-xs text-white/60">Connect a wallet first</span>}
                {registerHash && (
                  <a className="text-xs underline" href={txUrl(registerHash)} target="_blank" rel="noreferrer">
                    View registration tx
                  </a>
                )}
              </div>
            </>
          )}
        </CardContent>
      </Card>

      <Card className="glass">
        <CardHeader>
          <CardTitle className="text-base">2 · Scan for incoming payments</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="metaPriv">metaPriv</Label>
            <Input
              id="metaPriv"
              type="password"
              className="font-mono text-xs"
              placeholder="64 hex characters"
              value={metaPriv}
              onChange={(e) => setMetaPriv(e.target.value)}
            />
            <p className="text-xs text-white/60">
              Matching runs locally in your browser. This key is not sent to the backend.
            </p>
          </div>
          <Button onClick={scan} disabled={scanning || !metaPriv}>
            {scanning ? 'Scanning…' : 'Scan for my payments'}
          </Button>

          {results && results.length === 0 && (
            <Alert className="glass">
              <AlertDescription>
                No payments found for this key. Ask a sender to pay your metaAddress, and make sure they published the
                announcement.
              </AlertDescription>
            </Alert>
          )}

          {funded.length > 0 && (
            <div className="space-y-3">
              {funded.map((p) => (
                <div key={p.id} className="glass rounded-lg border p-3 text-sm">
                  <div className="mb-2 flex items-center justify-between">
                    <Badge variant="secondary">#{p.id}</Badge>
                    <span className="font-mono font-medium">{p.balance} C2FLR</span>
                  </div>
                  <a
                    className="font-mono text-xs text-white/60 underline"
                    href={addressUrl(p.evmAddress)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {shorten(p.evmAddress, 10, 8)}
                  </a>
                </div>
              ))}
              <p className="text-xs text-white/60">
                Head to <strong>Prove &amp; Claim</strong> to sweep these into your wallet.
              </p>
            </div>
          )}

          {results && results.length > 0 && funded.length === 0 && (
            <Alert className="glass">
              <AlertDescription>
                Found {results.length} announcement(s) addressed to you, but all have a zero balance — the sender may
                not have funded them yet. Testnet C2FLR: <a className="underline" href={FAUCET_URL} target="_blank" rel="noreferrer">faucet.flare.network</a>
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </AppShell>
  )
}
