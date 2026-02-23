// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/IERC721.sol";

interface IaBTC_PoW {
    // ══════════════════════════════════════════════════════════
    //                        STRUCTS
    // ══════════════════════════════════════════════════════════

    struct Commitment {
        bytes32 commitHash;
        uint256 commitBlock;
        address committer;
    }

    struct AgentStats {
        uint64 totalWins;
        uint128 totalEarned;
        uint64 lastWinRound;
    }

    // ══════════════════════════════════════════════════════════
    //                        EVENTS
    // ══════════════════════════════════════════════════════════

    event RoundStarted(uint256 indexed round, uint256 difficulty, uint256 seed);
    event MineSuccess(uint256 indexed round, uint256 indexed agentId, uint256 nonce, uint256 hashVal);
    event DifficultyAdjusted(uint256 indexed epochNumber, uint256 oldDifficulty, uint256 newDifficulty, uint256 elapsed, uint256 expected);
    event Committed(uint256 indexed round, uint256 indexed agentId, address committer);
    event RoundForceAdvanced(uint256 indexed round, address caller);

    // ══════════════════════════════════════════════════════════
    //                        ERRORS
    // ══════════════════════════════════════════════════════════

    error MiningFinished();
    error NotAgentOwner();
    error EmptyCommit();
    error NoValidCommit();
    error RevealTooEarly();
    error CommitMismatch();
    error InvalidNonce();
    error DeadlineNotReached();
    error TooEarlyForEmergency();
    error NoRandomnessSource();
    error NotAdmin();
    error EarnedOverflow();

    // ══════════════════════════════════════════════════════════
    //                       CONSTANTS
    // ══════════════════════════════════════════════════════════

    function MAX_SUPPLY() external view returns (uint256);
    function INITIAL_REWARD() external view returns (uint256);
    function HALVING_INTERVAL() external view returns (uint256);
    function MIN_DIFFICULTY() external view returns (uint256);
    function MAX_DIFFICULTY() external view returns (uint256);
    function TARGET_TIME() external view returns (uint256);
    function MAX_ADJUSTMENT_FACTOR() external view returns (uint256);
    function EPOCH_LENGTH() external view returns (uint256);
    function MINER_SHARE() external view returns (uint256);
    function VALIDATOR_SHARE() external view returns (uint256);
    function PLATFORM_SHARE() external view returns (uint256);
    function COMMIT_COOLDOWN() external view returns (uint256);
    function REVEAL_DEADLINE() external view returns (uint256);

    // ══════════════════════════════════════════════════════════
    //                    STATE GETTERS
    // ══════════════════════════════════════════════════════════

    function agentRegistry() external view returns (IERC721);
    function treasury() external view returns (address);
    function admin() external view returns (address);
    function currentRound() external view returns (uint256);
    function roundStartTime() external view returns (uint256);
    function roundStartBlock() external view returns (uint256);
    function epochStartTime() external view returns (uint256);
    function epochStartRound() external view returns (uint256);
    function roundDifficulty() external view returns (uint256);
    function roundSeed() external view returns (uint256);
    function totalMined() external view returns (uint256);

    function commitments(uint256 round, uint256 agentId) external view returns (
        bytes32 commitHash,
        uint256 commitBlock,
        address committer
    );

    function agentStats(uint256 agentId) external view returns (
        uint64 totalWins,
        uint128 totalEarned,
        uint64 lastWinRound
    );

    // ══════════════════════════════════════════════════════════
    //                    VIEW FUNCTIONS
    // ══════════════════════════════════════════════════════════

    function decimals() external pure returns (uint8);
    function getReward() external view returns (uint256);
    function getTarget() external view returns (uint256);
    function computeHash(uint256 agentId, uint256 nonce, uint256 seed) external pure returns (uint256);
    function roundsUntilAdjustment() external view returns (uint256);
    function computeCommitHash(uint256 agentId, uint256 secret, address miner) external pure returns (bytes32);

    // ══════════════════════════════════════════════════════════
    //                    MINING ACTIONS
    // ══════════════════════════════════════════════════════════

    function commit(uint256 agentId, bytes32 commitHash) external;
    function revealAndMine(uint256 agentId, uint256 nonce, uint256 secret) external;
    function forceAdvanceRound() external;
    function emergencyDifficultyReset() external;

    // ══════════════════════════════════════════════════════════
    //                    ADMIN FUNCTIONS
    // ══════════════════════════════════════════════════════════

    function pause() external;
    function unpause() external;
}