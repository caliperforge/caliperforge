// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {V} from "../../src/V.sol";

contract MockOracle {
    // stand-in limits:
    // - price within 1e6 of start | map: Oracle
    // - deposits under 1e24 | map: V.CAP

    constructor(uint256 p) {}

    function grantRole(bytes32, address) external {}
}

contract Harness {
    V v;
    MockOracle oracle;
    address alice = address(0x10000);
    uint256 ghostDeposits;

    function setup() public {
        v = new V();
        oracle = new MockOracle(1e18);
        oracle.grantRole(keccak256("FEEDER"), alice);
    }

    function bound(uint256 x, uint256 lo, uint256 hi) internal pure returns (uint256) {
        return x < lo ? lo : x > hi ? hi : x;
    }

    function v_deposit(uint256 assets) public {
        v.deposit(assets);
        ghostDeposits += assets;
    }

    function v_deposit_clamped(uint256 assets) public {
        v_deposit(bound(assets, 0, 1e24));
    }

    function v_withdraw(uint256 assets) public {
        v.withdraw(assets);
    }
}
