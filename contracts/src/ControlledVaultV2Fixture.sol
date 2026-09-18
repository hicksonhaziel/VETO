// SPDX-License-Identifier: UNLICENSED
pragma solidity 0.8.28;

/// @notice Test-only ERC-20 used by the controlled public-testnet fixture.
contract FixtureAsset {
    string public constant name = "VETO Fixture USD";
    string public constant symbol = "vfUSD";
    uint8 public constant decimals = 6;

    mapping(address account => uint256) public balanceOf;
    mapping(address owner => mapping(address spender => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(address owner, uint256 supply) {
        balanceOf[owner] = supply;
        emit Transfer(address(0), owner, supply);
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function transfer(address to, uint256 value) external returns (bool) {
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        emit Transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - value;
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
        return true;
    }
}

/// @notice Test-only subset of Vault V2 proposal and redemption behavior used for KeeperHub evidence.
contract ControlledVaultV2Fixture {
    bytes4 public constant SET_MANAGEMENT_FEE_SELECTOR = bytes4(keccak256("setManagementFee(uint256)"));
    bytes4 public constant SET_PERFORMANCE_FEE_SELECTOR = 0x70897b23;
    bytes4 public constant INCREASE_RELATIVE_CAP_SELECTOR = 0x2438525b;
    bytes4 public constant DECREASE_RELATIVE_CAP_SELECTOR = 0x57975270;
    bytes4 public constant ADD_ADAPTER_SELECTOR = 0x60d54d41;
    bytes4 public constant SET_SEND_SHARES_GATE_SELECTOR = 0xc21ad028;
    bytes4 public constant SET_RECEIVE_ASSETS_GATE_SELECTOR = 0x04dbf0ce;

    FixtureAsset public immutable asset;
    address public immutable curator;
    address public immutable managementFeeRecipient;
    address public immutable performanceFeeRecipient;
    uint256 public immutable managementFeeTimelock;
    uint256 public managementFee;
    uint256 public performanceFee;
    address public sendSharesGate;
    address public receiveAssetsGate;

    mapping(address account => uint256) public balanceOf;
    mapping(address owner => mapping(address spender => uint256)) public allowance;
    mapping(bytes32 proposalHash => uint256) private proposalExecutableAt;
    mapping(bytes32 id => uint256) public relativeCap;
    mapping(address adapter => bool) public isAdapter;
    mapping(bytes4 selector => bool) public isAbdicated;

    event Submit(bytes4 indexed selector, bytes data, uint256 executableAt);
    event Revoke(address indexed sender, bytes4 indexed selector, bytes data);
    event Accept(bytes4 indexed selector, bytes data);
    event Deposit(address indexed sender, address indexed onBehalf, uint256 assets, uint256 shares);
    event Withdraw(
        address indexed sender,
        address indexed receiver,
        address indexed onBehalf,
        uint256 assets,
        uint256 shares
    );
    event Approval(address indexed owner, address indexed spender, uint256 shares);

    constructor(address owner, address asset_, uint256 timelock_) {
        curator = owner;
        managementFeeRecipient = owner;
        performanceFeeRecipient = owner;
        asset = FixtureAsset(asset_);
        managementFeeTimelock = timelock_;
    }

    function abdicate(bytes4 selector) external {
        require(msg.sender == curator, "not curator");
        isAbdicated[selector] = true;
    }

    function abdicated(bytes4 selector) external view returns (bool) {
        return isAbdicated[selector];
    }

    function executableAt(bytes calldata data) external view returns (uint256) {
        return proposalExecutableAt[keccak256(data)];
    }

    function submit(bytes calldata data) external {
        require(msg.sender == curator, "not curator");
        bytes4 selector = bytes4(data);
        bool supported = (selector == SET_MANAGEMENT_FEE_SELECTOR && data.length == 36)
            || (selector == SET_PERFORMANCE_FEE_SELECTOR && data.length == 36)
            || (selector == INCREASE_RELATIVE_CAP_SELECTOR && data.length >= 100)
            || (selector == ADD_ADAPTER_SELECTOR && data.length == 36)
            || (selector == SET_SEND_SHARES_GATE_SELECTOR && data.length == 36)
            || (selector == SET_RECEIVE_ASSETS_GATE_SELECTOR && data.length == 36);
        require(supported, "unsupported");
        bytes32 proposalHash = keccak256(data);
        require(proposalExecutableAt[proposalHash] == 0, "already pending");
        uint256 when = block.timestamp + managementFeeTimelock;
        proposalExecutableAt[proposalHash] = when;
        emit Submit(selector, data, when);
    }

    function revoke(bytes calldata data) external {
        require(msg.sender == curator, "not curator");
        bytes32 proposalHash = keccak256(data);
        require(proposalExecutableAt[proposalHash] != 0, "not pending");
        proposalExecutableAt[proposalHash] = 0;
        emit Revoke(msg.sender, bytes4(data), data);
    }

    function setManagementFee(uint256 newManagementFee) external {
        bytes memory data = abi.encodeCall(this.setManagementFee, (newManagementFee));
        bytes32 proposalHash = keccak256(data);
        uint256 when = proposalExecutableAt[proposalHash];
        require(when != 0 && block.timestamp >= when, "not executable");
        proposalExecutableAt[proposalHash] = 0;
        managementFee = newManagementFee;
        emit Accept(SET_MANAGEMENT_FEE_SELECTOR, data);
    }

    function setPerformanceFee(uint256 newPerformanceFee) external {
        bytes memory data = abi.encodeCall(this.setPerformanceFee, (newPerformanceFee));
        bytes32 proposalHash = keccak256(data);
        uint256 when = proposalExecutableAt[proposalHash];
        require(when != 0 && block.timestamp >= when, "not executable");
        proposalExecutableAt[proposalHash] = 0;
        performanceFee = newPerformanceFee;
        emit Accept(SET_PERFORMANCE_FEE_SELECTOR, data);
    }

    function increaseRelativeCap(bytes memory idData, uint256 newRelativeCap) external {
        bytes memory data = abi.encodeCall(this.increaseRelativeCap, (idData, newRelativeCap));
        bytes32 proposalHash = keccak256(data);
        uint256 when = proposalExecutableAt[proposalHash];
        require(when != 0 && block.timestamp >= when, "not executable");
        proposalExecutableAt[proposalHash] = 0;
        bytes32 id = keccak256(idData);
        relativeCap[id] = newRelativeCap;
        emit Accept(INCREASE_RELATIVE_CAP_SELECTOR, data);
    }

    function decreaseRelativeCap(bytes memory idData, uint256 newRelativeCap) external {
        require(msg.sender == curator, "not curator");
        bytes32 id = keccak256(idData);
        relativeCap[id] = newRelativeCap;
        emit Accept(
            DECREASE_RELATIVE_CAP_SELECTOR,
            abi.encodeCall(this.decreaseRelativeCap, (idData, newRelativeCap))
        );
    }

    function addAdapter(address newAdapter) external {
        bytes memory data = abi.encodeCall(this.addAdapter, (newAdapter));
        bytes32 proposalHash = keccak256(data);
        uint256 when = proposalExecutableAt[proposalHash];
        require(when != 0 && block.timestamp >= when, "not executable");
        proposalExecutableAt[proposalHash] = 0;
        isAdapter[newAdapter] = true;
        emit Accept(ADD_ADAPTER_SELECTOR, data);
    }

    function setSendSharesGate(address newGate) external {
        bytes memory data = abi.encodeCall(this.setSendSharesGate, (newGate));
        bytes32 proposalHash = keccak256(data);
        uint256 when = proposalExecutableAt[proposalHash];
        require(when != 0 && block.timestamp >= when, "not executable");
        proposalExecutableAt[proposalHash] = 0;
        sendSharesGate = newGate;
        emit Accept(SET_SEND_SHARES_GATE_SELECTOR, data);
    }

    function setReceiveAssetsGate(address newGate) external {
        bytes memory data = abi.encodeCall(this.setReceiveAssetsGate, (newGate));
        bytes32 proposalHash = keccak256(data);
        uint256 when = proposalExecutableAt[proposalHash];
        require(when != 0 && block.timestamp >= when, "not executable");
        proposalExecutableAt[proposalHash] = 0;
        receiveAssetsGate = newGate;
        emit Accept(SET_RECEIVE_ASSETS_GATE_SELECTOR, data);
    }

    function approve(address spender, uint256 shares) external returns (bool) {
        allowance[msg.sender][spender] = shares;
        emit Approval(msg.sender, spender, shares);
        return true;
    }

    function deposit(uint256 assets, address onBehalf) external returns (uint256 shares) {
        shares = assets;
        require(asset.transferFrom(msg.sender, address(this), assets), "transfer failed");
        balanceOf[onBehalf] += shares;
        emit Deposit(msg.sender, onBehalf, assets, shares);
    }

    function previewRedeem(uint256 shares) external pure returns (uint256 assets) {
        return shares;
    }

    function redeem(uint256 shares, address receiver, address onBehalf) external returns (uint256 assets) {
        if (msg.sender != onBehalf) {
            uint256 allowed = allowance[onBehalf][msg.sender];
            if (allowed != type(uint256).max) allowance[onBehalf][msg.sender] = allowed - shares;
        }
        balanceOf[onBehalf] -= shares;
        assets = shares;
        require(asset.transfer(receiver, assets), "transfer failed");
        emit Withdraw(msg.sender, receiver, onBehalf, assets, shares);
    }
}

/// @notice Test-only factory whose registry shape matches the factory check used by VetoExitGuard.
contract ControlledVaultV2Factory {
    mapping(address account => bool) public isVaultV2;
    address public latestAsset;
    address public latestVault;

    event FixtureCreated(address indexed owner, address indexed asset, address indexed vault);

    function create(uint256 initialAssets, uint256 timelock) external returns (address asset, address vault) {
        require(initialAssets > 0 && timelock > 0, "bad fixture");
        asset = address(new FixtureAsset(msg.sender, initialAssets));
        vault = address(new ControlledVaultV2Fixture(msg.sender, asset, timelock));
        isVaultV2[vault] = true;
        latestAsset = asset;
        latestVault = vault;
        emit FixtureCreated(msg.sender, asset, vault);
    }
}
