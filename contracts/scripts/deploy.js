// Deploy both contracts to Flare Coston2.
//   npx hardhat run scripts/deploy.js --network coston2
const hre = require('hardhat')
const fs = require('fs')
const path = require('path')

const EXPLORER = 'https://coston2-explorer.flare.network'

async function main() {
  const [deployer] = await hre.ethers.getSigners()
  if (!deployer) {
    throw new Error('No deployer account — set DEPLOYER_PRIVATE_KEY in contracts/.env')
  }

  const balance = await hre.ethers.provider.getBalance(deployer.address)
  console.log(`Deployer: ${deployer.address}`)
  console.log(`Balance:  ${hre.ethers.formatEther(balance)} C2FLR\n`)
  if (balance === 0n) {
    throw new Error('Deployer has no C2FLR — fund it at https://faucet.flare.network (Coston2)')
  }

  const registry = await hre.ethers.deployContract('DerivedRegistry')
  await registry.waitForDeployment()
  const registryAddr = await registry.getAddress()
  console.log(`DerivedRegistry -> ${registryAddr}`)

  const verifier = await hre.ethers.deployContract('ZKVerifier')
  await verifier.waitForDeployment()
  const verifierAddr = await verifier.getAddress()
  console.log(`ZKVerifier      -> ${verifierAddr}\n`)

  const out = {
    network: 'coston2',
    chainId: 114,
    deployer: deployer.address,
    DerivedRegistry: registryAddr,
    ZKVerifier: verifierAddr,
    deployedAt: new Date().toISOString(),
  }
  const outPath = path.join(__dirname, '..', 'deployments.coston2.json')
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n')
  console.log(`Written to ${outPath}`)

  // Wire the addresses in automatically — a hand-copied address that is wrong
  // fails as a confusing decode error at runtime rather than anything obvious.
  patch(
    path.join(__dirname, '..', '..', 'backend', 'index.js'),
    [
      [/const REGISTRY_ADDR = '0x[0-9a-fA-F]{40}'.*/, `const REGISTRY_ADDR = '${registryAddr}' // DerivedRegistry.sol`],
      [/const VERIFIER_ADDR = '0x[0-9a-fA-F]{40}'.*/, `const VERIFIER_ADDR = '${verifierAddr}' // ZKVerifier.sol`],
    ],
    'backend/index.js',
  )

  patch(
    path.join(__dirname, '..', '..', 'README.md'),
    [
      [
        /(\| `DerivedRegistry` \| )`[^`]*`( \| )\[[^\]]*\]\([^)]*\)/,
        `$1\`${registryAddr}\`$2[View](${EXPLORER}/address/${registryAddr})`,
      ],
      [
        /(\| `ZKVerifier` \| )`[^`]*`( \| )\[[^\]]*\]\([^)]*\)/,
        `$1\`${verifierAddr}\`$2[View](${EXPLORER}/address/${verifierAddr})`,
      ],
    ],
    'README.md',
  )

  console.log('\nDone. Restart the backend to pick up the new addresses.')
}

/** Apply [regex, replacement] pairs to a file, reporting anything that missed. */
function patch(filePath, replacements, label) {
  if (!fs.existsSync(filePath)) {
    console.warn(`  ! ${label} not found — update it by hand`)
    return
  }
  let text = fs.readFileSync(filePath, 'utf8')
  let applied = 0
  for (const [pattern, replacement] of replacements) {
    if (!pattern.test(text)) continue
    text = text.replace(pattern, replacement)
    applied++
  }
  if (applied === replacements.length) {
    fs.writeFileSync(filePath, text)
    console.log(`  ✓ updated ${label}`)
  } else {
    console.warn(`  ! ${label}: matched ${applied}/${replacements.length} placeholders — update it by hand`)
  }
}

main().catch((e) => {
  console.error(e)
  process.exitCode = 1
})
