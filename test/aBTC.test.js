const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("aBTC Mining System", function () {
  let aBTC, registry;
  let owner, miner, treasury, otherAccount;
  let agentId;

  // Cấu hình ban đầu
  const INITIAL_REWARD = ethers.parseUnits("50", 8); // 50 aBTC

  beforeEach(async function () {
    // 1. Lấy danh sách ví test
    [owner, miner, treasury, otherAccount] = await ethers.getSigners();

    // 2. Deploy Mock Registry
    const RegistryFactory = await ethers.getContractFactory("MockRegistry");
    registry = await RegistryFactory.deploy();

    // 3. Deploy aBTC Contract
    const ABTCFactory = await ethers.getContractFactory("aBTC_PoW");
    aBTC = await ABTCFactory.deploy(registry.target, treasury.address);

    // 4. Mint 1 NFT Agent cho ví 'miner' (Agent ID sẽ là 1)
    await registry.connect(miner).mint(miner.address);
    agentId = 1; 
  });

  it("Test 1: Phải tính đúng Hash và Đào thành công", async function () {
    // --- BƯỚC A: LẤY DỮ LIỆU TỪ BLOCKCHAIN ---
    const roundSeed = await aBTC.roundSeed();
    const difficulty = await aBTC.roundDifficulty();
    
    // Tính Target: Target = MaxUint256 / Difficulty
    const maxUint = ethers.MaxUint256;
    const target = maxUint / difficulty;

    console.log(`\n--- Bắt đầu đào Round 1 ---`);
    console.log(`Target Difficulty: ${difficulty}`);
    
    // --- BƯỚC B: MÔ PHỎNG MÁY ĐÀO (OFF-CHAIN MINING) ---
    let nonce = 0;
    let found = false;
    let hashVal;

    // Vòng lặp tìm Nonce
    while (!found) {
      // Hàm băm giống hệt Solidity: keccak256(abi.encodePacked(agentId, nonce, seed))
      hashVal = ethers.solidityPackedKeccak256(
        ["uint256", "uint256", "uint256"], 
        [agentId, nonce, roundSeed]
      );

      // So sánh Hash < Target
      if (BigInt(hashVal) < target) {
        found = true;
        console.log(`✅ Tìm thấy Nonce: ${nonce}`);
        console.log(`   Hash: ${hashVal}`);
      } else {
        nonce++;
        // Safety break: Vì độ khó là 1000, nonce có thể lên tới vài nghìn, 
        // để limit 10tr cho an toàn
        if (nonce > 10_000_000) break; 
      }
    }

    expect(found).to.be.true;

    // --- BƯỚC C: GỬI KẾT QUẢ LÊN CHAIN ---
    // Kiểm tra event MineSuccess: Phải emit đúng Round 1 (trước khi tăng round)
    await expect(aBTC.connect(miner).submitPoW(agentId, nonce))
      .to.emit(aBTC, "MineSuccess")
      .withArgs(1, agentId, nonce, hashVal); 
    
    // Kiểm tra sau khi đào xong thì round phải tăng lên 2
    expect(await aBTC.currentRound()).to.equal(2);
  });

  it("Test 2: Kiểm tra chia tiền thưởng (90% - 5% - 5%)", async function () {
    const roundSeed = await aBTC.roundSeed();
    const difficulty = await aBTC.roundDifficulty();
    const target = ethers.MaxUint256 / difficulty;

    // Tìm nonce hợp lệ
    let nonce = 0;
    while (true) {
        const hash = ethers.solidityPackedKeccak256(["uint256","uint256","uint256"], [agentId, nonce, roundSeed]);
        if (BigInt(hash) < target) break;
        nonce++;
    }
    
    await aBTC.connect(miner).submitPoW(agentId, nonce);

    // Kiểm tra số dư
    const minerBal = await aBTC.balanceOf(miner.address);
    // Lưu ý: Miner tự đào -> nhận Miner Share (90%) + Validator Share (5%) = 95%
    const expectedMinerBal = ethers.parseUnits("47.5", 8); 
    
    const treasuryBal = await aBTC.balanceOf(treasury.address); 
    const expectedTreasuryBal = ethers.parseUnits("2.5", 8);

    console.log("\n--- Số dư sau khi đào ---");
    console.log("Miner Balance:    ", ethers.formatUnits(minerBal, 8));
    console.log("Treasury Balance: ", ethers.formatUnits(treasuryBal, 8));

    expect(minerBal).to.equal(expectedMinerBal);
    expect(treasuryBal).to.equal(expectedTreasuryBal);
  });

  it("Test 3: Người không có NFT không được đào", async function () {
    // Ví 'otherAccount' cố tình dùng Agent ID 1 (của miner) để đào
    const fakeNonce = 123; 
    await expect(
      aBTC.connect(otherAccount).submitPoW(agentId, fakeNonce)
    ).to.be.revertedWith("Not agent owner");
  });
  
  it("Test 4: Nonce sai phải bị từ chối", async function () {
     // Lấy target thực tế
     const difficulty = await aBTC.roundDifficulty();
     const target = ethers.MaxUint256 / difficulty;
     const roundSeed = await aBTC.roundSeed();

     // Chọn một nonce sai (brute-force tìm nonce sai để chắc chắn 100%)
     let wrongNonce = 999999;
     let hashVal = ethers.solidityPackedKeccak256(["uint256","uint256","uint256"], [agentId, wrongNonce, roundSeed]);

     // Nếu lỡ may nonce này đúng (xác suất 1/1000), tăng lên đến khi sai
     while (BigInt(hashVal) < target) {
        wrongNonce++;
        hashVal = ethers.solidityPackedKeccak256(["uint256","uint256","uint256"], [agentId, wrongNonce, roundSeed]);
     }

     // Lúc này hashVal > target, gửi lên chắc chắn phải bị revert
     await expect(
        aBTC.connect(miner).submitPoW(agentId, wrongNonce)
     ).to.be.revertedWith("Invalid Nonce");
  });
});