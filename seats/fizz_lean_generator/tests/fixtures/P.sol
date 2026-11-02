// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IP {
    function reallocate(uint256 k) external;
}

contract P {
    struct Cfg {
        uint256 cap;
        uint256 balance;
    }

    mapping(uint256 => Cfg) public cfg;
    uint256 public moves;

    function accept(uint256 k, uint256 v) external {
        _set(k, v);
    }

    function _set(uint256 k, uint256 v) internal {
        Cfg storage c = cfg[k];
        c.cap = v;
    }

    function reallocate(uint256 k) external {
        cfg[k].balance += 1;
        moves += 1;
    }
}

contract A {
    function reallocateTo(address p, uint256 k) external {
        IP(p).reallocate(k);
    }

    function peek(address p) external view returns (uint256) {
        return P(p).moves();
    }
}
