'use client'

import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Alert, AlertDescription } from '@/components/ui/alert'
import { Badge } from '@/components/ui/badge'
import AppShell from '@/components/app-shell'
import { API, txUrl, addressUrl, shorten } from '@/lib/chain'
import type { Announcement } from '@/lib/scan-browser'

const PAGE_SIZE = 20

export default function HistoryPage() {
  const [announcements, setAnnouncements] = useState<Announcement[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(0)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const load = useCallback(async (pageIndex: number) => {
    setLoading(true)
    setError('')
    try {
      const res = await fetch(`${API}/announcements?from=${pageIndex * PAGE_SIZE}&count=${PAGE_SIZE}`)
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Failed to load announcements')
      setAnnouncements(data.announcements || [])
      setTotal(data.total || 0)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Unknown error')
      setAnnouncements([])
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load(page)
  }, [load, page])

  const lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1)

  return (
    <AppShell
      title="Announcement history"
      description="Every derived payment hint ever published. Public by design — and it identifies no one."
    >
      {error && (
        <Alert variant="destructive">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {loading && <p className="text-sm text-white/60">Loading…</p>}

      {!loading && !error && announcements.length === 0 && (
        <Alert className="glass">
          <AlertDescription>No announcements yet. Send a private payment to create the first one.</AlertDescription>
        </Alert>
      )}

      {announcements.map((ann) => (
        <Card key={ann.id} className="glass">
          <CardContent className="space-y-2 p-4">
            <div className="flex items-center justify-between">
              <Badge variant="secondary">#{ann.id}</Badge>
              <span className="text-xs text-white/60">
                {ann.timestamp ? new Date(ann.timestamp).toLocaleString() : '—'}
              </span>
            </div>

            <dl className="space-y-1 font-mono text-xs">
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-white/60">derivedPub</dt>
                <dd className="truncate">{shorten(ann.derivedAddress, 14, 10)}</dd>
              </div>
              <div className="flex gap-2">
                <dt className="w-24 shrink-0 text-white/60">ephemeralR</dt>
                <dd className="truncate">{shorten(ann.ephemeralR, 14, 10)}</dd>
              </div>
              {ann.evmAddress && (
                <div className="flex gap-2">
                  <dt className="w-24 shrink-0 text-white/60">account</dt>
                  <dd>
                    <a className="underline" href={addressUrl(ann.evmAddress)} target="_blank" rel="noreferrer">
                      {shorten(ann.evmAddress, 10, 8)}
                    </a>
                  </dd>
                </div>
              )}
              {ann.metadata?.txHash && (
                <div className="flex gap-2">
                  <dt className="w-24 shrink-0 text-white/60">payment</dt>
                  <dd>
                    <a className="underline" href={txUrl(ann.metadata.txHash)} target="_blank" rel="noreferrer">
                      {shorten(ann.metadata.txHash, 10, 8)}
                    </a>
                  </dd>
                </div>
              )}
            </dl>
          </CardContent>
        </Card>
      ))}

      {total > PAGE_SIZE && (
        <div className="flex items-center justify-between pt-2">
          <Button variant="outline" size="sm" disabled={page === 0 || loading} onClick={() => setPage((p) => p - 1)}>
            Previous
          </Button>
          <span className="text-xs text-white/60">
            Page {page + 1} of {lastPage + 1} · {total} total
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= lastPage || loading}
            onClick={() => setPage((p) => p + 1)}
          >
            Next
          </Button>
        </div>
      )}
    </AppShell>
  )
}
