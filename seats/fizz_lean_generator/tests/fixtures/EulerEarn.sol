// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract EulerEarn {
    uint256 public supplyCap;

    function acceptCap(uint256 newSupplyCap) external {
        supplyCap = newSupplyCap;
    }
}

contract EulerEarnFactory {
    constructor(address, address, address, address) {}

    function createEulerEarn(address, uint256, address, string memory, string memory, bytes32) external returns (address) {
        return address(new EulerEarn());
    }
}
