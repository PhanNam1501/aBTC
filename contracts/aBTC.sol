// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/token/ERC721/IERC721.sol";

contract aBTC_PoW is ERC20 {
    // --- CONFIGURATION ---
    uint256 public constant MAX_SUPPLY = 21_000_000 * 1e8;
    uint256 public constant INITIAL_REWARD = 50 * 1e8;
    uint256 public constant HALVING_INTERVAL = 210_000;
    
    // Ensures Target < MaxUint, enabling the "Invalid Nonce" test case to function correctly.
    uint256 public constant MIN_DIFFICULTY = 1000; 
    uint256 public constant TARGET_TIME = 60; 

    // Reward Split Configuration (Basis points: 10000 = 100%)
    uint256 public constant MINER_SHARE = 9000;      // 90% to Agent Owner
    uint256 public constant VALIDATOR_SHARE = 500;   // 5% to Transaction Sender
    uint256 public constant PLATFORM_SHARE = 500;    // 5% to Treasury

    // --- STATE ---
    IERC721 public immutable agentRegistry;
    address public immutable treasury;

    uint256 public currentRound;
    uint256 public roundStartBlock;
    uint256 public roundDifficulty;
    uint256 public roundSeed;
    uint256 public totalMined;

    struct AgentStats {
        uint64 totalWins;
        uint128 totalEarned;
        uint64 lastWinRound;
    }
    mapping(uint256 => AgentStats) public agentStats;

    // --- EVENTS ---
    event RoundStarted(uint256 indexed round, uint256 difficulty, uint256 seed);
    event MineSuccess(uint256 indexed round, uint256 indexed agentId, uint256 nonce, uint256 hashVal);
    
    constructor(address _agentRegistry, address _treasury) ERC20("Agent Bitcoin", "aBTC") {
        agentRegistry = IERC721(_agentRegistry);
        treasury = _treasury;
        
        currentRound = 1;
        roundStartBlock = block.number;
        roundDifficulty = MIN_DIFFICULTY;
        // Use prevrandao for modern EVM, fallback to blockhash for older chains
        roundSeed = block.prevrandao > 0 ? block.prevrandao : uint256(blockhash(block.number - 1));
    }

    function decimals() public pure override returns (uint8) { return 8; }

    // --- VIEW FUNCTIONS ---

    function getReward() public view returns (uint256) {
        uint256 era = currentRound / HALVING_INTERVAL;
        if (era >= 64) return 0;
        return INITIAL_REWARD >> era;
    }

    function getTarget() public view returns (uint256) {
        // Protect against division by zero
        uint256 diff = roundDifficulty == 0 ? 1 : roundDifficulty;
        return type(uint256).max / diff;
    }

    function computeHash(uint256 agentId, uint256 nonce, uint256 seed) public pure returns (uint256) {
        return uint256(keccak256(abi.encodePacked(agentId, nonce, seed)));
    }

    // --- MINING ACTIONS ---

    function submitPoW(uint256 agentId, uint256 nonce) external {
        require(totalMined < MAX_SUPPLY, "Mining finished");
        require(agentRegistry.ownerOf(agentId) == msg.sender, "Not agent owner");

        uint256 hashVal = computeHash(agentId, nonce, roundSeed);
        uint256 target = getTarget();

        require(hashVal < target, "Invalid Nonce");

        // Emit event before finalizing round to capture correct round number
        emit MineSuccess(currentRound, agentId, nonce, hashVal);

        _finalizeRound(agentId);
    }

    function _finalizeRound(uint256 winningAgentId) internal {
        uint256 reward = getReward();
        
        // Cap logic if max supply is exceeded
        if (totalMined + reward > MAX_SUPPLY) {
            reward = MAX_SUPPLY - totalMined;
        }

        if (reward > 0) {
            address agentOwner = agentRegistry.ownerOf(winningAgentId);

            uint256 minerAmt = (reward * MINER_SHARE) / 10000;
            uint256 validatorAmt = (reward * VALIDATOR_SHARE) / 10000;
            uint256 platformAmt = reward - minerAmt - validatorAmt;

            _mint(agentOwner, minerAmt);
            _mint(msg.sender, validatorAmt);
            _mint(treasury, platformAmt);

            totalMined += reward;

            AgentStats storage stats = agentStats[winningAgentId];
            stats.totalWins++;
            stats.totalEarned += uint128(minerAmt);
            stats.lastWinRound = uint64(currentRound);
        }

        // --- DIFFICULTY ADJUSTMENT ---
        uint256 blocksPassed = block.number - roundStartBlock;
        
        // Calculate adjustment amount (at least 1 unit)
        uint256 adjustment = roundDifficulty / 20; 
        if (adjustment == 0) adjustment = 1;

        if (blocksPassed < TARGET_TIME) {
            roundDifficulty += adjustment;
        } else if (blocksPassed > TARGET_TIME && roundDifficulty > MIN_DIFFICULTY) {
            // Ensure difficulty doesn't drop below minimum
            if (roundDifficulty > adjustment) {
                roundDifficulty -= adjustment;
            } else {
                roundDifficulty = MIN_DIFFICULTY;
            }
        }

        // --- NEW ROUND ---
        currentRound++;
        roundStartBlock = block.number;
        // Update seed for the next round
        roundSeed = block.prevrandao > 0 ? block.prevrandao : uint256(blockhash(block.number - 1));

        emit RoundStarted(currentRound, roundDifficulty, roundSeed);
    }
}