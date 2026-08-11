import { defineChain } from 'viem'

export const coston2 = defineChain({
  id: 114,
  name: 'Flare Testnet Coston2',
  nativeCurrency: { name: 'Coston2 Flare', symbol: 'C2FLR', decimals: 18 },
  rpcUrls: {
    default: { http: ['https://coston2-api.flare.network/ext/C/rpc'] },
  },
  blockExplorers: {
    default: { name: 'Coston2 Explorer', url: 'https://coston2-explorer.flare.network' },
  },
  testnet: true,
})

export const API = process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'

const EXPLORER = coston2.blockExplorers.default.url
export const txUrl = (hash: string) => `${EXPLORER}/tx/${hash}`
export const addressUrl = (address: string) => `${EXPLORER}/address/${address}`

export const FAUCET_URL = 'https://faucet.flare.network'

export function shorten(value: string, lead = 6, tail = 4) {
  if (!value) return ''
  return value.length <= lead + tail + 1 ? value : `${value.slice(0, lead)}…${value.slice(-tail)}`
}
