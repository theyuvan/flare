'use client'

// Sweeping a derived account, done entirely in the browser.
//
// The private key for a derived account never leaves this tab — not to the
// backend, not to the wallet extension. Every field of the transaction is read
// from chain state here rather than accepted from a server, so nothing can
// redirect the funds.

import { JsonRpcProvider, Wallet, formatEther } from 'ethers'
import { coston2 } from '@/lib/chain'

const GAS_LIMIT = 21000n

export type SweepResult = {
  hash: string
  amount: string
  stranded: string
}

function rpc(): JsonRpcProvider {
  return new JsonRpcProvider(coston2.rpcUrls.default.http[0], {
    chainId: coston2.id,
    name: coston2.name,
  })
}

/**
 * Fee cap for the sweep.
 *
 * Anything reserved but unspent is stranded in the derived account forever,
 * because after the claim the nullifier is burned and the app will not sweep it
 * again. ethers defaults maxFeePerGas to baseFee*2 + tip, which on Coston2
 * (~500 gwei base) stranded 21% of a small payment. baseFee*1.5 still absorbs
 * roughly three blocks of maximum base-fee growth (1.125^3 = 1.42) while
 * halving the waste.
 */
async function feeCap(provider: JsonRpcProvider) {
  const [feeData, block] = await Promise.all([provider.getFeeData(), provider.getBlock('latest')])
  const tip = feeData.maxPriorityFeePerGas ?? 0n
  const baseFee = block?.baseFeePerGas
  const maxFeePerGas =
    baseFee != null ? (baseFee * 3n) / 2n + tip : (feeData.maxFeePerGas ?? feeData.gasPrice)
  if (!maxFeePerGas) throw new Error('Could not read the gas price from the Coston2 RPC')
  return { maxFeePerGas, tip }
}

/** What the recipient will actually receive, for display before they commit. */
export async function previewSweep(derivedAddress: string) {
  const provider = rpc()
  const [balance, { maxFeePerGas }] = await Promise.all([
    provider.getBalance(derivedAddress),
    feeCap(provider),
  ])
  const gasCost = maxFeePerGas * GAS_LIMIT
  return {
    balance: formatEther(balance),
    fee: formatEther(gasCost),
    receives: balance > gasCost ? formatEther(balance - gasCost) : '0',
    coversFee: balance > gasCost,
  }
}

export async function sweepToWallet(
  derivedPrivKey: string,
  recipientAddress: string,
): Promise<SweepResult> {
  const provider = rpc()
  const wallet = new Wallet(derivedPrivKey, provider)

  const [balance, { maxFeePerGas, tip }] = await Promise.all([
    provider.getBalance(wallet.address),
    feeCap(provider),
  ])

  const gasCost = maxFeePerGas * GAS_LIMIT
  if (balance <= gasCost) {
    throw new Error(
      `Derived balance ${formatEther(balance)} C2FLR does not cover the ${formatEther(gasCost)} C2FLR sweep fee`,
    )
  }

  const value = balance - gasCost
  const tx = await wallet.sendTransaction({
    to: recipientAddress,
    value,
    gasLimit: GAS_LIMIT,
    maxFeePerGas,
    maxPriorityFeePerGas: tip,
  })
  const receipt = await tx.wait()
  if (!receipt) throw new Error('Sweep transaction was dropped')

  const spent = receipt.gasUsed * (receipt.gasPrice ?? maxFeePerGas)
  return {
    hash: receipt.hash,
    amount: formatEther(value),
    stranded: formatEther(gasCost - spent),
  }
}
