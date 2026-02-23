// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import {IaBTC_PoW} from "./interfaces/IaBTC_PoW.sol";

/**
 * @title aBTC_PoW — Agent Bitcoin Proof-of-Work Mining
 * @notice ERC20 token mined via on-chain PoW with Bitcoin-like economics.
 *
 * [Seed / Randomness]
 *   - Commit-Reveal scheme prevents front-running and pre-computation attacks.
 *   - enhancedSeed = keccak256(roundSeed XOR secret)
 *     Neither the validator nor the miner can unilaterally control the seed.
 *   - Fallback: forceAdvanceRound if the round gets stuck.
 *
 * [Difficulty Adjustment]
 *   - Epoch-based (every EPOCH_LENGTH rounds), proportional like Bitcoin.
 *   - Clamped to 4x per epoch, timestamp-based.
 *   - Emergency reset in case of death spiral.
 *
 * [Reward]
 *   - 50 aBTC initial, halving every 210k rounds, max 21M supply.
 *   - Split: 90% miner, 5% validator (tx sender), 5% treasury.
 *
 * [Security]
 *   - ReentrancyGuard on all external mutative functions.
 *   - Pausable by admin upon exploit detection.
 *   - prevrandao validation against zero-seed on pre-merge/L2 chains.
 *   - abi.encode instead of abi.encodePacked to prevent hash collisions.
 */
