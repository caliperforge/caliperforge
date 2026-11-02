// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {V} from "../../src/V.sol";

contract ProbeCap {
    // probe: V.CAP
    uint256 maxTotal;

    function seen(uint256 total) external {
        if (total > maxTotal) maxTotal = total;
    }
}

contract ProbeConvert {
    // probe: V.convertToAssets
    uint256 constant WEI = 1;
    uint256 maxAssets;
    uint256 minAssets = type(uint256).max;
    bool saw1Wei;

    function seen(uint256 shares, uint256 assets) external {
        if (assets > maxAssets) maxAssets = assets;
        if (assets < minAssets) minAssets = assets;
        if (shares == WEI) saw1Wei = true;
    }
}

contract ProbeCalls {
    // probe: V.convertToAssets
    V v;
    uint256 lastAssets;

    function seen(uint256 shares) external {
        lastAssets = v.convertToAssets(shares);
    }
}
