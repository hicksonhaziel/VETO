// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.28;

interface IVaultV2Factory {
    function isVaultV2(address account) external view returns (bool);
}

interface IVaultV2 {
    function executableAt(bytes calldata data) external view returns (uint256);
    function abdicated(bytes4 selector) external view returns (bool);
    function managementFeeRecipient() external view returns (address);
    function performanceFeeRecipient() external view returns (address);
    function redeem(uint256 shares, address receiver, address onBehalf) external returns (uint256 assets);
}

/// @notice Executes one owner-authorized Vault V2 redemption under a multi-policy mandate.
/// @dev Historical V1 (VetoExitGuard.sol) is preserved for past evidence. V2 provides multi-policy protection.
contract VetoExitGuardV2 {
    uint256 public constant POLICY_MANAGEMENT_FEE = 1 << 0;
    uint256 public constant POLICY_PERFORMANCE_FEE = 1 << 1;
    uint256 public constant POLICY_RELATIVE_CAP = 1 << 2;
    uint256 public constant POLICY_ADAPTER_ALLOWLIST = 1 << 3;
    uint256 public constant POLICY_REDEMPTION_GATE_ALLOWLIST = 1 << 4;

    bytes4 public constant SET_MANAGEMENT_FEE_SELECTOR = 0xfe56e232;
    bytes4 public constant SET_PERFORMANCE_FEE_SELECTOR = 0x70897b23;
    bytes4 public constant INCREASE_RELATIVE_CAP_SELECTOR = 0x2438525b;
    bytes4 public constant ADD_ADAPTER_SELECTOR = 0x60d54d41;
    bytes4 public constant SET_SEND_SHARES_GATE_SELECTOR = 0xc21ad028;
    bytes4 public constant SET_RECEIVE_ASSETS_GATE_SELECTOR = 0x04dbf0ce;

    uint256 public constant MAX_MANAGEMENT_FEE = 0.05e18 / uint256(365 days);
    uint256 public constant MAX_PERFORMANCE_FEE = 0.5e18; // 50% WAD
    uint256 public constant WAD = 1e18;

    struct Mandate {
        address owner;
        address vault;
        uint256 shares;
        uint256 minAssets;
        uint256 expiresAt;
        uint256 safetySeconds;
        bool active;
        uint256 policyFlags;
        uint256 maxManagementFee;
        uint256 maxPerformanceFee;
    }

    struct RelativeCapLimit {
        bytes32 riskId;
        uint256 maxRelativeCap;
    }

    struct PolicyConfig {
        uint256 policyFlags;
        uint256 maxManagementFee;
        uint256 maxPerformanceFee;
        RelativeCapLimit[] relativeCaps;
        address[] approvedAdapters;
        address[] approvedSendSharesGates;
        address[] approvedReceiveAssetsGates;
    }

    IVaultV2Factory public immutable factory;
    uint256 public nextMandateId;
    mapping(uint256 mandateId => Mandate) public mandates;
    mapping(address owner => mapping(address vault => uint256 encodedMandateId))
        public activeMandateByOwnerVault;

    mapping(uint256 mandateId => mapping(bytes32 riskId => uint256)) public maxRelativeCapByMandateRisk;
    mapping(uint256 mandateId => mapping(bytes32 riskId => bool)) public hasRelativeCapByMandateRisk;
    mapping(uint256 mandateId => mapping(address adapter => bool)) public approvedAdapterByMandate;
    mapping(uint256 mandateId => mapping(address gate => bool)) public approvedSendSharesGateByMandate;
    mapping(uint256 mandateId => mapping(address gate => bool)) public approvedReceiveAssetsGateByMandate;

    bool private executing;

    error InvalidMandate();
    error InvalidVault();
    error NotMandateOwner();
    error MandateInactive();
    error UnsupportedProposal();
    error PolicyDisabled();
    error FeeDoesNotBreachLimit();
    error CapDoesNotBreachLimit();
    error AdapterIsApproved();
    error GateIsApproved();
    error ProposalIsNotExecutable();
    error ProposalChanged();
    error ExitWindowClosed();
    error AssetsBelowMinimum();
    error ReentrantExecution();

    event PolicyMandateArmed(
        uint256 indexed mandateId,
        address indexed owner,
        address indexed vault,
        uint256 shares,
        uint256 minAssets,
        uint256 expiresAt,
        uint256 safetySeconds,
        uint256 policyFlags
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

    function armPolicyMandate(
        address vault,
        uint256 shares,
        uint256 minAssets,
        uint256 expiresAt,
        uint256 safetySeconds,
        PolicyConfig calldata config
    ) external returns (uint256 mandateId) {
        if (vault.code.length == 0 || !factory.isVaultV2(vault)) revert InvalidVault();
        if (
            shares == 0 || minAssets == 0 || expiresAt <= block.timestamp || safetySeconds == 0
                || safetySeconds >= expiresAt - block.timestamp || config.policyFlags == 0
                || (config.policyFlags & ~uint256(31)) != 0
        ) revert InvalidMandate();

        if ((config.policyFlags & POLICY_MANAGEMENT_FEE) != 0) {
            if (config.maxManagementFee >= MAX_MANAGEMENT_FEE) revert InvalidMandate();
        }
        if ((config.policyFlags & POLICY_PERFORMANCE_FEE) != 0) {
            if (config.maxPerformanceFee >= MAX_PERFORMANCE_FEE) revert InvalidMandate();
        }
        if ((config.policyFlags & POLICY_RELATIVE_CAP) != 0) {
            if (config.relativeCaps.length == 0) revert InvalidMandate();
            for (uint256 i = 0; i < config.relativeCaps.length; i++) {
                if (config.relativeCaps[i].maxRelativeCap > WAD) revert InvalidMandate();
            }
        }

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
            minAssets: minAssets,
            expiresAt: expiresAt,
            safetySeconds: safetySeconds,
            active: true,
            policyFlags: config.policyFlags,
            maxManagementFee: config.maxManagementFee,
            maxPerformanceFee: config.maxPerformanceFee
        });

        if ((config.policyFlags & POLICY_RELATIVE_CAP) != 0) {
            for (uint256 i = 0; i < config.relativeCaps.length; i++) {
                bytes32 rId = config.relativeCaps[i].riskId;
                maxRelativeCapByMandateRisk[mandateId][rId] = config.relativeCaps[i].maxRelativeCap;
                hasRelativeCapByMandateRisk[mandateId][rId] = true;
            }
        }
        if ((config.policyFlags & POLICY_ADAPTER_ALLOWLIST) != 0) {
            for (uint256 i = 0; i < config.approvedAdapters.length; i++) {
                if (config.approvedAdapters[i] == address(0)) revert InvalidMandate();
                approvedAdapterByMandate[mandateId][config.approvedAdapters[i]] = true;
            }
        }
        if ((config.policyFlags & POLICY_REDEMPTION_GATE_ALLOWLIST) != 0) {
            for (uint256 i = 0; i < config.approvedSendSharesGates.length; i++) {
                if (config.approvedSendSharesGates[i] == address(0)) revert InvalidMandate();
                approvedSendSharesGateByMandate[mandateId][config.approvedSendSharesGates[i]] = true;
            }
            for (uint256 i = 0; i < config.approvedReceiveAssetsGates.length; i++) {
                if (config.approvedReceiveAssetsGates[i] == address(0)) revert InvalidMandate();
                approvedReceiveAssetsGateByMandate[mandateId][config.approvedReceiveAssetsGates[i]] = true;
            }
        }

        activeMandateByOwnerVault[msg.sender][vault] = mandateId + 1;
        emit PolicyMandateArmed(
            mandateId,
            msg.sender,
            vault,
            shares,
            minAssets,
            expiresAt,
            safetySeconds,
            config.policyFlags
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

        if (proposal.length < 4) revert UnsupportedProposal();
        bytes4 selector = bytes4(proposal);
        IVaultV2 vault = IVaultV2(mandate.vault);

        if (selector == SET_MANAGEMENT_FEE_SELECTOR) {
            if ((mandate.policyFlags & POLICY_MANAGEMENT_FEE) == 0) revert PolicyDisabled();
            if (proposal.length != 36) revert UnsupportedProposal();
            uint256 proposedFee = abi.decode(proposal[4:], (uint256));
            if (proposedFee <= mandate.maxManagementFee || proposedFee > MAX_MANAGEMENT_FEE) {
                revert FeeDoesNotBreachLimit();
            }
            if (vault.abdicated(SET_MANAGEMENT_FEE_SELECTOR) || vault.managementFeeRecipient() == address(0)) {
                revert ProposalIsNotExecutable();
            }
        } else if (selector == SET_PERFORMANCE_FEE_SELECTOR) {
            if ((mandate.policyFlags & POLICY_PERFORMANCE_FEE) == 0) revert PolicyDisabled();
            if (proposal.length != 36) revert UnsupportedProposal();
            uint256 proposedFee = abi.decode(proposal[4:], (uint256));
            if (proposedFee <= mandate.maxPerformanceFee || proposedFee > MAX_PERFORMANCE_FEE) {
                revert FeeDoesNotBreachLimit();
            }
            if (vault.abdicated(SET_PERFORMANCE_FEE_SELECTOR) || vault.performanceFeeRecipient() == address(0)) {
                revert ProposalIsNotExecutable();
            }
        } else if (selector == INCREASE_RELATIVE_CAP_SELECTOR) {
            if ((mandate.policyFlags & POLICY_RELATIVE_CAP) == 0) revert PolicyDisabled();
            if (proposal.length < 100) revert UnsupportedProposal();
            uint256 idOffset = uint256(bytes32(proposal[4:36]));
            if (idOffset != 64) revert UnsupportedProposal();
            uint256 idLen = uint256(bytes32(proposal[68:100]));
            if (proposal.length != 100 + ((idLen + 31) / 32) * 32) revert UnsupportedProposal();
            (bytes memory idData, uint256 newRelativeCap) = abi.decode(proposal[4:], (bytes, uint256));
            bytes32 riskId = keccak256(idData);
            if (!hasRelativeCapByMandateRisk[mandateId][riskId]) revert CapDoesNotBreachLimit();
            if (newRelativeCap <= maxRelativeCapByMandateRisk[mandateId][riskId] || newRelativeCap > WAD) {
                revert CapDoesNotBreachLimit();
            }
            if (vault.abdicated(INCREASE_RELATIVE_CAP_SELECTOR)) {
                revert ProposalIsNotExecutable();
            }
        } else if (selector == ADD_ADAPTER_SELECTOR) {
            if ((mandate.policyFlags & POLICY_ADAPTER_ALLOWLIST) == 0) revert PolicyDisabled();
            if (proposal.length != 36) revert UnsupportedProposal();
            address proposedAdapter = abi.decode(proposal[4:], (address));
            if (proposedAdapter == address(0)) revert UnsupportedProposal();
            if (approvedAdapterByMandate[mandateId][proposedAdapter]) {
                revert AdapterIsApproved();
            }
            if (vault.abdicated(ADD_ADAPTER_SELECTOR)) {
                revert ProposalIsNotExecutable();
            }
        } else if (selector == SET_SEND_SHARES_GATE_SELECTOR) {
            if ((mandate.policyFlags & POLICY_REDEMPTION_GATE_ALLOWLIST) == 0) revert PolicyDisabled();
            if (proposal.length != 36) revert UnsupportedProposal();
            address proposedGate = abi.decode(proposal[4:], (address));
            if (proposedGate == address(0) || approvedSendSharesGateByMandate[mandateId][proposedGate]) {
                revert GateIsApproved();
            }
            if (vault.abdicated(SET_SEND_SHARES_GATE_SELECTOR)) {
                revert ProposalIsNotExecutable();
            }
        } else if (selector == SET_RECEIVE_ASSETS_GATE_SELECTOR) {
            if ((mandate.policyFlags & POLICY_REDEMPTION_GATE_ALLOWLIST) == 0) revert PolicyDisabled();
            if (proposal.length != 36) revert UnsupportedProposal();
            address proposedGate = abi.decode(proposal[4:], (address));
            if (proposedGate == address(0) || approvedReceiveAssetsGateByMandate[mandateId][proposedGate]) {
                revert GateIsApproved();
            }
            if (vault.abdicated(SET_RECEIVE_ASSETS_GATE_SELECTOR)) {
                revert ProposalIsNotExecutable();
            }
        } else {
            revert UnsupportedProposal();
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
