require("dotenv").config();
require("@nomicfoundation/hardhat-toolbox");

// Lấy Private Key từ .env, nếu không có thì để mảng rỗng để tránh lỗi crash
const PRIVATE_KEY = process.env.PRIVATE_KEY ? [process.env.PRIVATE_KEY] : [];

module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        // Với Mining Contract, số runs càng cao (VD: 1000000) thì deploy càng đắt 
        // nhưng gas khi chạy (đào) càng rẻ. 800 là mức cân bằng.
        runs: 800, 
      },
      viaIR: true, // Bật cái này là chuẩn để fix lỗi "Stack too deep"
    },
  },
  
  // CẤU HÌNH ĐƯỜNG DẪN
  paths: {
    // LƯU Ý: Nếu bạn để code trong thư mục "src" thì giữ dòng dưới. 
    // Nếu để trong "contracts" (mặc định của Hardhat) thì đổi lại thành "./contracts"
    sources: "./contracts", // Đã sửa lại về chuẩn Hardhat để khớp với các bài trước
    tests: "./test",
    cache: "./cache",
    artifacts: "./artifacts",
  },

  networks: {
    // 1. Localhost (Dùng để test nhanh như bài trước)
    hardhat: {
      chainId: 31337,
    },

    // 2. BSC Testnet
    bscTestnet: {
      url: "https://bsc-testnet-rpc.publicnode.com",
      chainId: 97,
      accounts: PRIVATE_KEY,
    },

    // 3. Sepolia (Ethereum Testnet)
    sepolia: {
      url: process.env.SEPOLIA_RPC_URL || "https://ethereum-sepolia-rpc.publicnode.com",
      chainId: 11155111,
      accounts: PRIVATE_KEY,
    },

    // 4. Monad Testnet
    monadTestnet: {
      url: process.env.MONAD_TESTNET_RPC_URL || "https://testnet-rpc.monad.xyz",
      chainId: 10143,
      accounts: PRIVATE_KEY,
    },
  },

  // CẤU HÌNH VERIFY CONTRACT (Etherscan & Monad Explorer)
  etherscan: {
    enabled: true,
    // API Key (Có thể lấy từ Etherscan cho ETH, BscScan cho BSC)
    apiKey: {
      sepolia: process.env.ETHERSCAN_API_KEY || "",
      bscTestnet: process.env.BSCSCAN_API_KEY || "",
      monadTestnet: "abc", // Monad explorer hiện không cần key thật, điền bừa cũng được
    },
    // Cấu hình riêng cho mạng Monad (Vì Hardhat chưa hỗ trợ native)
    customChains: [
      {
        network: "monadTestnet",
        chainId: 10143,
        urls: {
          apiURL: "https://testnet.monadexplorer.com/api",
          browserURL: "https://testnet.monadexplorer.com"
        }
      }
    ]
  },

  // Sourcify (Dùng verify thay thế nếu Etherscan lỗi)
  sourcify: {
    enabled: true,
  }
};