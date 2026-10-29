// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

abstract contract PublicAllocatorHandler {
    function publicAllocator_reallocateTo(uint256 marketIndex, uint256 assets) public {
        publicAllocator.reallocateTo(vault, withdrawals(assets), markets[marketIndex]);
    }

    function publicAllocator_reallocateTo_clamped(uint256 marketIndex, uint256 assets) public {
        publicAllocator_reallocateTo(marketIndex % markets.length, assets % 1e24);
    }
}
