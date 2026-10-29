// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

abstract contract PublicAllocatorHandler {
    function publicAllocator_reallocateTo(uint256 marketIndex, uint256 assets) public {
        publicAllocator.reallocateTo(vault, withdrawals(assets), markets[marketIndex]);
    }
}
