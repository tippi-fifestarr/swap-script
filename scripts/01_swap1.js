const { SwapRouter } = require('@uniswap/universal-router-sdk')
const { TradeType, Ether, Token, CurrencyAmount, Percent } = require('@uniswap/sdk-core')
const { Trade: V2Trade } = require('@uniswap/v2-sdk')
const { Pool, nearestUsableTick, TickMath, TICK_SPACINGS, FeeAmount, Trade: V3Trade, Route: RouteV3  } = require('@uniswap/v3-sdk')
const { MixedRouteTrade, Trade: RouterTrade } = require('@uniswap/router-sdk')
const IUniswapV3Pool = require('@uniswap/v3-core/artifacts/contracts/UniswapV3Pool.sol/UniswapV3Pool.json')
const JSBI = require('jsbi')
const erc20Abi = require('../abis/erc20.json')

// hardhat provides ethers
const hardhat = require("hardhat");
const provider = hardhat.ethers.provider;

// we want to check the balance of the recipient before and after the swap
const ETHER = Ether.onChain(1)
const WETH = new Token(1, '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', 18, 'WETH', 'Wrapped Ether')
// we send in chainId, address, decimals, symbol, name
const USDC = new Token(1, '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 6, 'USDC', 'USD Coin')

// initial the token contract instances to get the balance of the recipient
const wethContract = new hardhat.ethers.Contract(WETH.address, erc20Abi, provider)
const usdcContract = new hardhat.ethers.Contract(USDC.address, erc20Abi, provider)

// similiar to something blockman found in the github
async function getPool(tokenA, tokenB, feeAmount) {
    // sort tokens into the correct order 
    const [token0, token1] = tokenA.sortsBefore(tokenB) ? [tokenA, tokenB] : [tokenB, tokenA]

    const poolAddress = Pool.getAddress(token0, token1, feeAmount)

    // intialize the pool contract
    const contract = new hardhat.ethers.Contract(poolAddress, IUniswapV3Pool.abi, provider)

    // liquidity providers add an equal value of both tokens to the pool for liquidity tokens
    // the more liquidity tokens a pool has, the less slippage a trade will have
    let liquidity = await contract.liquidity()

    // sqrtPriceX96: a representation of the current price of tokens in pool
    // tick: represent a specific price point within a price range. is this concentrated liquidity!?
    let { sqrtPriceX96, tick } = await contract.slot0()

    liquidity = JSBI.BigInt(liquidity.toString())
    sqrtPriceX96 = JSBI.BigInt(sqrtPriceX96.toString())

    // this is different from an EthersJS instance, coming from uniswap sdk
    return new Pool(token0, token1, feeAmount, sqrtPriceX96, liquidity, tick, [
        {
            index: nearestUsableTick(TickMath.MIN_TICK, TICK_SPACINGS[feeAmount]),
            liquidityNet: liquidity,
            liquidityGross: liquidity,
        },
        {
            index: nearestUsableTick(TickMath.MAX_TICK, TICK_SPACINGS[feeAmount]),
            liquidityNet: JSBI.multiply(liquidity, JSBI.BigInt('-1')),
            liquidityGross: liquidity,
        },
    ])
}

// builds default options for the universal router allowing 5 percent slippage
function swapOptions(options) {
    return Object.assign(
        {
            slippageTolerance: new Percent(5, 100),
            recipient: RECIPIENT,
        },
        options
    )
}

// removed typescript for readability, builds the trade object for the router
function buildTrade(trades) {
    return new RouterTrade({
        v2Routes: trades
            .filter((trade) => trade instanceof V2Trade)
            .map((trade) => ({
                routev2: trade.route,
                inputAmount: trade.inputAmount,
                outputAmount: trade.outputAmount,
        })),
        v3Routes: trades
            .filter((trade) => trade instanceof V3Trade)
            .map((trade) => ({
                routev3: trade.route,
                inputAmount: trade.inputAmount,
                outputAmount: trade.outputAmount,
            })),
        mixedRoutes: trades
            .filter((trade) => trade instanceof MixedRouteTrade)
            .map((trade) => ({
                    mixedRoute: trade.route,
                    inputAmount: trade.inputAmount,
                outputAmount: trade.outputAmount,
            })),
    tradeType: trades[0].tradeType,
    })
}

// transaction will happen on a fork of mainnet?
// we are impersonating the recipient to send the transaction
// this should make it easier for us to adapt the script to mainnet
const RECIPIENT = '0xAb5801a7D398351b8bE11C439e05C5B3259aeC9B'
// how does this compare to what we'll be doing? 

async function main() {
    const signer = await hardhat.ethers.getImpersonatedSigner(RECIPIENT);

    // these are all settings we can use to build the trade, what fee tier do we want to use?
    const WETH_USDC_V3 = await getPool(WETH, USDC, FeeAmount.MEDIUM)

    // we are swapping 1 ether for usdc?
    const inputEther = hardhat.ethers.utils.parseEther('1').toString()

    // pass in a V3Route object
    const trade = await V3Trade.fromRoute(
        new RouteV3([WETH_USDC_V3], ETHER, USDC),
        CurrencyAmount.fromRawAmount(ETHER, inputEther),
        TradeType.EXACT_INPUT
    )

    // buildTrade is designed to handle multiple trades in an array
    const routerTrade = buildTrade([trade])

    const opts = swapOptions({})

    // we can almost directly send this 
    const params = SwapRouter.swapERC20CallParameters(routerTrade, opts)

    let ethBalance
    let wethBalance
    let usdcBalance
    // this is why we made the token contract instances
    ethBalance = await provider.getBalance(RECIPIENT)
    wethBalance = await wethContract.balanceOf(RECIPIENT)
    usdcBalance = await usdcContract.balanceOf(RECIPIENT)
    console.log('---------------------------- BEFORE')
    console.log('ethBalance', hardhat.ethers.utils.formatUnits(ethBalance, 18))
    console.log('wethBalance', hardhat.ethers.utils.formatUnits(wethBalance, 18))
    console.log('usdcBalance', hardhat.ethers.utils.formatUnits(usdcBalance, 6))

    // send the transaction with calldata, address of the universal router, etc
    const tx = await signer.sendTransaction({
        data: params.calldata,
        to: '0xEf1c6E67703c7BD7107eed8303Fbe6EC2554BF6B',
        value: params.value,
        from: RECIPIENT,
    })

    const receipt = await tx.wait()
    console.log('---------------------------- SUCCESS?')
    console.log('status', receipt.status)

    ethBalance = await provider.getBalance(RECIPIENT)
    wethBalance = await wethContract.balanceOf(RECIPIENT)
    usdcBalance = await usdcContract.balanceOf(RECIPIENT)
    console.log('---------------------------- AFTER')
    console.log('ethBalance', hardhat.ethers.utils.formatUnits(ethBalance, 18))
    console.log('wethBalance', hardhat.ethers.utils.formatUnits(wethBalance, 18))
    console.log('usdcBalance', hardhat.ethers.utils.formatUnits(usdcBalance, 6))
}


/*
    node scripts/01_simpleSwap.js
*/



main()
    .then(() => process.exit(0))
    .catch((error) => {
        console.error(error);
        process.exit(1);
    });