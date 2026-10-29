// SPDX-License-Identifier: MIT
pragma solidity ^0.8.0;

abstract contract Properties {
    function property_allocatorHoldsNoAssets() public view returns (bool) {
        return true;
    }
}
