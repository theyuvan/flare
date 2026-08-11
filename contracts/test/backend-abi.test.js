// Guards the seam between the deployed contracts and the backend's hand-written
// minimal ABIs. If a signature drifts, this fails here rather than at runtime
// against Coston2.
const { expect } = require('chai')
const { ethers } = require('hardhat')
const { REGISTRY_ABI, VERIFIER_ABI } = require('../../backend/abi')

describe('backend ABIs match the compiled contracts', function () {
  it('every backend registry signature exists on DerivedRegistry', async function () {
    const deployed = (await ethers.getContractFactory('DerivedRegistry')).interface
    for (const frag of new ethers.Interface(REGISTRY_ABI).fragments) {
      if (frag.type !== 'function') continue
      expect(deployed.getFunction(frag.format('sighash')), `missing: ${frag.format()}`).to.not.equal(null)
    }
  })

  it('every backend verifier signature exists on ZKVerifier', async function () {
    const deployed = (await ethers.getContractFactory('ZKVerifier')).interface
    for (const frag of new ethers.Interface(VERIFIER_ABI).fragments) {
      if (frag.type !== 'function') continue
      expect(deployed.getFunction(frag.format('sighash')), `missing: ${frag.format()}`).to.not.equal(null)
    }
  })

  // The struct-array return is the part most likely to decode wrong.
  it('backend ABI round-trips a real announce + getAnnouncements', async function () {
    const registry = await ethers.deployContract('DerivedRegistry')
    const [signer] = await ethers.getSigners()
    const asBackend = new ethers.Contract(await registry.getAddress(), REGISTRY_ABI, signer)

    const derived = '0x' + 'ab'.repeat(33)
    const ephemeral = '0x' + 'cd'.repeat(33)
    await (await asBackend.announce(derived, ephemeral)).wait()

    expect(await asBackend.getCount()).to.equal(1n)
    const [ann] = await asBackend.getAnnouncements(0, 20)
    // Named-field access is exactly how backend/index.js mapAnnouncement reads it.
    expect(ann.id).to.equal(0n)
    expect(ann.derivedAddress).to.equal(derived)
    expect(ann.ephemeralR).to.equal(ephemeral)
    expect(ann.sender).to.equal(signer.address)
    expect(Number(ann.timestamp)).to.be.greaterThan(0)
  })

  it('backend ABI round-trips registerProof + isNullifierUsed', async function () {
    const verifier = await ethers.deployContract('ZKVerifier')
    const [signer] = await ethers.getSigners()
    const asBackend = new ethers.Contract(await verifier.getAddress(), VERIFIER_ABI, signer)

    // Field elements as the backend encodes them: decimal string -> bytes32.
    const toBytes32 = n => '0x' + BigInt(n).toString(16).padStart(64, '0')
    const nullifier = toBytes32('8953387924954729549148725203031787376900899980075307855838526308911707691121')
    const meta = toBytes32('1836897175097296442865155509384317664951896492970554239479683279086283585377')

    expect(await asBackend.isNullifierUsed(nullifier)).to.equal(false)
    await (await asBackend.registerProof(meta, nullifier, toBytes32('1'), '0x' + '99'.repeat(32))).wait()
    expect(await asBackend.isNullifierUsed(nullifier)).to.equal(true)
  })
})
