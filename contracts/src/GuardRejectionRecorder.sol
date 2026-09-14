// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

/// @notice Records an expected downstream guard rejection without swallowing an unexpected result.
/// @dev Testnet evidence helper only. It has no custody or administrative functions.
contract GuardRejectionRecorder {
    error GuardUnexpectedlyAccepted();
    error UnexpectedRevert(bytes4 actual, bytes4 expected);

    event GuardRejected(
        address indexed guard, bytes4 indexed revertSelector, bytes32 indexed callHash
    );

    function executeAndRecord(address guard, bytes calldata callData, bytes4 expectedRevertSelector)
        external
        returns (bytes4 revertSelector)
    {
        (bool success, bytes memory result) = guard.call(callData);
        if (success) revert GuardUnexpectedlyAccepted();
        if (result.length >= 4) {
            assembly ("memory-safe") {
                revertSelector := mload(add(result, 0x20))
            }
        }
        if (revertSelector != expectedRevertSelector) {
            revert UnexpectedRevert(revertSelector, expectedRevertSelector);
        }
        emit GuardRejected(guard, revertSelector, keccak256(callData));
    }
}
