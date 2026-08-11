require('@nomicfoundation/hardhat-toolbox')
require('dotenv').config()

const DEPLOYER_PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: '0.8.20',
    settings: {
      optimizer: { enabled: true, runs: 200 },
    },
  },
  networks: {
    coston2: {
      url: 'https://coston2-api.flare.network/ext/C/rpc',
      chainId: 114,
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
    },
  },
  etherscan: {
    // Coston2 uses a Blockscout instance — no API key needed.
    apiKey: { coston2: 'empty' },
    customChains: [
      {
        network: 'coston2',
        chainId: 114,
        urls: {
          apiURL: 'https://coston2-explorer.flare.network/api',
          browserURL: 'https://coston2-explorer.flare.network',
        },
      },
    ],
  },
}
