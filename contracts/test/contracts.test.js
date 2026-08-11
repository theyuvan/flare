const { expect } = require('chai')
const { ethers } = require('hardhat')

const hex = (byte, len = 33) => '0x' + byte.repeat(len)

describe('DerivedRegistry', function () {
  let registry

  beforeEach(async function () {
    registry = await ethers.deployContract('DerivedRegistry')
  })

  it('starts empty', async function () {
    expect(await registry.getCount()).to.equal(0n)
  })

  it('stores an announcement and returns it', async function () {
    const [sender] = await ethers.getSigners()
    await (await registry.announce(hex('aa'), hex('bb'))).wait()

    expect(await registry.getCount()).to.equal(1n)
    const [ann] = await registry.getAnnouncements(0, 10)
    expect(ann.id).to.equal(0n)
    expect(ann.derivedAddress).to.equal(hex('aa'))
    expect(ann.ephemeralR).to.equal(hex('bb'))
    expect(ann.sender).to.equal(sender.address)
    expect(ann.timestamp).to.be.greaterThan(0n)
  })

  it('emits Announced', async function () {
    await expect(registry.announce(hex('cc'), hex('dd'))).to.emit(registry, 'Announced')
  })

  it('paginates and clamps a count past the end', async function () {
    for (let i = 0; i < 5; i++) await (await registry.announce(hex('0a'), hex('0b'))).wait()
    expect((await registry.getAnnouncements(0, 2)).length).to.equal(2)
    expect((await registry.getAnnouncements(3, 100)).length).to.equal(2) // clamped
    expect((await registry.getAnnouncements(99, 10)).length).to.equal(0) // past end
  })
})

describe('ZKVerifier', function () {
  let verifier
  const b32 = byte => '0x' + byte.repeat(32)
  const META = b32('11'), NULL = b32('22'), CTX = b32('33'), PROOF = b32('44')

  beforeEach(async function () {
    verifier = await ethers.deployContract('ZKVerifier')
  })

  it('reports an unseen nullifier as unused', async function () {
    expect(await verifier.isNullifierUsed(NULL)).to.equal(false)
  })

  it('registers a proof and marks the nullifier used', async function () {
    const [submitter] = await ethers.getSigners()
    await (await verifier.registerProof(META, NULL, CTX, PROOF)).wait()

    expect(await verifier.isNullifierUsed(NULL)).to.equal(true)
    const rec = await verifier.getProofRecord(NULL)
    expect(rec.metaCommitment).to.equal(META)
    expect(rec.context).to.equal(CTX)
    expect(rec.proofHash).to.equal(PROOF)
    expect(rec.submitter).to.equal(submitter.address)
  })

  // This is the replay guarantee the whole claim flow leans on.
  it('reverts on a replayed nullifier', async function () {
    await (await verifier.registerProof(META, NULL, CTX, PROOF)).wait()
    await expect(verifier.registerProof(META, NULL, CTX, PROOF))
      .to.be.revertedWith('Nullifier already used')
  })

  it('lets a different nullifier through', async function () {
    await (await verifier.registerProof(META, NULL, CTX, PROOF)).wait()
    await expect(verifier.registerProof(META, b32('55'), CTX, PROOF)).to.not.be.reverted
  })
})