contract aBTC_PoW is ERC20, IaBTC_PoW, ReentrancyGuard, Pausable {
    // ══════════════════════════════════════════════════════════
    //                      CONSTANTS
    // ══════════════════════════════════════════════════════════

    // --- Supply & Reward ---
    uint256 public constant MAX_SUPPLY = 21_000_000 * 1e8;
    uint256 public constant INITIAL_REWARD = 50 * 1e8;
    uint256 public constant HALVING_INTERVAL = 210_000;

    // --- Difficulty ---
    uint256 public constant MIN_DIFFICULTY = 1000;
    uint256 public constant MAX_DIFFICULTY = type(uint256).max / 2;
    uint256 public constant TARGET_TIME = 60; // seconds per round
    uint256 public constant MAX_ADJUSTMENT_FACTOR = 4; // clamp 4x per epoch
    uint256 public constant EPOCH_LENGTH = 10; // rounds per epoch

    // --- Reward Split (basis points, 10000 = 100%) ---
    uint256 public constant MINER_SHARE = 9000;  // 90%
    uint256 public constant VALIDATOR_SHARE = 500; // 5%
    uint256 public constant PLATFORM_SHARE = 500;  // 5%

    // --- Commit-Reveal ---
    uint256 public constant COMMIT_COOLDOWN = 1;  // must wait at least 1 block after commit before reveal
    uint256 public constant REVEAL_DEADLINE = 256; // blocks — if no reveal within 256 blocks, round is force-advanced

    // ══════════════════════════════════════════════════════════
    //                        STATE
    // ══════════════════════════════════════════════════════════

    IERC721 public immutable agentRegistry;
    address public immutable treasury;
    address public immutable admin;

    uint256 public currentRound;
    uint256 public roundStartTime;
    uint256 public roundStartBlock;
    uint256 public epochStartTime;
    uint256 public epochStartRound;
    uint256 public roundDifficulty;
    uint256 public roundSeed;
    uint256 public totalMined;

    /// @dev round => agentId => Commitment
    mapping(uint256 => mapping(uint256 => Commitment)) public commitments;

    mapping(uint256 => AgentStats) public agentStats;

    // ══════════════════════════════════════════════════════════
    //                      CONSTRUCTOR
    // ══════════════════════════════════════════════════════════

    constructor(
        address _agentRegistry,
        address _treasury,
        address _admin
    ) ERC20("Agent Bitcoin", "aBTC") {
        require(_agentRegistry != address(0), "Invalid registry");
        require(_treasury != address(0), "Invalid treasury");
        require(_admin != address(0), "Invalid admin");

        // Compile-time share validation
        assert(MINER_SHARE + VALIDATOR_SHARE + PLATFORM_SHARE == 10000);

        agentRegistry = IERC721(_agentRegistry);
        treasury = _treasury;
        admin = _admin;

        currentRound = 1;
        roundStartTime = block.timestamp;
        roundStartBlock = block.number;
        epochStartTime = block.timestamp;
        epochStartRound = 1;
        roundDifficulty = MIN_DIFFICULTY;
        roundSeed = _generateSeed();
    }

    function decimals() public pure override(ERC20, IaBTC_PoW) returns (uint8) {
        return 8;
    }

    // ══════════════════════════════════════════════════════════
    //                    VIEW FUNCTIONS
    // ══════════════════════════════════════════════════════════

    function getReward() public view override returns (uint256) {
        uint256 era = currentRound / HALVING_INTERVAL;
        if (era >= 64) return 0;
        return INITIAL_REWARD >> era;
    }

    function getTarget() public view override returns (uint256) {
        uint256 diff = roundDifficulty < MIN_DIFFICULTY ? MIN_DIFFICULTY : roundDifficulty;
        return type(uint256).max / diff;
    }

    function computeHash(
        uint256 agentId,
        uint256 nonce,
        uint256 seed
    ) public pure override returns (uint256) {
        return uint256(keccak256(abi.encode(agentId, nonce, seed)));
    }

    function roundsUntilAdjustment() external view override returns (uint256) {
        uint256 roundsInEpoch = currentRound - epochStartRound;
        if (roundsInEpoch >= EPOCH_LENGTH) return 0;
        return EPOCH_LENGTH - roundsInEpoch;
    }

    /// @notice Helper for miners to compute commitHash off-chain before calling commit().
    function computeCommitHash(
        uint256 agentId,
        uint256 secret,
        address miner
    ) external pure override returns (bytes32) {
        return keccak256(abi.encode(agentId, secret, miner));
    }

    // ══════════════════════════════════════════════════════════
    //                 COMMIT-REVEAL MINING
    // ══════════════════════════════════════════════════════════

    /**
     * @notice Phase 1: Commit — miner submits hash(agentId, secret, msg.sender).
     * @param agentId    NFT agent ID owned by the miner
     * @param commitHash keccak256(abi.encode(agentId, secret, msg.sender))
     */
    function commit(
        uint256 agentId,
        bytes32 commitHash
    ) external override whenNotPaused {
        if (totalMined >= MAX_SUPPLY) revert MiningFinished();
        if (agentRegistry.ownerOf(agentId) != msg.sender) revert NotAgentOwner();
        if (commitHash == bytes32(0)) revert EmptyCommit();

        // Allow overwriting previous commit in the same round (miner changed their mind)
        commitments[currentRound][agentId] = Commitment({
            commitHash: commitHash,
            commitBlock: block.number,
            committer: msg.sender
        });

        emit Committed(currentRound, agentId, msg.sender);
    }

    /**
     * @notice Phase 2: Reveal secret + submit PoW nonce.
     * @dev    enhancedSeed = keccak256(roundSeed XOR secret)
     *         hashVal = keccak256(agentId, nonce, enhancedSeed) must be < target
     * @param agentId NFT agent ID
     * @param nonce   PoW nonce found off-chain by the miner
     * @param secret  Secret value previously committed
     */
    function revealAndMine(
        uint256 agentId,
        uint256 nonce,
        uint256 secret
    ) external override nonReentrant whenNotPaused {
        if (totalMined >= MAX_SUPPLY) revert MiningFinished();

        // --- Verify Commitment ---
        Commitment storage c = commitments[currentRound][agentId];
        if (c.committer != msg.sender) revert NoValidCommit();
        if (block.number <= c.commitBlock + COMMIT_COOLDOWN) revert RevealTooEarly();

        bytes32 expectedHash = keccak256(abi.encode(agentId, secret, msg.sender));
        if (c.commitHash != expectedHash) revert CommitMismatch();

        // --- Verify Agent Ownership (may have been transferred after commit) ---
        if (agentRegistry.ownerOf(agentId) != msg.sender) revert NotAgentOwner();

        // --- Enhanced Seed ---
        // XOR roundSeed with secret before hashing:
        // - Validator knows prevrandao but not the miner's secret
        // - Miner knows the secret but not prevrandao at commit time
        uint256 enhancedSeed = uint256(keccak256(abi.encode(roundSeed ^ secret)));

        // --- PoW Verification ---
        uint256 hashVal = computeHash(agentId, nonce, enhancedSeed);
        uint256 target = getTarget();
        if (hashVal >= target) revert InvalidNonce();

        // --- Invalidate commitment ---
        delete commitments[currentRound][agentId];

        emit MineSuccess(currentRound, agentId, nonce, hashVal);

        _finalizeRound(agentId);
    }

    /**
     * @notice Force-advance the round if no one reveals within REVEAL_DEADLINE blocks.
     *         The round becomes orphaned — no reward is minted.
     */
    function forceAdvanceRound() external override nonReentrant whenNotPaused {
        if (block.number <= roundStartBlock + REVEAL_DEADLINE) revert DeadlineNotReached();

        emit RoundForceAdvanced(currentRound, msg.sender);

        // Run difficulty adjustment if at epoch boundary
        uint256 roundsInEpoch = currentRound - epochStartRound;
        if (roundsInEpoch >= EPOCH_LENGTH) {
            _adjustDifficulty();
        }

        // Advance round without minting rewards
        currentRound++;
        roundStartTime = block.timestamp;
        roundStartBlock = block.number;
        roundSeed = _generateSeed();

        emit RoundStarted(currentRound, roundDifficulty, roundSeed);
    }

    // ══════════════════════════════════════════════════════════
    //                    ADMIN FUNCTIONS
    // ══════════════════════════════════════════════════════════

    /// @notice Pause mining upon exploit detection or for maintenance.
    function pause() external {
        if (msg.sender != admin) revert NotAdmin();
        _pause();
    }

    /// @notice Unpause mining to resume normal operations.
    function unpause() external {
        if (msg.sender != admin) revert NotAdmin();
        _unpause();
    }

    // ══════════════════════════════════════════════════════════
    //                     EMERGENCY
    // ══════════════════════════════════════════════════════════

    /**
     * @notice Emergency reset in case of a death spiral — difficulty too high, no one can mine.
     *         Requires: 10x the expected epoch time has elapsed without epoch completion.
     *         Permissionless — anyone can call.
     */
    function emergencyDifficultyReset() external override nonReentrant {
        uint256 elapsed = block.timestamp - epochStartTime;
        uint256 threshold = TARGET_TIME * EPOCH_LENGTH * 10;
        if (elapsed <= threshold) revert TooEarlyForEmergency();

        uint256 oldDifficulty = roundDifficulty;
        roundDifficulty = MIN_DIFFICULTY;
        epochStartTime = block.timestamp;
        epochStartRound = currentRound;
        roundStartTime = block.timestamp;
        roundStartBlock = block.number;
        roundSeed = _generateSeed();

        emit DifficultyAdjusted(0, oldDifficulty, MIN_DIFFICULTY, elapsed, TARGET_TIME * EPOCH_LENGTH);
        emit RoundStarted(currentRound, roundDifficulty, roundSeed);
    }

    // ══════════════════════════════════════════════════════════
    //                     INTERNAL
    // ══════════════════════════════════════════════════════════

    function _finalizeRound(uint256 winningAgentId) internal {
        uint256 reward = getReward();

        // Cap reward if it would exceed max supply
        if (totalMined + reward > MAX_SUPPLY) {
            reward = MAX_SUPPLY - totalMined;
        }

        if (reward > 0) {
            // Cache ownerOf — single external call, reuse result
            address agentOwner = agentRegistry.ownerOf(winningAgentId);

            uint256 minerAmt = (reward * MINER_SHARE) / 10000;
            uint256 validatorAmt = (reward * VALIDATOR_SHARE) / 10000;
            uint256 platformAmt = reward - minerAmt - validatorAmt; // Remainder avoids rounding loss

            _mint(agentOwner, minerAmt);
            _mint(msg.sender, validatorAmt);
            _mint(treasury, platformAmt);

            totalMined += reward;

            // Safe cast for totalEarned
            if (minerAmt > type(uint128).max) revert EarnedOverflow();

            AgentStats storage stats = agentStats[winningAgentId];
            stats.totalWins++;
            stats.totalEarned += uint128(minerAmt);
            stats.lastWinRound = uint64(currentRound);
        }

        // --- Difficulty Adjustment ---
        uint256 roundsInEpoch = currentRound - epochStartRound;
        if (roundsInEpoch >= EPOCH_LENGTH) {
            _adjustDifficulty();
        }

        // --- New Round ---
        currentRound++;
        roundStartTime = block.timestamp;
        roundStartBlock = block.number;
        roundSeed = _generateSeed();

        emit RoundStarted(currentRound, roundDifficulty, roundSeed);
    }

    /**
     * @dev Proportional difficulty adjustment with clamp bounds.
     *      newDifficulty = oldDifficulty * expectedTime / actualTime
     *      Clamp: [old/4, old*4], bounded by [MIN_DIFFICULTY, MAX_DIFFICULTY]
     */
    function _adjustDifficulty() internal {
        uint256 elapsed = block.timestamp - epochStartTime;
        uint256 roundsInEpoch = currentRound - epochStartRound;
        uint256 expectedTime = roundsInEpoch * TARGET_TIME;

        uint256 oldDifficulty = roundDifficulty;
        uint256 newDifficulty;

        if (elapsed == 0) {
            // All rounds mined within the same second — increase to max
            newDifficulty = oldDifficulty * MAX_ADJUSTMENT_FACTOR;
        } else {
            newDifficulty = (oldDifficulty * expectedTime) / elapsed;

            // Clamp bounds
            uint256 maxDiff = oldDifficulty * MAX_ADJUSTMENT_FACTOR;
            uint256 minDiff = oldDifficulty / MAX_ADJUSTMENT_FACTOR;

            if (newDifficulty > maxDiff) {
                newDifficulty = maxDiff;
            } else if (newDifficulty < minDiff) {
                newDifficulty = minDiff;
            }
        }

        // Enforce global bounds
        if (newDifficulty < MIN_DIFFICULTY) newDifficulty = MIN_DIFFICULTY;
        if (newDifficulty > MAX_DIFFICULTY) newDifficulty = MAX_DIFFICULTY;

        roundDifficulty = newDifficulty;

        emit DifficultyAdjusted(
            currentRound / EPOCH_LENGTH,
            oldDifficulty,
            newDifficulty,
            elapsed,
            expectedTime
        );

        // Reset epoch
        epochStartTime = block.timestamp;
        epochStartRound = currentRound;
    }

    /**
     * @dev Generate seed for the new round.
     *      Uses prevrandao as the base. Reverts if no randomness source is available
     *      (pre-merge chain or L2 without prevrandao support).
     *      Fallback: blockhash if prevrandao is 0 but blockhash is available.
     */
    function _generateSeed() internal view returns (uint256) {
        if (block.prevrandao != 0) {
            return block.prevrandao;
        }

        // Fallback for pre-merge chains or L2s
        uint256 fallbackSeed = uint256(blockhash(block.number - 1));
        if (fallbackSeed != 0) {
            return fallbackSeed;
        }

        revert NoRandomnessSource();
    }
}