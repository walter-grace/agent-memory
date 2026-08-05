// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title Agent Infinite Memory — an agent's memory as an asset it owns, on Robinhood Chain.
///
/// Each agent is an ERC-721 token. Its memory is an append-only chain of checkpoints: compressed
/// (optionally encrypted) context blobs carried in EVENT DATA, never contract storage — on RH's
/// near-zero gas that makes multi-KB checkpoints cost fractions of a cent. Storage holds only a
/// tiny head record per agent: the running keccak hash chain (tamper-evidence), the checkpoint
/// count, and the block number of the last checkpoint.
///
/// The lastBlock pointer is what makes resume cheap: every Checkpoint event embeds the block of
/// the PREVIOUS checkpoint, so a fresh agent instance walks its history backwards with one
/// single-block eth_getLogs per checkpoint — O(history) narrow queries, never a full chain scan.
///
/// Poisoned-memory story: history is immutable (you can never silently rewrite the past — the
/// hash chain proves it), but `rebase` lets the owner START A NEW CHAIN HEAD, superseding old
/// memories without deleting them. An agent resuming reads the current head; auditors can still
/// walk every superseded chain.
interface ArbSys {
    function arbBlockNumber() external view returns (uint256);
}

contract AgentMemory {
    string public constant name = "Agent Infinite Memory";
    string public constant symbol = "AIM";

    // On Arbitrum/Orbit chains `block.number` returns an ESTIMATE OF THE PARENT CHAIN's block —
    // storing it as the resume pointer sent the walker to RH block numbers that don't exist yet
    // (seen live: pointer 25.65M vs real RH head 23.7M). ArbSys(100).arbBlockNumber() is the true
    // L2 block this transaction lands in.
    function _l2Block() internal view returns (uint64) {
        return uint64(ArbSys(address(100)).arbBlockNumber());
    }

    // ---- minimal ERC-721 ----
    uint256 public nextId = 1;
    mapping(uint256 => address) public ownerOf;
    mapping(address => uint256) public balanceOf;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;

    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);
    event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId);
    event ApprovalForAll(address indexed owner, address indexed operator, bool approved);

    // ---- memory ----
    struct Head {
        bytes32 hash;      // keccak256 chain over every checkpoint since the last rebase
        uint64 count;      // checkpoints in the current chain
        uint64 lastBlock;  // block of the most recent checkpoint (0 = none) — the resume pointer
        uint64 era;        // bumped by rebase(); events carry it so walkers stay on one chain
    }
    mapping(uint256 => Head) public headOf;
    mapping(uint256 => string) public labelOf; // human name, set at mint

    // Event data is cheap on RH but not free, and an unbounded blob is a griefing / spam vector
    // against anyone indexing this contract (RPCs, block explorers, the SDK's own getLogs walk).
    // 24KB comfortably covers a compacted-JSON checkpoint after gzip; callers that need more should
    // chunk across multiple checkpoints rather than push one oversized blob on-chain.
    uint256 public constant MAX_CHECKPOINT_BYTES = 24_000;

    event AgentMinted(uint256 indexed agentId, address indexed owner, string label);
    event Checkpoint(
        uint256 indexed agentId,
        uint64 indexed era,
        uint64 seq,        // 0-based position in this era's chain
        uint64 prevBlock,  // block of the previous checkpoint (0 = start of era) — walk this
        bytes32 prevHash,  // head hash before this checkpoint
        bytes32 newHash,   // keccak256(prevHash, data) — the new head
        bytes data         // the memory blob: gzip(JSON), optionally AES-GCM inside
    );
    event Rebased(uint256 indexed agentId, uint64 indexed newEra, bytes32 finalHashOfOldEra);

    function _authorized(uint256 agentId) internal view returns (bool) {
        address o = ownerOf[agentId];
        return msg.sender == o || msg.sender == getApproved[agentId] || isApprovedForAll[o][msg.sender];
    }

    function mint(string calldata label) external returns (uint256 agentId) {
        agentId = nextId++;
        ownerOf[agentId] = msg.sender;
        unchecked { balanceOf[msg.sender]++; }
        labelOf[agentId] = label;
        emit Transfer(address(0), msg.sender, agentId);
        emit AgentMinted(agentId, msg.sender, label);
    }

    /// Append a memory checkpoint. Only the agent's owner (or an approved operator — e.g. the
    /// agent's own session key) may write. The blob lives in the event; storage only advances
    /// the 3-word head.
    function checkpoint(uint256 agentId, bytes calldata data) external {
        require(ownerOf[agentId] != address(0), "no agent");
        require(_authorized(agentId), "not authorized");
        require(data.length <= MAX_CHECKPOINT_BYTES, "too large");
        Head storage h = headOf[agentId];
        bytes32 newHash = keccak256(abi.encodePacked(h.hash, data));
        emit Checkpoint(agentId, h.era, h.count, h.lastBlock, h.hash, newHash, data);
        h.hash = newHash;
        unchecked { h.count++; }
        h.lastBlock = _l2Block();
    }

    /// Supersede the current memory chain: future resumes start empty at a new era, while every
    /// old checkpoint stays on-chain and auditable. This is how a poisoned memory is handled —
    /// override, never delete.
    ///
    /// Owner-only, deliberately NOT `_authorized()`: rebase blanks the head that every future
    /// resume reads, which is effectively an erase-by-omission of the whole current chain. An
    /// approved operator or session key is meant for routine writes (checkpoint), not for the one
    /// action that can make an agent's memory vanish out from under its owner. Only the wallet
    /// that holds the NFT can start a new era.
    function rebase(uint256 agentId) external {
        require(msg.sender == ownerOf[agentId], "not owner");
        Head storage h = headOf[agentId];
        emit Rebased(agentId, h.era + 1, h.hash);
        h.era += 1;
        h.hash = bytes32(0);
        h.count = 0;
        h.lastBlock = 0;
    }

    // ---- ERC-721 transfer machinery (memory — the Head — travels with the token) ----
    function approve(address to, uint256 tokenId) external {
        address o = ownerOf[tokenId];
        require(msg.sender == o || isApprovedForAll[o][msg.sender], "not authorized");
        getApproved[tokenId] = to;
        emit Approval(o, to, tokenId);
    }

    function setApprovalForAll(address operator, bool approved) external {
        isApprovedForAll[msg.sender][operator] = approved;
        emit ApprovalForAll(msg.sender, operator, approved);
    }

    function transferFrom(address from, address to, uint256 tokenId) public {
        require(ownerOf[tokenId] == from, "wrong from");
        require(to != address(0), "zero to");
        require(msg.sender == from || msg.sender == getApproved[tokenId] || isApprovedForAll[from][msg.sender], "not authorized");
        delete getApproved[tokenId];
        unchecked { balanceOf[from]--; balanceOf[to]++; }
        ownerOf[tokenId] = to;
        emit Transfer(from, to, tokenId);
    }

    function safeTransferFrom(address from, address to, uint256 tokenId) external {
        transferFrom(from, to, tokenId);
        require(to.code.length == 0 || IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, "") == IERC721Receiver.onERC721Received.selector, "unsafe receiver");
    }

    function safeTransferFrom(address from, address to, uint256 tokenId, bytes calldata data_) external {
        transferFrom(from, to, tokenId);
        require(to.code.length == 0 || IERC721Receiver(to).onERC721Received(msg.sender, from, tokenId, data_) == IERC721Receiver.onERC721Received.selector, "unsafe receiver");
    }

    function supportsInterface(bytes4 id) external pure returns (bool) {
        return id == 0x80ac58cd /* ERC721 */ || id == 0x01ffc9a7 /* ERC165 */;
    }

    function tokenURI(uint256 tokenId) external view returns (string memory) {
        require(ownerOf[tokenId] != address(0), "no agent");
        Head memory h = headOf[tokenId];
        return string(abi.encodePacked(
            "data:application/json,%7B%22name%22:%22", labelOf[tokenId],
            "%22,%22description%22:%22Agent Infinite Memory: ", _u(h.count),
            " checkpoints on Robinhood Chain, era ", _u(h.era), "%22%7D"
        ));
    }

    function _u(uint64 v) internal pure returns (string memory) {
        if (v == 0) return "0";
        bytes memory b = new bytes(20);
        uint256 i = 20;
        while (v > 0) { b[--i] = bytes1(uint8(48 + v % 10)); v /= 10; }
        bytes memory out = new bytes(20 - i);
        for (uint256 j = 0; j < out.length; j++) out[j] = b[i + j];
        return string(out);
    }
}

interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data) external returns (bytes4);
}
