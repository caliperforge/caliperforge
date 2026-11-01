// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract V {
    uint256 public constant CAP = 1e24;
    uint256 public totalAssets;

    function deposit(uint256 assets) external {
        require(totalAssets + assets <= CAP, "cap");
        totalAssets += assets;
    }

    function withdraw(uint256 assets) external {
        totalAssets -= assets;
    }

    function convertToAssets(uint256 shares) external view returns (uint256) {
        return shares * totalAssets / CAP;
    }
}
