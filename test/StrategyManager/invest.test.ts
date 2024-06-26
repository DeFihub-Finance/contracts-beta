import { expect } from 'chai'
import { AbiCoder, BigNumberish, parseEther, Signer } from 'ethers'
import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers'
import {
    DollarCostAverage,
    StrategyManager,
    TestERC20,
    TestVault,
} from '@src/typechain'
import { SubscriptionSignature } from '@src/SubscriptionSignature'
import { NetworkService } from '@src/NetworkService'
import { ContractFees } from '@src/ContractFees'
import { createStrategyFixture } from './fixtures/create-strategy.fixture'

// EFFECTS
// => when user is subscribed
//      => create investment position in dca and vaults discounting protocol fee - subscriber discount
// => when user is not subscribed
//      => create investment position in dca and vaults discounting protocol fee
// => when strategist is subscribed and strategy is hot
//      => send fees to strategist
//      => send fees to treasury
// => when strategist is subscribed and strategy is not hot
//      => send fees to strategist
//      => send fees to treasury
// => emit Invested event
// => swap and create investment position
//
// SIDE-EFFECTS
// => save position in the array of investments
// => increase totalDeposits on strategy used
//
// REVERTS
// => when strategist is not subscribed
//      => revert transaction => TODO: this should change to not send fees to strategist
// => if strategyId doesn't exist
// => if swap paths are different than the vaults length in strategy
// => if swap paths are different than the dca length in strategy
describe('StrategyManager#invest', () => {
    let account0: Signer
    let account1: Signer
    let account2: Signer
    let treasury: Signer
    let strategyManagerAddress: string
    let strategyManager: StrategyManager
    let dca: DollarCostAverage
    let vault: TestVault
    let token: TestERC20
    let stablecoin: TestERC20
    let subscriptionSignature: SubscriptionSignature
    let deadline: number
    let strategy: StrategyManager.StrategyStruct
    let dcaStrategyPositions: StrategyManager.DcaStrategyStruct[]
    let vaultStrategyPosition: StrategyManager.VaultStrategyStruct[]

    const strategyId = 0
    const amountToInvest = parseEther('10')

    const vaultSwaps = ['0x']
    const dcaSwaps = ['0x', '0x']

    async function invest(account: Signer, {
        _strategyId = strategyId,
        _dcaSwaps = dcaSwaps,
        _vaultSwaps = vaultSwaps,
        _deadlineInvestor = deadline,
        _deadlineStrategist = deadline,
    }: {
        _strategyId?: BigNumberish
        _dcaSwaps?: string[]
        _vaultSwaps?: string[]
        _deadlineInvestor?: number
        _deadlineStrategist?: number
    } = {
        _strategyId: strategyId,
        _dcaSwaps: dcaSwaps,
        _vaultSwaps: vaultSwaps,
        _deadlineInvestor: deadline,
        _deadlineStrategist: deadline,
    }) {
        return strategyManager.connect(account).invest({
            strategyId: _strategyId,
            inputToken: stablecoin,
            inputAmount: amountToInvest,
            inputTokenSwap: '0x',
            dcaSwaps: _dcaSwaps,
            vaultSwaps: _vaultSwaps,
            investorPermit: await subscriptionSignature
                .signSubscriptionPermit(await account.getAddress(), _deadlineInvestor),
            strategistPermit: await subscriptionSignature
                .signSubscriptionPermit(await account0.getAddress(), _deadlineStrategist),
        })
    }

    beforeEach(async () => {
        ({
            account0,
            account1,
            account2,
            dca,
            vault,
            token,
            stablecoin,
            strategyManager,
            strategyManagerAddress,
            subscriptionSignature,
            dcaStrategyPositions,
            vaultStrategyPosition,
            treasury,
        } = await loadFixture(createStrategyFixture))

        deadline = await NetworkService.getBlockTimestamp() + 10_000
        strategy = await strategyManager.getStrategy(0)
    })

    describe('EFFECTS', () => {
        describe('when user is subscribed', () => {
            it('create investment position in dca and vaults', async () => {
                await invest(account1)

                const [
                    dcaPosition0,
                    dcaPosition1,
                    dcaPositionBalance0,
                    dcaPositionBalance1,
                ] = await Promise.all([
                    dca.getPosition(strategyManagerAddress, 0),
                    dca.getPosition(strategyManagerAddress, 1),
                    dca.getPositionBalances(strategyManagerAddress, 0),
                    dca.getPositionBalances(strategyManagerAddress, 1),
                ])

                /////////////////////
                // DCA Position 0 //
                ///////////////////
                const expectedDcaPositionBalance0 = ContractFees.discountBaseFee(
                    amountToInvest * BigInt(dcaStrategyPositions[0].percentage) / 100n,
                )

                expect(dcaPosition0.swaps).to.be.equal(strategy.dcaInvestments[0].swaps)
                expect(dcaPosition0.poolId).to.be.equal(strategy.dcaInvestments[0].poolId)
                expect(dcaPositionBalance0.inputTokenBalance).to.be.equal(expectedDcaPositionBalance0)

                /////////////////////
                // DCA Position 1 //
                ///////////////////
                const expectedDcaPositionBalance1 = ContractFees.discountBaseFee(
                    amountToInvest * BigInt(dcaStrategyPositions[1].percentage) / 100n,
                )

                expect(dcaPosition1.swaps).to.be.equal(strategy.dcaInvestments[1].swaps)
                expect(dcaPosition1.poolId).to.be.equal(strategy.dcaInvestments[1].poolId)
                expect(dcaPositionBalance1.inputTokenBalance).to.be.equal(expectedDcaPositionBalance1)

                ////////////////////
                // VaultPosition //
                //////////////////
                const expectVaultPositionBalance = ContractFees.discountBaseFee(
                    amountToInvest * BigInt(vaultStrategyPosition[0].percentage) / 100n,
                )

                expect(await vault.balanceOf(strategyManagerAddress)).to.be.equal(expectVaultPositionBalance)
            })
        })

        describe('when user is not subscribed', () => {
            it('create investment position in dca and vaults', async () => {
                await invest(account2, { _deadlineInvestor: 0 })

                const [
                    dcaPosition0,
                    dcaPosition1,
                    dcaPositionBalance0,
                    dcaPositionBalance1,
                ] = await Promise.all([
                    dca.getPosition(strategyManagerAddress, 0),
                    dca.getPosition(strategyManagerAddress, 1),
                    dca.getPositionBalances(strategyManagerAddress, 0),
                    dca.getPositionBalances(strategyManagerAddress, 1),
                ])

                /////////////////////
                // DCA Position 0 //
                ///////////////////
                const baseAmountToDCAPosition0 = amountToInvest * BigInt(dcaStrategyPositions[0].percentage) / 100n
                const expectedDcaPositionBalance0 = ContractFees.discountNonSubscriberFee(baseAmountToDCAPosition0)

                expect(dcaPosition0.swaps).to.be.equal(strategy.dcaInvestments[0].swaps)
                expect(dcaPosition0.poolId).to.be.equal(strategy.dcaInvestments[0].poolId)
                expect(dcaPositionBalance0.inputTokenBalance).to.be.equal(expectedDcaPositionBalance0)

                /////////////////////
                // DCA Position 1 //
                ///////////////////
                const baseAmountToDCAPosition1 = amountToInvest * BigInt(dcaStrategyPositions[1].percentage) / 100n
                const expectedDcaPositionBalance1 = ContractFees.discountNonSubscriberFee(baseAmountToDCAPosition1)

                expect(dcaPosition1.swaps).to.be.equal(strategy.dcaInvestments[1].swaps)
                expect(dcaPosition1.poolId).to.be.equal(strategy.dcaInvestments[1].poolId)
                expect(dcaPositionBalance1.inputTokenBalance).to.be.equal(expectedDcaPositionBalance1)

                ////////////////////
                // VaultPosition //
                //////////////////
                const expectVaultPositionBalance = ContractFees.discountNonSubscriberFee(
                    amountToInvest * BigInt(vaultStrategyPosition[0].percentage) / 100n,
                )

                expect(await vault.balanceOf(strategyManagerAddress)).to.be.equal(expectVaultPositionBalance)
            })
        })

        describe('when strategist is subscribed and strategy is not hot', async () => {
            it('increase strategist rewards', async () => {
                const strategistAddress = await account0.getAddress()
                const baseFee = ContractFees.getBaseFee(amountToInvest)
                const strategistFee = ContractFees.getStrategistFee(baseFee)
                const strategistRewardsBefore = await strategyManager.getStrategistRewards(strategistAddress)

                await invest(account1)

                const strategistRewardsDelta = (await strategyManager.getStrategistRewards(strategistAddress)) - strategistRewardsBefore

                expect(strategistRewardsDelta).to.be.equal(strategistFee)
            })

            it('send fees to treasury', async () => {
                const treasuryAddress = await treasury.getAddress()
                const treasuryBalanceBefore = await token.balanceOf(treasuryAddress)
                const baseFee = ContractFees.getBaseFee(amountToInvest)
                const strategistFee = ContractFees.getStrategistFee(baseFee)

                await invest(account1)

                const treasuryBalanceDelta = (await token.balanceOf(treasuryAddress)) - treasuryBalanceBefore

                expect(treasuryBalanceDelta).to.be.equal(baseFee - strategistFee)
            })
        })

        describe('when strategist is subscribed and strategy is hot', async () => {
            it('increase strategist rewards', async () => {
                const strategistAddress = await account0.getAddress()
                const strategistRewardsBefore = await strategyManager.getStrategistRewards(strategistAddress)

                const baseFee = ContractFees.getBaseFee(amountToInvest)
                const strategistFee = baseFee * 30n / 100n

                await strategyManager.setHottestStrategies([0])
                await invest(account2)

                const strategistRewardsDelta = (await strategyManager.getStrategistRewards(strategistAddress)) - strategistRewardsBefore

                expect(strategistRewardsDelta).to.be.equal(strategistFee)
            })

            it('send fees to treasury', async () => {
                const treasuryAddress = await treasury.getAddress()
                const treasuryBalanceBefore = await token.balanceOf(treasuryAddress)

                const baseFee = ContractFees.getBaseFee(amountToInvest)
                const strategistFee = baseFee * 30n / 100n

                await strategyManager.setHottestStrategies([0])
                await invest(account1)

                const treasuryBalanceDelta = (await token.balanceOf(treasuryAddress)) - treasuryBalanceBefore

                expect(treasuryBalanceDelta).to.be.equal(baseFee - strategistFee)
            })
        })

        describe('when strategist is not subscribed', () => {
            let strategist: string
            let investor: string
            let initialStrategistRewards: bigint

            beforeEach(async () => {
                strategist = (await strategyManager.getStrategy(strategyId)).creator
                investor = await account2.getAddress()
                initialStrategistRewards = await strategyManager
                    .getStrategistRewards(strategist)
            })

            it('subscribed user sends strategist rewards to treasury', async () => {
                const tx = await invest(account2, { _deadlineStrategist: 0 })

                const finalStrategistRewards = await strategyManager
                    .getStrategistRewards(strategist)

                expect(finalStrategistRewards).to.be.equal(initialStrategistRewards)

                await expect(tx).to.emit(strategyManager, 'Fee').withArgs(
                    investor,
                    treasury,
                    ContractFees.getBaseFee(amountToInvest),
                    AbiCoder.defaultAbiCoder().encode(['uint'], [strategyId]),
                )
            })

            it('unsubscribed user sends strategist rewards to treasury', async () => {
                const tx = await invest(account2, { _deadlineInvestor: 0, _deadlineStrategist: 0 })

                const finalStrategistRewards = await strategyManager
                    .getStrategistRewards(strategist)

                expect(finalStrategistRewards).to.be.equal(initialStrategistRewards)

                await expect(tx).to.emit(strategyManager, 'Fee').withArgs(
                    investor,
                    treasury,
                    ContractFees.getNonSubscriberFee(amountToInvest),
                    AbiCoder.defaultAbiCoder().encode(['uint'], [strategyId]),
                )
            })
        })
    })

    describe('SIDE-EFFECT', () => {
        it('increase totalDeposits on strategy used', async () => {
            await invest(account1)

            const strategy = await strategyManager.getStrategy(strategyId)

            expect(strategy.totalDeposits).to.be.equal(amountToInvest)
        })

        it('save position in the array of investments', async () => {
            const account1Address = await account1.getAddress()

            await invest(account1)

            const investmentsLength = await strategyManager.getPositionsLength(account1Address)
            const investment = await strategyManager.getPosition(account1Address, 0)

            expect(investmentsLength).to.be.equal(1n)
            expect(investment.strategyId).to.be.equal(0n)
            expect(investment.dcaPositionIds[0]).to.be.equal(0n)
            expect(investment.dcaPositionIds[1]).to.be.equal(1n)
        })

        it('emits PositionCreated event', async () => {
            const account1Address = await account1.getAddress()
            const tx = invest(account1)

            await expect(tx)
                .to.emit(strategyManager, 'PositionCreated')
                .withArgs(
                    account1Address,
                    0,
                    0,
                    stablecoin,
                    amountToInvest,
                    ContractFees.discountBaseFee(amountToInvest),
                    [0, 1],
                    [
                        [
                            await vault.getAddress(),
                            ContractFees.discountBaseFee(
                                amountToInvest * BigInt(vaultStrategyPosition[0].percentage) / 100n,
                            ),
                        ],
                    ],
                )
        })
    })

    describe('REVERTS', () => {
        it('if swap paths are different than the vault length in strategy', async () => {
            const tx = invest(account2, { _vaultSwaps: [] })

            await expect(tx).to.revertedWithCustomError(strategyManager, 'InvalidSwapsLength')
        })

        it('if swap paths are different than the dca length in strategy', async () => {
            const tx = invest(account2, { _dcaSwaps: [] })

            await expect(tx).to.revertedWithCustomError(strategyManager, 'InvalidSwapsLength')
        })

        it('if strategyId do not exist', async () => {
            const tx = invest(account2, { _strategyId: 99 })

            await expect(tx).to.revertedWithCustomError(strategyManager, 'StrategyUnavailable')
        })
    })
})
