// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {EulerEarn, EulerEarnFactory} from "../../src/EulerEarn.sol";

contract Base {
    address admin;
    address evc;
    address perspective;
    address asset;
    EulerEarnFactory factory;
    EulerEarn vault;

    function setup() public {
        factory = new EulerEarnFactory(admin, evc, perspective, asset);
        vault = EulerEarn(address(factory.createEulerEarn(admin, 0, address(asset), "Euler Earn Asset", "eeAST", bytes32(0))));
    }

    function eulerEarn_acceptCap(uint256 id) public {
        _eulerEarn_acceptCap(id);
    }

    function eulerEarn_acceptCap_clamped(uint256 id) public {
        eulerEarn_acceptCap(id % 4);
    }

    function _eulerEarn_acceptCap(uint256 id) internal {
        vault.acceptCap(id);
    }
}
