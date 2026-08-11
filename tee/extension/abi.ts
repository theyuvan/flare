/**
 * ABI decoding for the SCAN instruction.
 *
 * Mirrors ScanRequest in contracts/FlarePayInstructionSender.sol. Keeping the
 * tuple layout here and the struct there in one commit is the whole discipline
 * — a silent field reorder decodes into garbage rather than erroring.
 */

import { decodeAbiParameters, type Hex } from "viem";

const SCAN_PARAMS = [
  {
    type: "tuple",
    components: [
      { name: "sealedScanKey", type: "bytes" },
      { name: "spendPub", type: "bytes" },
      { name: "fromId", type: "uint256" },
      { name: "count", type: "uint256" },
    ],
  },
] as const;

export interface ScanRequest {
  sealedScanKey: string;
  spendPub: string;
  fromId: bigint;
  count: bigint;
}

export function decodeScanRequest(data: Hex): ScanRequest {
  try {
    const [d] = decodeAbiParameters(SCAN_PARAMS, data);
    return {
      sealedScanKey: d.sealedScanKey,
      spendPub: d.spendPub,
      fromId: d.fromId,
      count: d.count,
    };
  } catch (e) {
    throw new Error(`ABI decode failed: ${e instanceof Error ? e.message : String(e)}`);
  }
}
