const Pool = artifacts.require('Pool')

import { keccak256, toUtf8Bytes } from 'ethers/lib/utils'
// @ts-ignore
import helper from 'ganache-time-traveler'
// @ts-ignore
import { BN } from '@openzeppelin/test-helpers'
import { rate1, daiTokens1, toWad, bnify } from './../shared/utils'
import { YieldEnvironmentLite, Contract } from './../shared/fixtures'

contract('Pool', async (accounts) => {
  let [owner, user1, operator, from, to] = accounts

  const daiReserves = daiTokens1
  const eDaiTokens1 = daiTokens1
  const eDaiReserves = eDaiTokens1

  let env: YieldEnvironmentLite
  let dai: Contract
  let eDai1: Contract
  let pool: Contract

  let maturity1: number
  let snapshot: any
  let snapshotId: string

  const results = new Set()
  results.add(['trade', 'daiReserves', 'eDaiReserves', 'tokensIn', 'tokensOut'])

  beforeEach(async () => {
    snapshot = await helper.takeSnapshot()
    snapshotId = snapshot['result']

    const block = await web3.eth.getBlockNumber()
    maturity1 = (await web3.eth.getBlock(block)).timestamp + 1000

    env = await YieldEnvironmentLite.setup([maturity1])
    dai = env.maker.dai

    eDai1 = env.eDais[0]
    await eDai1.orchestrate(owner, keccak256(toUtf8Bytes('mint(address,uint256)')))

    // Setup Pool
    pool = await Pool.new(dai.address, eDai1.address, 'Name', 'Symbol', { from: owner })
  })

  afterEach(async () => {
    await helper.revertToSnapshot(snapshotId)
  })

  it('get the size of the contract', async () => {
    console.log()
    console.log('    ·--------------------|------------------|------------------|------------------·')
    console.log('    |  Contract          ·  Bytecode        ·  Deployed        ·  Constructor     |')
    console.log('    ·····················|··················|··················|···················')

    const bytecode = pool.constructor._json.bytecode
    const deployed = pool.constructor._json.deployedBytecode
    const sizeOfB = bytecode.length / 2
    const sizeOfD = deployed.length / 2
    const sizeOfC = sizeOfB - sizeOfD
    console.log(
      '    |  ' +
        pool.constructor._json.contractName.padEnd(18, ' ') +
        '|' +
        ('' + sizeOfB).padStart(16, ' ') +
        '  ' +
        '|' +
        ('' + sizeOfD).padStart(16, ' ') +
        '  ' +
        '|' +
        ('' + sizeOfC).padStart(16, ' ') +
        '  |'
    )
    console.log('    ·--------------------|------------------|------------------|------------------·')
    console.log()
  })

  describe('with liquidity', () => {
    beforeEach(async () => {
      await env.maker.getDai(user1, daiReserves, rate1)
      await eDai1.mint(user1, eDaiReserves, { from: owner })

      await dai.approve(pool.address, daiReserves, { from: user1 })
      await eDai1.approve(pool.address, eDaiReserves, { from: user1 })
      await pool.init(daiReserves, { from: user1 })
    })

    it('buys dai', async () => {
      const tradeSize = toWad(1).div(1000)
      await eDai1.mint(from, bnify(eDaiTokens1).div(1000), { from: owner })

      await pool.addDelegate(operator, { from: from })
      await eDai1.approve(pool.address, bnify(eDaiTokens1).div(1000), { from: from })
      await pool.bueDai(from, to, tradeSize, { from: operator })

      const eDaiIn = new BN(bnify(eDaiTokens1).div(1000).toString()).sub(new BN(await eDai1.balanceOf(from)))

      results.add(['bueDai', daiReserves, eDaiReserves, eDaiIn, tradeSize])
    })

    it('sells eDai', async () => {
      const tradeSize = toWad(1).div(1000)
      await eDai1.mint(from, tradeSize, { from: owner })

      await pool.addDelegate(operator, { from: from })
      await eDai1.approve(pool.address, tradeSize, { from: from })
      await pool.sellEDai(from, to, tradeSize, { from: operator })

      const daiOut = new BN(await dai.balanceOf(to))
      results.add(['sellEDai', daiReserves, eDaiReserves, tradeSize, daiOut])
    })

    describe('with extra eDai reserves', () => {
      beforeEach(async () => {
        const additionalEDaiReserves = toWad(34.4)
        await eDai1.mint(operator, additionalEDaiReserves, { from: owner })
        await eDai1.approve(pool.address, additionalEDaiReserves, { from: operator })
        await pool.sellEDai(operator, operator, additionalEDaiReserves, { from: operator })
      })

      it('sells dai', async () => {
        const tradeSize = toWad(1).div(1000)
        await env.maker.getDai(from, daiTokens1, rate1)

        await pool.addDelegate(operator, { from: from })
        await dai.approve(pool.address, tradeSize, { from: from })
        await pool.sellDai(from, to, tradeSize, { from: operator })

        const eDaiOut = new BN(await eDai1.balanceOf(to))

        results.add(['sellDai', daiReserves, eDaiReserves, tradeSize, eDaiOut])
      })

      it('buys eDai', async () => {
        const tradeSize = toWad(1).div(1000)
        await env.maker.getDai(from, bnify(daiTokens1).div(1000), rate1)

        await pool.addDelegate(operator, { from: from })
        await dai.approve(pool.address, bnify(daiTokens1).div(1000), { from: from })
        await pool.buyEDai(from, to, tradeSize, { from: operator })

        const daiIn = new BN(bnify(daiTokens1).div(1000).toString()).sub(new BN(await dai.balanceOf(from)))
        results.add(['buyEDai', daiReserves, eDaiReserves, daiIn, tradeSize])
      })

      it('prints results', async () => {
        let line: string[]
        // @ts-ignore
        for (line of results.values()) {
          console.log(
            '| ' +
              line[0].padEnd(10, ' ') +
              '· ' +
              line[1].toString().padEnd(23, ' ') +
              '· ' +
              line[2].toString().padEnd(23, ' ') +
              '· ' +
              line[3].toString().padEnd(23, ' ') +
              '· ' +
              line[4].toString().padEnd(23, ' ') +
              '|'
          )
        }
      })
    })
  })
})
