// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";

contract MockRegistry is ERC721 {
    uint256 public nextTokenId = 1;

    constructor() ERC721("Mock Agent", "MOCK") {}

    function mint(address to) external returns (uint256) {
        uint256 tokenId = nextTokenId++;
        _mint(to, tokenId);
        return tokenId;
    }
}