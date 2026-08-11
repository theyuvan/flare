'use client'

import { useState } from 'react'
import { useAccount } from 'wagmi'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import AppShell from '@/components/app-shell'
import { CopyField } from '@/components/copy-field'
import { API, txUrl, addressUrl, shorten } from '@/lib/chain'
import { isValidMetaPriv } from '@/lib/keys-browser'
import { scanAnnouncements, type OwnedPayment, type Announcement } from '@/lib/scan-browser'
import { generateProof, verifyProof, type ProveResult } from '@/lib/prove-browser'
import { sweepToWallet } from '@/lib/sweep-browser'

type Step = 'idle' | 'scanning' | 'proving' | 'verifying' | 'claiming' | 'sweeping' | 'done'

export default function ProvePage() {
  const { address, isConnected } = useAccount()

  const [metaPriv, setMetaPriv] = useState('')
  const [payments, setPayments] = useState<OwnedPayment[] | null>(null)
  const [selected, setSelected] = useState<OwnedPayment | null>(null)
  const [proof, setProof] = useState<ProveResult | null>(null)
  const [claim, setClaim] = useState<{ hash: string; amount: string; registerHash?: string } | null>(null)
  const [step, setStep] = useState<Step>('idle')
  const [error, setError] = useState('')

  async function scan() {
    setError('')
    setPayments(null)
    setSelected(null)
    setProof(null)
    setClaim(null)
    if (!isValidMetaPriv(metaPriv)) {
      setError('metaPriv must be 64 hex characters')
      return
    }
    setStep('scanning')
    try {
      const res = await fetch(`${API}/announcements?from=0&count=200`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to fetch announcements')

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
      setPayments(withBalances.filter((p) => p.balance != null && parseFloat(p.balance!) > 0))
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
    } finally {
      setStep('idle')
    }
  }

  async function proveAndClaim(payment: OwnedPayment) {
    if (!address) return
    setError('')
    setSelected(payment)
    setProof(null)
    setClaim(null)
    try {
      // Groth16 runs in this tab via snarkjs WASM. metaPriv stays here.
      setStep('proving')
      const result = await generateProof(metaPriv.trim(), '01')
      setProof(result)

      setStep('verifying')
      const ok = await verifyProof(result.proof, result.publicSignals)
      if (!ok) throw new Error('Locally generated proof failed verification — aborting before submission')

      // Phase 1 — the backend re-verifies the proof and burns the nullifier.
      // Note what is NOT in this body: the derived account's private key. The
      // backend is given only the public address so it can confirm the account
      // is funded before spending the nullifier.
      setStep('claiming')
      const res = await fetch(`${API}/address/claim`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          derivedAddress: payment.evmAddress,
          recipientAddress: address,
          metaCommitment: result.metaCommitment,
          nullifier: result.nullifier,
          context: result.publicSignals[2] ?? '1',
          proof: result.proof,
          publicSignals: result.publicSignals,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Claim failed')

      // Phase 2 — we sweep ourselves. The key stays in this tab and every
      // transaction field is read from the chain here, so nothing the server
      // returned can redirect the funds.
      setStep('sweeping')
      const swept = await sweepToWallet(payment.evmPrivKey, address)

      setClaim({ hash: swept.hash, amount: swept.amount, registerHash: data.registerHash })
      setStep('done')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
      setStep('idle')
    }
  }

  const busy = step !== 'idle' && step !== 'done'
  const stepLabel: Record<Step, string> = {
    idle: '',
    scanning: 'Scanning announcements…',
    proving: 'Generating Groth16 proof in your browser (10–30s)…',
    verifying: 'Verifying the proof locally…',
    claiming: 'Registering the nullifier on-chain…',
    sweeping: 'Signing the sweep in your browser and broadcasting…',
    done: '',
  }

  return (
    <AppShell
      title="Prove & claim"
      description="Prove you own a derived payment without revealing your key, then sweep it into your wallet."
    >
      {!isConnected && (
        <Alert className="glass">
          <AlertDescription>Connect your wallet — it is the destination for the swept funds.</AlertDescription>
        </Alert>
      )}

      <Card className="glass">
        <CardHeader>
          <CardTitle className="text-base">1 · Find your claimable payments</CardTitle>
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
              Used in this tab only — for ECDH matching and as the private witness to the ZK circuit.
            </p>
          </div>
          <Button onClick={scan} disabled={busy || !metaPriv}>
            {step === 'scanning' ? 'Scanning…' : 'Scan'}
          </Button>

          {payments && payments.length === 0 && (
            <Alert className="glass">
              <AlertDescription>No funded payments found for this key.</AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>

      {payments && payments.length > 0 && (
        <Card className="glass">
          <CardHeader>
            <CardTitle className="text-base">2 · Prove ownership and sweep</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {payments.map((p) => (
              <div key={p.id} className="glass flex items-center justify-between gap-3 rounded-lg border p-3">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <Badge variant="secondary">#{p.id}</Badge>
                    <span className="font-mono text-sm font-medium">{p.balance} C2FLR</span>
                  </div>
                  <a
                    className="block truncate font-mono text-xs text-white/60 underline"
                    href={addressUrl(p.evmAddress)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {shorten(p.evmAddress, 10, 8)}
                  </a>
                </div>
                <Button size="sm" disabled={busy || !isConnected} onClick={() => proveAndClaim(p)}>
                  {busy && selected?.id === p.id ? 'Working…' : 'Prove & claim'}
                </Button>
              </div>
            ))}

            {busy && stepLabel[step] && (
              <Alert className="glass">
                <AlertDescription>{stepLabel[step]}</AlertDescription>
              </Alert>
            )}
          </CardContent>
        </Card>
      )}

      {proof && (
        <Card className="glass">
          <CardHeader>
            <CardTitle className="text-base">Proof — public signals only</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4">
            <CopyField label="metaCommitment = Poseidon(metaPriv, metaPriv)" value={proof.metaCommitment} />
            <CopyField label="nullifier = Poseidon(metaPriv, context)" value={proof.nullifier} />
            <p className="text-xs text-white/60">
              These reveal nothing about metaPriv. The nullifier is registered on-chain so this proof cannot be
              replayed.
            </p>
          </CardContent>
        </Card>
      )}

      {claim && (
        <Alert className="glass">
          <AlertDescription className="space-y-1">
            <div>
              Swept <strong>{claim.amount} C2FLR</strong> to {shorten(address ?? '')}.
            </div>
            <a className="underline" href={txUrl(claim.hash)} target="_blank" rel="noreferrer">
              View transaction
            </a>
          </AlertDescription>
        </Alert>
      )}

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}
    </AppShell>
  )
}
