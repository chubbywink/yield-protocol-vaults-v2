const Vat = artifacts.require('Vat');
const GemJoin = artifacts.require('GemJoin');
const DaiJoin = artifacts.require('DaiJoin');
const Weth = artifacts.require("WETH9");
const ERC20 = artifacts.require("TestERC20");
const Pot = artifacts.require('Pot');
const Chai = artifacts.require('Chai');
const ChaiOracle = artifacts.require('ChaiOracle');
const WethOracle = artifacts.require('WethOracle');
const Treasury = artifacts.require('Treasury');
const YDai = artifacts.require('YDai');
const Dealer = artifacts.require('Dealer');
const Splitter = artifacts.require('Splitter');

const helper = require('ganache-time-traveler');
const truffleAssert = require('truffle-assertions');
const { BN, expectRevert, expectEvent } = require('@openzeppelin/test-helpers');
const { toWad, toRay, toRad, addBN, subBN, mulRay, divRay } = require('./shared/utils');

contract('Dealer - Splitter', async (accounts) =>  {
    let [ owner, user ] = accounts;
    let vat;
    let weth;
    let wethJoin;
    let dai;
    let daiJoin;
    let pot;
    let chai;
    let chaiOracle;
    let wethOracle;
    let treasury;
    let yDai1;
    let yDai2;
    let dealer;
    let splitter;

    let WETH = web3.utils.fromAscii("WETH");
    let CHAI = web3.utils.fromAscii("CHAI");
    let ilk = web3.utils.fromAscii("ETH-A");
    let Line = web3.utils.fromAscii("Line");
    let spotName = web3.utils.fromAscii("spot");
    let linel = web3.utils.fromAscii("line");

    let snapshot;
    let snapshotId;

    const limits = toRad(10000);
    const spot  = toRay(1.5);
    const rate  = toRay(1.25);
    const daiDebt = toWad(120);
    const daiTokens = mulRay(daiDebt, rate);
    const wethTokens = divRay(daiTokens, spot);
    let maturity1;
    let maturity2;

    beforeEach(async() => {
        snapshot = await helper.takeSnapshot();
        snapshotId = snapshot['result'];

        // Setup vat
        vat = await Vat.new();
        await vat.init(ilk, { from: owner });

        weth = await Weth.new({ from: owner });
        wethJoin = await GemJoin.new(vat.address, ilk, weth.address, { from: owner });

        dai = await ERC20.new(0, { from: owner });
        daiJoin = await DaiJoin.new(vat.address, dai.address, { from: owner });

        await vat.file(ilk, spotName, spot, { from: owner });
        await vat.file(ilk, linel, limits, { from: owner });
        await vat.file(Line, limits); // TODO: Why can't we specify `, { from: owner }`?
        await vat.fold(ilk, vat.address, subBN(rate, toRay(1)), { from: owner }); // Fold only the increase from 1.0

        // Setup pot
        pot = await Pot.new(vat.address);

        // Permissions
        await vat.rely(vat.address, { from: owner });
        await vat.rely(wethJoin.address, { from: owner });
        await vat.rely(daiJoin.address, { from: owner });
        await vat.rely(pot.address, { from: owner });
        await vat.hope(daiJoin.address, { from: owner });
        await vat.hope(wethJoin.address, { from: owner });

        // Setup chai
        chai = await Chai.new(
            vat.address,
            pot.address,
            daiJoin.address,
            dai.address,
            { from: owner },
        );

        // Setup Oracle
        wethOracle = await WethOracle.new(vat.address, { from: owner });

        // Setup ChaiOracle
        chaiOracle = await ChaiOracle.new(pot.address, { from: owner });

        // Set treasury
        treasury = await Treasury.new(
            dai.address,
            chai.address,
            chaiOracle.address,
            weth.address,
            daiJoin.address,
            wethJoin.address,
            vat.address,
            { from: owner },
        );

        // Setup Dealer
        dealer = await Dealer.new(
            treasury.address,
            dai.address,
            weth.address,
            wethOracle.address,
            chai.address,
            chaiOracle.address,
            { from: owner },
        );
        treasury.grantAccess(dealer.address, { from: owner });

        // Setup Splitter
        splitter = await Splitter.new(
            treasury.address,
            dealer.address,
            { from: owner },
        );
        dealer.grantAccess(splitter.address, { from: owner });
        treasury.grantAccess(splitter.address, { from: owner });

        // Setup yDai
        const block = await web3.eth.getBlockNumber();
        maturity1 = (await web3.eth.getBlock(block)).timestamp + 1000;
        yDai1 = await YDai.new(
            vat.address,
            pot.address,
            treasury.address,
            maturity1,
            "Name",
            "Symbol",
            { from: owner },
        );
        dealer.addSeries(yDai1.address, { from: owner });
        yDai1.grantAccess(dealer.address, { from: owner });
        treasury.grantAccess(yDai1.address, { from: owner });

        maturity2 = (await web3.eth.getBlock(block)).timestamp + 2000;
        yDai2 = await YDai.new(
            vat.address,
            pot.address,
            treasury.address,
            maturity2,
            "Name2",
            "Symbol2",
            { from: owner },
        );
        dealer.addSeries(yDai2.address, { from: owner });
        yDai2.grantAccess(dealer.address, { from: owner });
        treasury.grantAccess(yDai2.address, { from: owner });
    });

    afterEach(async() => {
        await helper.revertToSnapshot(snapshotId);
    });
    
    /* it("get the size of the contract", async() => {
        console.log();
        console.log("·--------------------|------------------|------------------|------------------·");
        console.log("|  Contract          ·  Bytecode        ·  Deployed        ·  Constructor     |");
        console.log("·····················|··················|··················|···················");
        
        const bytecode = dealer.constructor._json.bytecode;
        const deployed = dealer.constructor._json.deployedBytecode;
        const sizeOfB  = bytecode.length / 2;
        const sizeOfD  = deployed.length / 2;
        const sizeOfC  = sizeOfB - sizeOfD;
        console.log(
            "|  " + (dealer.constructor._json.contractName).padEnd(18, ' ') +
            "|" + ("" + sizeOfB).padStart(16, ' ') + "  " +
            "|" + ("" + sizeOfD).padStart(16, ' ') + "  " +
            "|" + ("" + sizeOfC).padStart(16, ' ') + "  |");
        console.log("·--------------------|------------------|------------------|------------------·");
        console.log();
    }); */

    describe("with posted weth", () => {
        beforeEach(async() => {
            await weth.deposit({ from: owner, value: wethTokens });
            await weth.approve(dealer.address, wethTokens, { from: owner }); 
            await dealer.post(WETH, owner, wethTokens, { from: owner });

            assert.equal(
                await dealer.posted(WETH, owner),
                wethTokens.toString(),
                "User does not have collateral in Dealer",
            );
            assert.equal(
                (await vat.urns(ilk, treasury.address)).ink,
                wethTokens.toString(),
                "Treasury does not have weth in MakerDAO",
            );
        });        

        it("allows to erase collateral only positions", async() => {
            await dealer.grantAccess(owner, { from: owner }); // Only for testing
            expectEvent(
                await dealer.erase(WETH, owner, { from: owner }),
                "Erased",
                {
                    user: owner,
                    debt: "0",
                    tokens: wethTokens.toString(),
                },
            );

            assert.equal(
                await dealer.posted(WETH, owner),
                0,
                "User should not have collateral in Dealer",
            );
        });

        it("only the collateral owner can split it to MakerDAO", async() => {
            await expectRevert(
                splitter.split(accounts[1], owner, { from: owner }),
                "Splitter: Only owner",
            );
        });

        it("allows to split weth collateral to MakerDAO", async() => {
            await vat.hope(treasury.address, { from: owner });
            await splitter.split(owner, owner, { from: owner });
            // TODO: Test with different source and destination accounts
            // TODO: Test with different rates

            assert.equal(
                (await vat.urns(ilk, owner)).ink,
                wethTokens.toString(),
                "User should have collateral in MakerDAO",
            );
            assert.equal(
                (await vat.urns(ilk, treasury.address)).ink,
                0,
                "Treasury should have no collateral in MakerDAO",
            );
        });

        describe("with borrowed yDai", () => {
            beforeEach(async() => {
                await dealer.borrow(WETH, maturity1, owner, daiTokens, { from: owner });

                assert.equal(
                    await dealer.debtDai(WETH, maturity1, owner),
                    daiTokens.toString(),
                    "Owner does not have debt",
                );
            });

            it("only the position owner can split it to MakerDAO", async() => {
                await expectRevert(
                    splitter.split(accounts[1], owner, { from: owner }),
                    "Splitter: Only owner",
                );
            });

            it("allows to erase weth positions", async() => {
                // We post an extra weth wei to te, uint256 debtst that only the needed collateral is taken
                await weth.deposit({ from: owner, value: 1 });
                await weth.approve(dealer.address, 1, { from: owner }); 
                await dealer.post(WETH, owner, 1, { from: owner });

                await dealer.grantAccess(owner, { from: owner }); // Only for testing
                expectEvent(
                    await dealer.erase(WETH, owner, { from: owner }),
                    "Erased",
                    {
                        user: owner,
                        tokens: wethTokens.add(1).toString(),
                        debt: daiTokens.toString(),
                    },
                );
                // TODO: Test with several maturities
                // TODO: Test with CHAI collateral as well
                // TODO: Test with different rates

                assert.equal(
                    await dealer.debtDai(WETH, maturity1, owner),
                    0,
                    "User should not have debt in Dealer",
                );
                assert.equal(
                    await dealer.posted(WETH, owner),
                    0,
                    "User should not have collateral in Dealer",
                );
            });

            it("allows to split user debt to MakerDAO beyond system debt", async() => {
                await vat.hope(treasury.address, { from: owner });
                await splitter.split(owner, owner, { from: owner });
                // TODO: Test with different source and destination accounts
                // TODO: Test with several maturities
                // TODO: Test with different rates

                assert.equal(
                    (await vat.urns(ilk, owner)).art,
                    daiDebt.toString(),
                    "User should have debt in MakerDAO",
                );
                assert.equal(
                    (await vat.urns(ilk, owner)).ink,
                    wethTokens.toString(),
                    "User should have collateral in MakerDAO",
                );
                assert.equal(
                    (await vat.urns(ilk, treasury.address)).art,
                    0,
                    "Treasury should have no debt in MakerDAO",
                );
            });
        });
    });
});