const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("aBTC_PoW v2 — Commit-Reveal Mining", function () {
  let aBTC, registry;
  let owner, miner, treasury, admin, otherAccount;
  let agentId;

  const INITIAL_REWARD = ethers.parseUnits("50", 8);

  // ═══════════════════════════════════════════════════════
  //  HELPERS — dùng abi.encode khớp với contract
  // ═══════════════════════════════════════════════════════

  function computeCommitHash(agentId, secret, minerAddress) {
    return ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256", "uint256", "address"],
        [agentId, secret, minerAddress]
      )
    );
  }

  function computeEnhancedSeed(roundSeed, secret) {
    const xored = BigInt(roundSeed) ^ BigInt(secret);
    return ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [xored])
    );
  }

  function computeHash(agentId, nonce, enhancedSeed) {
    return ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ["uint256", "uint256", "uint256"],
        [agentId, nonce, enhancedSeed]
      )
    );
  }

  async function mineBlocks(n) {
    for (let i = 0; i < n; i++) {
      await ethers.provider.send("evm_mine", []);
    }
  }

  async function commitRevealMine(minerSigner, _agentId, secret) {
    const roundSeed = await aBTC.roundSeed();
    const difficulty = await aBTC.roundDifficulty();
    const target = ethers.MaxUint256 / difficulty;

    const commitHash = computeCommitHash(_agentId, secret, minerSigner.address);
    await aBTC.connect(minerSigner).commit(_agentId, commitHash);

    await mineBlocks(2);

    const enhancedSeed = computeEnhancedSeed(roundSeed, secret);
    let nonce = 0;
    let hashVal;

    while (true) {
      hashVal = computeHash(_agentId, nonce, enhancedSeed);
      if (BigInt(hashVal) < target) break;
      nonce++;
      if (nonce > 10_000_000) throw new Error("Nonce not found");
    }

    const tx = await aBTC.connect(minerSigner).revealAndMine(_agentId, nonce, secret);
    return { tx, nonce, hashVal, enhancedSeed };
  }

  // ═══════════════════════════════════════════════════════
  //  SETUP
  // ═══════════════════════════════════════════════════════

  beforeEach(async function () {
    [owner, miner, treasury, admin, otherAccount] = await ethers.getSigners();

    const RegistryFactory = await ethers.getContractFactory("MockRegistry");
    registry = await RegistryFactory.deploy();

    const ABTCFactory = await ethers.getContractFactory("aBTC_PoW");
    aBTC = await ABTCFactory.deploy(registry.target, treasury.address, admin.address);

    await registry.connect(miner).mint(miner.address);
    agentId = 1;
  });

  // ═══════════════════════════════════════════════════════
  //  CORE MINING FLOW
  // ═══════════════════════════════════════════════════════

  describe("Core Mining Flow", function () {
    it("Test 1: Commit-Reveal mining thành công", async function () {
      const secret = 42069;
      const roundBefore = await aBTC.currentRound();

      console.log(`\n--- Bắt đầu đào Round ${roundBefore} ---`);
      const { nonce, hashVal } = await commitRevealMine(miner, agentId, secret);
      console.log(`✅ Tìm thấy Nonce: ${nonce}`);
      console.log(`   Hash: ${hashVal}`);

      expect(await aBTC.currentRound()).to.equal(roundBefore + 1n);
    });

    it("Test 2: Chia tiền thưởng đúng (90% + 5% miner, 5% treasury)", async function () {
      await commitRevealMine(miner, agentId, 12345);

      const minerBal = await aBTC.balanceOf(miner.address);
      const treasuryBal = await aBTC.balanceOf(treasury.address);

      console.log("\n--- Số dư sau khi đào ---");
      console.log("Miner Balance:    ", ethers.formatUnits(minerBal, 8));
      console.log("Treasury Balance: ", ethers.formatUnits(treasuryBal, 8));

      expect(minerBal).to.equal(ethers.parseUnits("47.5", 8));
      expect(treasuryBal).to.equal(ethers.parseUnits("2.5", 8));
    });

    it("Test 3: Agent stats cập nhật đúng sau khi mine", async function () {
      await commitRevealMine(miner, agentId, 99999);

      const stats = await aBTC.agentStats(agentId);
      expect(stats.totalWins).to.equal(1);
      expect(stats.totalEarned).to.equal(ethers.parseUnits("45", 8));
      expect(stats.lastWinRound).to.equal(1);
    });

    it("Test 4: Đào nhiều round liên tiếp", async function () {
      for (let i = 0; i < 3; i++) {
        await commitRevealMine(miner, agentId, 10000 + i);
      }

      expect(await aBTC.currentRound()).to.equal(4);
      expect(await aBTC.totalMined()).to.equal(INITIAL_REWARD * 3n);

      const stats = await aBTC.agentStats(agentId);
      expect(stats.totalWins).to.equal(3);
    });
  });

  // ═══════════════════════════════════════════════════════
  //  ACCESS CONTROL & VALIDATION
  // ═══════════════════════════════════════════════════════

  describe("Access Control", function () {
    it("Test 5: Người không có NFT không được commit", async function () {
      const commitHash = computeCommitHash(agentId, 123, otherAccount.address);
      await expect(
        aBTC.connect(otherAccount).commit(agentId, commitHash)
      ).to.be.revertedWithCustomError(aBTC, "NotAgentOwner");
    });

    it("Test 6: Không thể reveal nếu chưa commit", async function () {
      await expect(
        aBTC.connect(miner).revealAndMine(agentId, 0, 12345)
      ).to.be.revertedWithCustomError(aBTC, "NoValidCommit");
    });

    it("Test 7: Không thể reveal quá sớm (trước COMMIT_COOLDOWN)", async function () {
      const secret = 55555;
      const commitHash = computeCommitHash(agentId, secret, miner.address);
      await aBTC.connect(miner).commit(agentId, commitHash);

      await expect(
        aBTC.connect(miner).revealAndMine(agentId, 0, secret)
      ).to.be.revertedWithCustomError(aBTC, "RevealTooEarly");
    });

    it("Test 8: Commit hash sai phải bị từ chối", async function () {
      const commitHash = computeCommitHash(agentId, 11111, miner.address);
      await aBTC.connect(miner).commit(agentId, commitHash);
      await mineBlocks(2);

      await expect(
        aBTC.connect(miner).revealAndMine(agentId, 0, 99999)
      ).to.be.revertedWithCustomError(aBTC, "CommitMismatch");
    });

    it("Test 9: Empty commit bị từ chối", async function () {
      await expect(
        aBTC.connect(miner).commit(agentId, ethers.ZeroHash)
      ).to.be.revertedWithCustomError(aBTC, "EmptyCommit");
    });

    it("Test 10: Nonce sai (hash >= target) phải bị từ chối", async function () {
      const secret = 77777;
      const roundSeed = await aBTC.roundSeed();
      const difficulty = await aBTC.roundDifficulty();
      const target = ethers.MaxUint256 / difficulty;

      const commitHash = computeCommitHash(agentId, secret, miner.address);
      await aBTC.connect(miner).commit(agentId, commitHash);
      await mineBlocks(2);

      const enhancedSeed = computeEnhancedSeed(roundSeed, secret);
      let wrongNonce = 999999;
      let hashVal = computeHash(agentId, wrongNonce, enhancedSeed);
      while (BigInt(hashVal) < target) {
        wrongNonce++;
        hashVal = computeHash(agentId, wrongNonce, enhancedSeed);
      }

      await expect(
        aBTC.connect(miner).revealAndMine(agentId, wrongNonce, secret)
      ).to.be.revertedWithCustomError(aBTC, "InvalidNonce");
    });
  });

  // ═══════════════════════════════════════════════════════
  //  ANTI-FRONTRUN SECURITY
  // ═══════════════════════════════════════════════════════

  describe("Anti-Frontrun Security", function () {
    it("Test 11: Người khác không thể dùng commit của miner", async function () {
      const secret = 33333;
      const commitHash = computeCommitHash(agentId, secret, miner.address);
      await aBTC.connect(miner).commit(agentId, commitHash);
      await mineBlocks(2);

      await registry.connect(otherAccount).mint(otherAccount.address);

      await expect(
        aBTC.connect(otherAccount).revealAndMine(agentId, 0, secret)
      ).to.be.revertedWithCustomError(aBTC, "NoValidCommit");
    });

    it("Test 12: Enhanced seed khác nhau cho secret khác nhau", async function () {
      const roundSeed = await aBTC.roundSeed();
      const seed1 = computeEnhancedSeed(roundSeed, 111);
      const seed2 = computeEnhancedSeed(roundSeed, 222);
      expect(seed1).to.not.equal(seed2);
    });
  });

  // ═══════════════════════════════════════════════════════
  //  DIFFICULTY ADJUSTMENT
  // ═══════════════════════════════════════════════════════

  describe("Difficulty Adjustment", function () {
    it("Test 13: Difficulty tăng khi mine nhanh (< TARGET_TIME)", async function () {
      const EPOCH_LENGTH = Number(await aBTC.EPOCH_LENGTH());
      const MIN_DIFFICULTY = await aBTC.MIN_DIFFICULTY();

      for (let i = 0; i < EPOCH_LENGTH + 1; i++) {
        await commitRevealMine(miner, agentId, 50000 + i);
      }

      const diffAfter = await aBTC.roundDifficulty();
      console.log(`\nDifficulty after fast epoch: ${MIN_DIFFICULTY} → ${diffAfter}`);

      expect(diffAfter).to.be.greaterThan(MIN_DIFFICULTY);
    });

    it("Test 14: Difficulty giảm khi mine chậm (> TARGET_TIME)", async function () {
      const EPOCH_LENGTH = Number(await aBTC.EPOCH_LENGTH());
      const TARGET_TIME = Number(await aBTC.TARGET_TIME());

      for (let i = 0; i < EPOCH_LENGTH + 1; i++) {
        await commitRevealMine(miner, agentId, 60000 + i);
      }

      const diffAfterFastEpoch = await aBTC.roundDifficulty();
      console.log(`\nDifficulty after fast epoch: ${diffAfterFastEpoch}`);

      for (let i = 0; i < EPOCH_LENGTH; i++) {
        await ethers.provider.send("evm_increaseTime", [TARGET_TIME * 5]);
        await commitRevealMine(miner, agentId, 70000 + i);
      }

      const diffAfterSlowEpoch = await aBTC.roundDifficulty();
      console.log(`Difficulty after slow epoch: ${diffAfterFastEpoch} → ${diffAfterSlowEpoch}`);

      expect(diffAfterSlowEpoch).to.be.lessThan(diffAfterFastEpoch);
    });

    it("Test 15: Difficulty không giảm dưới MIN_DIFFICULTY", async function () {
      const MIN_DIFFICULTY = await aBTC.MIN_DIFFICULTY();
      const EPOCH_LENGTH = Number(await aBTC.EPOCH_LENGTH());
      const TARGET_TIME = Number(await aBTC.TARGET_TIME());

      for (let epoch = 0; epoch < 3; epoch++) {
        const roundsNeeded = epoch === 0 ? EPOCH_LENGTH + 1 : EPOCH_LENGTH;
        for (let i = 0; i < roundsNeeded; i++) {
          await ethers.provider.send("evm_increaseTime", [TARGET_TIME * 100]);
          await commitRevealMine(miner, agentId, 80000 + epoch * 100 + i);
        }
      }

      const diff = await aBTC.roundDifficulty();
      console.log(`\nDifficulty after very slow mining: ${diff}`);
      expect(diff).to.be.greaterThanOrEqual(MIN_DIFFICULTY);
    });

    it("Test 16: Clamp — difficulty không tăng quá 4x per epoch", async function () {
      const EPOCH_LENGTH = Number(await aBTC.EPOCH_LENGTH());
      const diffBefore = await aBTC.roundDifficulty();

      for (let i = 0; i < EPOCH_LENGTH + 1; i++) {
        await commitRevealMine(miner, agentId, 90000 + i);
      }

      const diffAfter = await aBTC.roundDifficulty();
      const maxAllowed = diffBefore * 4n;

      console.log(`\nClamp test: ${diffBefore} → ${diffAfter} (max allowed: ${maxAllowed})`);
      expect(diffAfter).to.be.lessThanOrEqual(maxAllowed);
      expect(diffAfter).to.be.greaterThan(diffBefore);
    });
  });

  // ═══════════════════════════════════════════════════════
  //  FORCE ADVANCE & EMERGENCY
  // ═══════════════════════════════════════════════════════

  describe("Force Advance & Emergency", function () {
    it("Test 17: forceAdvanceRound trước deadline bị từ chối", async function () {
      await expect(
        aBTC.connect(otherAccount).forceAdvanceRound()
      ).to.be.revertedWithCustomError(aBTC, "DeadlineNotReached");
    });

    it("Test 18: forceAdvanceRound sau deadline thành công, không mint reward", async function () {
      const roundBefore = await aBTC.currentRound();
      const totalMinedBefore = await aBTC.totalMined();

      await mineBlocks(257);

      await expect(aBTC.connect(otherAccount).forceAdvanceRound())
        .to.emit(aBTC, "RoundForceAdvanced")
        .withArgs(roundBefore, otherAccount.address);

      expect(await aBTC.currentRound()).to.equal(roundBefore + 1n);
      expect(await aBTC.totalMined()).to.equal(totalMinedBefore);
    });

    it("Test 19: emergencyDifficultyReset trước threshold bị từ chối", async function () {
      await expect(
        aBTC.connect(otherAccount).emergencyDifficultyReset()
      ).to.be.revertedWithCustomError(aBTC, "TooEarlyForEmergency");
    });

    it("Test 20: emergencyDifficultyReset sau threshold reset về MIN_DIFFICULTY", async function () {
      const TARGET_TIME = Number(await aBTC.TARGET_TIME());
      const EPOCH_LENGTH = Number(await aBTC.EPOCH_LENGTH());

      const threshold = TARGET_TIME * EPOCH_LENGTH * 10 + 1;
      await ethers.provider.send("evm_increaseTime", [threshold]);
      await ethers.provider.send("evm_mine", []);

      await aBTC.connect(otherAccount).emergencyDifficultyReset();
      expect(await aBTC.roundDifficulty()).to.equal(await aBTC.MIN_DIFFICULTY());
    });
  });

  // ═══════════════════════════════════════════════════════
  //  ADMIN / PAUSABLE
  // ═══════════════════════════════════════════════════════

  describe("Admin & Pausable", function () {
    it("Test 21: Admin có thể pause contract", async function () {
      await aBTC.connect(admin).pause();
      expect(await aBTC.paused()).to.equal(true);
    });

    it("Test 22: Non-admin không thể pause", async function () {
      await expect(
        aBTC.connect(otherAccount).pause()
      ).to.be.revertedWithCustomError(aBTC, "NotAdmin");
    });

    it("Test 23: Không thể commit khi paused", async function () {
      await aBTC.connect(admin).pause();
      const commitHash = computeCommitHash(agentId, 123, miner.address);
      await expect(
        aBTC.connect(miner).commit(agentId, commitHash)
      ).to.be.revertedWithCustomError(aBTC, "EnforcedPause");
    });

    it("Test 24: Không thể revealAndMine khi paused", async function () {
      const secret = 12345;
      const commitHash = computeCommitHash(agentId, secret, miner.address);
      await aBTC.connect(miner).commit(agentId, commitHash);
      await mineBlocks(2);

      await aBTC.connect(admin).pause();

      await expect(
        aBTC.connect(miner).revealAndMine(agentId, 0, secret)
      ).to.be.revertedWithCustomError(aBTC, "EnforcedPause");
    });

    it("Test 25: Không thể forceAdvanceRound khi paused", async function () {
      await mineBlocks(257);
      await aBTC.connect(admin).pause();

      await expect(
        aBTC.connect(otherAccount).forceAdvanceRound()
      ).to.be.revertedWithCustomError(aBTC, "EnforcedPause");
    });

    it("Test 26: Unpause cho phép mining tiếp", async function () {
      await aBTC.connect(admin).pause();
      await aBTC.connect(admin).unpause();

      await commitRevealMine(miner, agentId, 88888);
      expect(await aBTC.currentRound()).to.equal(2);
    });

    it("Test 27: Non-admin không thể unpause", async function () {
      await aBTC.connect(admin).pause();
      await expect(
        aBTC.connect(otherAccount).unpause()
      ).to.be.revertedWithCustomError(aBTC, "NotAdmin");
    });
  });

  // ═══════════════════════════════════════════════════════
  //  EDGE CASES
  // ═══════════════════════════════════════════════════════

  describe("Edge Cases", function () {
    it("Test 28: Miner overwrite commit trong cùng round", async function () {
      const hash1 = computeCommitHash(agentId, 11111, miner.address);
      await aBTC.connect(miner).commit(agentId, hash1);

      const hash2 = computeCommitHash(agentId, 22222, miner.address);
      await aBTC.connect(miner).commit(agentId, hash2);
      await mineBlocks(2);

      await expect(
        aBTC.connect(miner).revealAndMine(agentId, 0, 11111)
      ).to.be.revertedWithCustomError(aBTC, "CommitMismatch");
    });

    it("Test 29: Commit ở round cũ không dùng được ở round mới", async function () {
      const commitHash = computeCommitHash(agentId, 44444, miner.address);
      await aBTC.connect(miner).commit(agentId, commitHash);

      await commitRevealMine(miner, agentId, 55555);

      await mineBlocks(2);
      await expect(
        aBTC.connect(miner).revealAndMine(agentId, 0, 44444)
      ).to.be.revertedWithCustomError(aBTC, "NoValidCommit");
    });

    it("Test 30: computeCommitHash helper khớp off-chain", async function () {
      const expected = computeCommitHash(agentId, 12345, miner.address);
      const fromContract = await aBTC.computeCommitHash(agentId, 12345, miner.address);
      expect(fromContract).to.equal(expected);
    });

    it("Test 31: emergencyDifficultyReset vẫn hoạt động khi paused", async function () {
      const TARGET_TIME = Number(await aBTC.TARGET_TIME());
      const EPOCH_LENGTH = Number(await aBTC.EPOCH_LENGTH());

      await aBTC.connect(admin).pause();

      const threshold = TARGET_TIME * EPOCH_LENGTH * 10 + 1;
      await ethers.provider.send("evm_increaseTime", [threshold]);
      await ethers.provider.send("evm_mine", []);

      await aBTC.connect(otherAccount).emergencyDifficultyReset();
      expect(await aBTC.roundDifficulty()).to.equal(await aBTC.MIN_DIFFICULTY());
    });

    it("Test 32: Constructor revert nếu address = 0", async function () {
      const ABTCFactory = await ethers.getContractFactory("aBTC_PoW");

      await expect(
        ABTCFactory.deploy(ethers.ZeroAddress, treasury.address, admin.address)
      ).to.be.revertedWith("Invalid registry");

      await expect(
        ABTCFactory.deploy(registry.target, ethers.ZeroAddress, admin.address)
      ).to.be.revertedWith("Invalid treasury");

      await expect(
        ABTCFactory.deploy(registry.target, treasury.address, ethers.ZeroAddress)
      ).to.be.revertedWith("Invalid admin");
    });
  });

  // ═══════════════════════════════════════════════════════
  //  MULTI-MINER COMPETITION (20 miners)
  // ═══════════════════════════════════════════════════════

  describe("Multi-Miner Competition — 20 miners cạnh tranh", function () {
    const NUM_MINERS = 20;
    const NUM_ROUNDS = 10;
    let miners = [];
    let minerAgentIds = [];

    beforeEach(async function () {
      // Tạo 20 wallets mới thay vì lấy từ signers (Hardhat chỉ có ~20 signers)
      miners = [];
      minerAgentIds = [];

      for (let i = 0; i < NUM_MINERS; i++) {
        const wallet = ethers.Wallet.createRandom().connect(ethers.provider);

        // Fund ETH cho mỗi wallet để trả gas
        await owner.sendTransaction({
          to: wallet.address,
          value: ethers.parseEther("10"),
        });

        miners.push(wallet);

        // Mint NFT Agent (ID bắt đầu từ 2 vì beforeEach cha đã mint ID=1)
        await registry.connect(wallet).mint(wallet.address);
        minerAgentIds.push(i + 2);
      }
    });

    /**
     * Mô phỏng cạnh tranh: 20 miners cùng off-chain tìm nonce.
     * Mỗi round, TẤT CẢ 20 miners đều commit.
     * Nhưng chỉ người tìm thấy nonce NHANH NHẤT (nonce nhỏ nhất) mới revealAndMine thắng.
     * Sau khi 1 người thắng → round mới, những commit còn lại bị invalidate.
     */
    it("Test 33: 20 miners cạnh tranh qua nhiều rounds — thống kê win rate", async function () {
      this.timeout(120_000); // 2 phút vì nhiều computation

      const winCount = new Array(NUM_MINERS).fill(0);
      const totalNonces = new Array(NUM_MINERS).fill(0);

      console.log(`\n╔══════════════════════════════════════════════════╗`);
      console.log(`║   🏁 CUỘC ĐUA MINING: ${NUM_MINERS} MINERS × ${NUM_ROUNDS} ROUNDS       ║`);
      console.log(`╚══════════════════════════════════════════════════╝\n`);

      for (let round = 0; round < NUM_ROUNDS; round++) {
        const roundSeed = await aBTC.roundSeed();
        const difficulty = await aBTC.roundDifficulty();
        const target = ethers.MaxUint256 / difficulty;

        // Mỗi miner chọn 1 secret ngẫu nhiên
        const secrets = miners.map((_, i) => Math.floor(Math.random() * 1_000_000) + round * 1_000_000 + i * 100_000);

        // Phase 1: TẤT CẢ 20 miners commit
        for (let i = 0; i < NUM_MINERS; i++) {
          const commitHash = computeCommitHash(minerAgentIds[i], secrets[i], miners[i].address);
          await aBTC.connect(miners[i]).commit(minerAgentIds[i], commitHash);
        }

        await mineBlocks(2);

        // Phase 2: Off-chain — mỗi miner tìm nonce cho enhancedSeed của mình
        let bestMinerIdx = -1;
        let bestNonce = Infinity;
        let bestHashVal;

        for (let i = 0; i < NUM_MINERS; i++) {
          const enhancedSeed = computeEnhancedSeed(roundSeed, secrets[i]);
          let nonce = 0;
          let found = false;

          // Mỗi miner thử tối đa 50000 nonces (giới hạn computation)
          while (nonce < 50_000) {
            const hashVal = computeHash(minerAgentIds[i], nonce, enhancedSeed);
            if (BigInt(hashVal) < target) {
              totalNonces[i] += nonce;
              // Miner tìm thấy nonce nhỏ nhất = phản ứng nhanh nhất
              if (nonce < bestNonce) {
                bestMinerIdx = i;
                bestNonce = nonce;
                bestHashVal = hashVal;
              }
              found = true;
              break;
            }
            nonce++;
          }

          if (!found) {
            totalNonces[i] += 50_000;
          }
        }

        // Người nhanh nhất submit on-chain
        if (bestMinerIdx >= 0) {
          const winner = miners[bestMinerIdx];
          const winnerAgent = minerAgentIds[bestMinerIdx];
          const winnerSecret = secrets[bestMinerIdx];

          await aBTC.connect(winner).revealAndMine(winnerAgent, bestNonce, winnerSecret);
          winCount[bestMinerIdx]++;

          console.log(`  Round ${round + 1}: 🏆 Miner #${bestMinerIdx + 1} (Agent ${winnerAgent}) thắng — nonce=${bestNonce}`);
        } else {
          // Không ai tìm được → force advance
          await mineBlocks(257);
          await aBTC.connect(owner).forceAdvanceRound();
          console.log(`  Round ${round + 1}: ❌ Không ai tìm được nonce — orphaned`);
        }
      }

      // ═══════════════════════════════════════════════════════
      //  THỐNG KÊ
      // ═══════════════════════════════════════════════════════

      const totalWins = winCount.reduce((a, b) => a + b, 0);
      const winnersSet = winCount.filter((w) => w > 0).length;

      console.log(`\n╔══════════════════════════════════════════════════╗`);
      console.log(`║                📊 KẾT QUẢ THỐNG KÊ              ║`);
      console.log(`╠══════════════════════════════════════════════════╣`);
      console.log(`║  Tổng rounds:        ${NUM_ROUNDS.toString().padStart(5)}                     ║`);
      console.log(`║  Rounds có winner:   ${totalWins.toString().padStart(5)}                     ║`);
      console.log(`║  Miners tham gia:    ${NUM_MINERS.toString().padStart(5)}                     ║`);
      console.log(`║  Miners thắng ≥1:    ${winnersSet.toString().padStart(5)}                     ║`);
      console.log(`╠══════════════════════════════════════════════════╣`);

      // Bảng chi tiết từng miner
      console.log(`║  #   │ Wins │ Win%   │ Avg Nonce │ Balance      ║`);
      console.log(`║──────┼──────┼────────┼───────────┼──────────────║`);

      for (let i = 0; i < NUM_MINERS; i++) {
        const bal = await aBTC.balanceOf(miners[i].address);
        const balFormatted = ethers.formatUnits(bal, 8);
        const winPct = ((winCount[i] / NUM_ROUNDS) * 100).toFixed(1);
        const avgNonce = winCount[i] > 0 ? Math.round(totalNonces[i] / NUM_ROUNDS) : "-";

        const marker = winCount[i] > 0 ? "✅" : "  ";
        console.log(
          `║  ${marker} ${(i + 1).toString().padStart(2)} │ ${winCount[i].toString().padStart(4)} │ ${winPct.padStart(5)}% │ ${avgNonce.toString().padStart(9)} │ ${balFormatted.padStart(12)} ║`
        );
      }

      console.log(`╠══════════════════════════════════════════════════╣`);

      // Tổng supply & treasury
      const totalMinedVal = await aBTC.totalMined();
      const treasuryBal = await aBTC.balanceOf(treasury.address);
      console.log(`║  Total mined:  ${ethers.formatUnits(totalMinedVal, 8).padStart(12)} aBTC            ║`);
      console.log(`║  Treasury:     ${ethers.formatUnits(treasuryBal, 8).padStart(12)} aBTC            ║`);
      console.log(`╚══════════════════════════════════════════════════╝`);

      // Assertions
      expect(totalWins).to.be.greaterThan(0);
      expect(totalWins).to.be.lessThanOrEqual(NUM_ROUNDS);

      // Verify on-chain stats khớp
      for (let i = 0; i < NUM_MINERS; i++) {
        const stats = await aBTC.agentStats(minerAgentIds[i]);
        expect(stats.totalWins).to.equal(winCount[i]);

        if (winCount[i] > 0) {
          const bal = await aBTC.balanceOf(miners[i].address);
          expect(bal).to.be.greaterThan(0);
        }
      }

      // Total mined phải = totalWins × INITIAL_REWARD
      expect(totalMinedVal).to.equal(INITIAL_REWARD * BigInt(totalWins));
    });

    it("Test 34: Verify phân phối công bằng — không miner nào monopolize", async function () {
      this.timeout(180_000);

      const ACTIVE_MINERS = 5;  // Chỉ 5 miners thay vì 20
      const LONG_ROUNDS = 10;
      const winCount = new Array(ACTIVE_MINERS).fill(0);

      console.log(`\n--- Chạy ${LONG_ROUNDS} rounds với ${ACTIVE_MINERS} miners ---`);

      for (let round = 0; round < LONG_ROUNDS; round++) {
        const roundSeed = await aBTC.roundSeed();
        const difficulty = await aBTC.roundDifficulty();
        const target = ethers.MaxUint256 / difficulty;

        // Deterministic secrets
        const secrets = [];
        for (let i = 0; i < ACTIVE_MINERS; i++) {
          secrets.push(round * 100_000 + i * 7777 + 42);
        }

        for (let i = 0; i < ACTIVE_MINERS; i++) {
          const commitHash = computeCommitHash(minerAgentIds[i], secrets[i], miners[i].address);
          await aBTC.connect(miners[i]).commit(minerAgentIds[i], commitHash);
        }

        await mineBlocks(2);

        let bestMinerIdx = -1;
        let bestNonce = Infinity;

        for (let i = 0; i < ACTIVE_MINERS; i++) {
          const enhancedSeed = computeEnhancedSeed(roundSeed, secrets[i]);

          for (let nonce = 0; nonce < 5_000; nonce++) {
            const hashVal = computeHash(minerAgentIds[i], nonce, enhancedSeed);
            if (BigInt(hashVal) < target) {
              if (nonce < bestNonce) {
                bestMinerIdx = i;
                bestNonce = nonce;
              }
              break;
            }
          }
        }

        if (bestMinerIdx >= 0) {
          await aBTC.connect(miners[bestMinerIdx]).revealAndMine(
            minerAgentIds[bestMinerIdx],
            bestNonce,
            secrets[bestMinerIdx]
          );
          winCount[bestMinerIdx]++;
        } else {
          await mineBlocks(257);
          await aBTC.connect(owner).forceAdvanceRound();
        }

        if ((round + 1) % 5 === 0) console.log(`  ... ${round + 1}/${LONG_ROUNDS} rounds done`);
      }

      const winnersCount = winCount.filter((w) => w > 0).length;
      const maxWins = Math.max(...winCount);

      console.log(`\nMiners thắng ≥1 lần: ${winnersCount}/${ACTIVE_MINERS}`);
      console.log(`Max wins: ${maxWins}/${LONG_ROUNDS}`);
      console.log(`Distribution: [${winCount.join(", ")}]`);

      expect(winnersCount).to.be.greaterThanOrEqual(2);
      expect(maxWins).to.be.lessThanOrEqual(Math.ceil(LONG_ROUNDS * 0.8));
    });
    
    it("Test 35: Miner thua vẫn giữ balance = 0 (không bị mất tiền)", async function () {
      const roundSeed = await aBTC.roundSeed();
      const difficulty = await aBTC.roundDifficulty();
      const target = ethers.MaxUint256 / difficulty;

      // Chỉ miner 0 commit và thắng
      const secret = 123456;
      const commitHash = computeCommitHash(minerAgentIds[0], secret, miners[0].address);
      await aBTC.connect(miners[0]).commit(minerAgentIds[0], commitHash);
      await mineBlocks(2);

      const enhancedSeed = computeEnhancedSeed(roundSeed, secret);
      let nonce = 0;
      while (true) {
        const hashVal = computeHash(minerAgentIds[0], nonce, enhancedSeed);
        if (BigInt(hashVal) < target) break;
        nonce++;
      }

      await aBTC.connect(miners[0]).revealAndMine(minerAgentIds[0], nonce, secret);

      // Miner 0 nhận reward
      const winnerBal = await aBTC.balanceOf(miners[0].address);
      expect(winnerBal).to.be.greaterThan(0);

      // Tất cả miners khác balance = 0
      for (let i = 1; i < NUM_MINERS; i++) {
        const bal = await aBTC.balanceOf(miners[i].address);
        expect(bal).to.equal(0);
      }

      console.log(`\nWinner (Miner #1): ${ethers.formatUnits(winnerBal, 8)} aBTC`);
      console.log(`All other 19 miners: 0 aBTC ✅`);
    });
  });
});