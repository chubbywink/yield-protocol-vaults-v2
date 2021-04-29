import { SignerWithAddress } from '@nomiclabs/hardhat-ethers/dist/src/signer-with-address'

import { Cauldron } from '../typechain/Cauldron'

import { ethers, waffle } from 'hardhat'
import { expect } from 'chai'
const { loadFixture } = waffle

import { YieldEnvironment } from './shared/fixtures'
import { LadleWrapper } from '../src/ladleWrapper'

describe('Ladle - vaults', function () {
  this.timeout(0)

  let env: YieldEnvironment
  let ownerAcc: SignerWithAddress
  let otherAcc: SignerWithAddress
  let owner: string
  let other: string
  let cauldron: Cauldron
  let ladle: LadleWrapper
  let ladleFromOther: LadleWrapper

  async function fixture() {
    return await YieldEnvironment.setup(ownerAcc, [baseId, ilkId, otherIlkId], [seriesId, otherSeriesId])
  }

  before(async () => {
    const signers = await ethers.getSigners()
    ownerAcc = signers[0]
    owner = await ownerAcc.getAddress()

    otherAcc = signers[1]
    other = await otherAcc.getAddress()
  })

  const baseId = ethers.utils.hexlify(ethers.utils.randomBytes(6))
  const ilkId = ethers.utils.hexlify(ethers.utils.randomBytes(6))
  const seriesId = ethers.utils.hexlify(ethers.utils.randomBytes(6))
  const otherIlkId = ethers.utils.hexlify(ethers.utils.randomBytes(6))
  const otherSeriesId = ethers.utils.hexlify(ethers.utils.randomBytes(6))
  const otherVaultId = ethers.utils.hexlify(ethers.utils.randomBytes(12))
  const emptyAssetId = '0x000000000000'
  const emptyAddress = ethers.utils.getAddress('0x0000000000000000000000000000000000000000')

  let vaultId: string

  beforeEach(async () => {
    env = await loadFixture(fixture)
    cauldron = env.cauldron
    ladle = env.ladle
    ladleFromOther = ladle.connect(otherAcc)

    vaultId = (env.vaults.get(seriesId) as Map<string, string>).get(ilkId) as string
  })

  it('builds a vault', async () => {
    await expect(ladle.build(otherVaultId, seriesId, ilkId))
      .to.emit(cauldron, 'VaultBuilt')
      .withArgs(otherVaultId, owner, seriesId, ilkId)

    const vault = await cauldron.vaults(otherVaultId)
    expect(vault.owner).to.equal(owner)
    expect(vault.seriesId).to.equal(seriesId)
    expect(vault.ilkId).to.equal(ilkId)
  })

  it('does not allow destroying vaults if not the vault owner', async () => {
    await expect(ladleFromOther.destroy(vaultId)).to.be.revertedWith('Only vault owner')
  })

  it('destroys a vault', async () => {
    expect(await ladle.destroy(vaultId))
      .to.emit(cauldron, 'VaultDestroyed')
      .withArgs(vaultId)
    const vault = await cauldron.vaults(vaultId)
    expect(vault.owner).to.equal(emptyAddress)
    expect(vault.seriesId).to.equal(emptyAssetId)
    expect(vault.ilkId).to.equal(emptyAssetId)
  })

  it('does not allow changing vaults if not the vault owner', async () => {
    await expect(ladleFromOther.tweak(vaultId, seriesId, ilkId)).to.be.revertedWith('Only vault owner')
  })

  it('changes a vault', async () => {
    expect(await ladle.tweak(vaultId, otherSeriesId, otherIlkId))
      .to.emit(cauldron, 'VaultTweaked')
      .withArgs(vaultId, otherSeriesId, otherIlkId)
    const vault = await cauldron.vaults(vaultId)
    expect(vault.owner).to.equal(owner)
    expect(vault.seriesId).to.equal(otherSeriesId)
    expect(vault.ilkId).to.equal(otherIlkId)
  })

  it('does not allow giving vaults if not the vault owner', async () => {
    await expect(ladleFromOther.give(vaultId, other)).to.be.revertedWith('Only vault owner')
  })

  it('gives a vault', async () => {
    expect(await ladle.give(vaultId, other))
      .to.emit(cauldron, 'VaultGiven')
      .withArgs(vaultId, other)
    const vault = await cauldron.vaults(vaultId)
    expect(vault.owner).to.equal(other)
    expect(vault.seriesId).to.equal(seriesId)
    expect(vault.ilkId).to.equal(ilkId)
  })
})
