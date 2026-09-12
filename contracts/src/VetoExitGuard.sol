// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

interface IVaultV2Factory {
    function isVaultV2(address account) external view returns (bool);
}

interface IVaultV2 {
    function executableAt(bytes calldata data) external view returns (uint256);
    function abdicated(bytes4 selector) external view returns (bool);
    function managementFeeRecipient() external view returns (address);
    function redeem(uint256 shares, address receiver, address onBehalf) external returns (uint256 assets);
}

/// @notice Executes one owner-authorized Vault V2 redemption while a harmful management-fee proposal is pending.
/// @dev This contract has not been audited. A mandate grants no authority to change its receiver or proposal limits.
contract VetoExitGuard {
    bytes4 public constant SET_MANAGEMENT_FEE_SELECTOR = bytes4(keccak256("setManagementFee(uint256)"));
    uint256 public constant MAX_MANAGEMENT_FEE = 0.05e18 / uint256(365 days);

    struct Mandate {
        address owner;
        address vault;
        uint256 shares;
        uint256 maxFeePerSecond;
        uint256 minAssets;
        uint256 expiresAt;
        uint256 safetySeconds;
        bool active;
    }

    IVaultV2Factory public immutable factory;
    uint256 public nextMandateId;
    mapping(uint256 mandateId => Mandate) public mandates;
    mapping(address owner => mapping(address vault => uint256 encodedMandateId))
        public activeMandateByOwnerVault;

    bool private executing;

    error InvalidMandate();
    error InvalidVault();
    error NotMandateOwner();
    error MandateInactive();
    error UnsupportedProposal();
    error FeeDoesNotBreachLimit();
    error ProposalIsNotExecutable();
    error ProposalChanged();
    error ExitWindowClosed();
    error AssetsBelowMinimum();
    error ReentrantExecution();

    event MandateArmed(
        uint256 indexed mandateId,
        address indexed owner,
        address indexed vault,
        uint256 shares,
        uint256 maxFeePerSecond,
        uint256 minAssets,
        uint256 expiresAt,
        uint256 safetySeconds
    );
    event MandateCancelled(uint256 indexed mandateId, address indexed owner);
    event MandateReplaced(
        uint256 indexed previousMandateId,
        uint256 indexed newMandateId,
        address indexed owner,
        address vault
    );
    event Exited(
        uint256 indexed mandateId,
        address indexed owner,
        address indexed executor,
        uint256 shares,
        uint256 assets,
        bytes32 proposalHash
    );

    constructor(address factory_) {
        if (factory_.code.length == 0) revert InvalidVault();
        factory = IVaultV2Factory(factory_);
    }

    function arm(
        address vault,
        uint256 shares,
        uint256 maxFeePerSecond,
        uint256 minAssets,
        uint256 expiresAt,
        uint256 safetySeconds
    ) external returns (uint256 mandateId) {
        if (vault.code.length == 0 || !factory.isVaultV2(vault)) revert InvalidVault();
        if (
            shares == 0 || minAssets == 0 || expiresAt <= block.timestamp || safetySeconds == 0
                || safetySeconds >= expiresAt - block.timestamp
                || maxFeePerSecond >= MAX_MANAGEMENT_FEE
        ) revert InvalidMandate();

        mandateId = nextMandateId++;
        uint256 previousEncodedMandateId = activeMandateByOwnerVault[msg.sender][vault];
        if (previousEncodedMandateId != 0) {
            uint256 previousMandateId = previousEncodedMandateId - 1;
            mandates[previousMandateId].active = false;
            emit MandateReplaced(previousMandateId, mandateId, msg.sender, vault);
        }

        mandates[mandateId] = Mandate({
            owner: msg.sender,
            vault: vault,
            shares: shares,
            maxFeePerSecond: maxFeePerSecond,
            minAssets: minAssets,
            expiresAt: expiresAt,
            safetySeconds: safetySeconds,
            active: true
        });
        activeMandateByOwnerVault[msg.sender][vault] = mandateId + 1;
        emit MandateArmed(
            mandateId,
            msg.sender,
            vault,
            shares,
            maxFeePerSecond,
            minAssets,
            expiresAt,
            safetySeconds
        );
    }

    function cancel(uint256 mandateId) external {
        Mandate storage mandate = mandates[mandateId];
        if (msg.sender != mandate.owner) revert NotMandateOwner();
        if (!mandate.active) revert MandateInactive();
        mandate.active = false;
        if (activeMandateByOwnerVault[msg.sender][mandate.vault] == mandateId + 1) {
            activeMandateByOwnerVault[msg.sender][mandate.vault] = 0;
        }
        emit MandateCancelled(mandateId, msg.sender);
    }

    function execute(uint256 mandateId, bytes calldata proposal, uint256 expectedExecutableAt)
        external
        returns (uint256 assets)
    {
        if (executing) revert ReentrantExecution();
        executing = true;

        Mandate storage mandate = mandates[mandateId];
        if (!mandate.active || block.timestamp >= mandate.expiresAt) revert MandateInactive();
        if (
            activeMandateByOwnerVault[mandate.owner][mandate.vault] != mandateId + 1
                || mandate.vault.code.length == 0 || !factory.isVaultV2(mandate.vault)
        ) revert InvalidVault();
        if (proposal.length != 36 || bytes4(proposal) != SET_MANAGEMENT_FEE_SELECTOR) {
            revert UnsupportedProposal();
        }

        uint256 proposedFee = abi.decode(proposal[4:], (uint256));
        if (proposedFee <= mandate.maxFeePerSecond || proposedFee > MAX_MANAGEMENT_FEE) {
            revert FeeDoesNotBreachLimit();
        }

        IVaultV2 vault = IVaultV2(mandate.vault);
        if (vault.abdicated(SET_MANAGEMENT_FEE_SELECTOR) || vault.managementFeeRecipient() == address(0)) {
            revert ProposalIsNotExecutable();
        }

        uint256 executableAt = vault.executableAt(proposal);
        if (executableAt == 0) revert ProposalIsNotExecutable();
        if (executableAt != expectedExecutableAt) revert ProposalChanged();
        if (executableAt <= block.timestamp || executableAt - block.timestamp <= mandate.safetySeconds) {
            revert ExitWindowClosed();
        }

        mandate.active = false;
        activeMandateByOwnerVault[mandate.owner][mandate.vault] = 0;
        assets = vault.redeem(mandate.shares, mandate.owner, mandate.owner);
        if (assets < mandate.minAssets) revert AssetsBelowMinimum();

        executing = false;
        emit Exited(mandateId, mandate.owner, msg.sender, mandate.shares, assets, keccak256(proposal));
    }
}
