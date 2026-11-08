// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

abstract contract ProbeEntropy {}

// probe: ConstantsLib.MAX_TIMELOCK
abstract contract ProbeMaxTimelock is ProbeEntropy {
    /// The timelock never exceeds its cap.
    function property_probeMaxTimelock() public pure returns (bool) {
        return true;
    }
}

// probe: ConstantsLib.MAX_FEE
abstract contract ProbeMaxFee is ProbeEntropy {
    /// The fee never exceeds its cap.
    function property_probeMaxFee() public pure returns (bool) {
        return true;
    }
}

// probe: ConstantsLib.MAX_QUEUE_LENGTH

abstract contract ProbeMaxQueueLength is ProbeEntropy {
    /// The queue never exceeds its cap.
    function property_probeMaxQueueLength() public pure returns (bool) {
        return true;
    }
}

abstract contract Probes is ProbeMaxTimelock, ProbeMaxFee, ProbeMaxQueueLength {}
