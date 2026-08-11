/**
 * Reads announcements from DerivedRegistry.
 *
 * The enclave fetches these itself rather than having them passed in on-chain:
 * the announcement list is public, often large, and paying calldata for it per
 * scan would be absurd. Only the scan key needs confidentiality, and that
 * arrives sealed.
 */

import { createPublicClient, http, parseAbi } from "viem";
import { CHAIN_RPC_URL, MAX_SCAN_BATCH, REGISTRY_ADDRESS } from "./config.js";
import type { Announcement } from "./crypto.js";

const REGISTRY_ABI = parseAbi([
  "function getCount() external view returns (uint256)",
  "function getAnnouncements(uint256 from, uint256 count) external view returns ((uint256 id, bytes derivedAddress, bytes ephemeralR, address sender, uint256 timestamp)[])",
]);

function client() {
  return createPublicClient({ transport: http(CHAIN_RPC_URL) });
}

export async function getAnnouncementCount(): Promise<number> {
  const count = await client().readContract({
    address: REGISTRY_ADDRESS as `0x${string}`,
    abi: REGISTRY_ABI,
    functionName: "getCount",
  });
  return Number(count);
}

/** Fetch a bounded window of announcements, normalised for the scanner. */
export async function fetchAnnouncements(from: number, count: number): Promise<Announcement[]> {
  const bounded = Math.min(Math.max(count, 0), MAX_SCAN_BATCH);
  if (bounded === 0) return [];

  const raw = await client().readContract({
    address: REGISTRY_ADDRESS as `0x${string}`,
    abi: REGISTRY_ABI,
    functionName: "getAnnouncements",
    args: [BigInt(from), BigInt(bounded)],
  });

  return raw.map((a) => ({
    id: Number(a.id),
    derivedAddress: a.derivedAddress.replace(/^0x/i, "").toLowerCase(),
    ephemeralR: a.ephemeralR.replace(/^0x/i, "").toLowerCase(),
  }));
}
