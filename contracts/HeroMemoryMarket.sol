// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title HeroMemoryMarket — a trust-minimized marketplace for wallet-owned agent memory.
///
/// What is being sold is not just the AgentMemory NFT (write authority + provenance) but READABLE
/// history: the memory is AES-encrypted under a key derived from the SELLER's wallet signature, so a
/// bare NFT transfer leaves the buyer owning a token whose past is sealed shut. A real sale must
/// re-wrap the memory key to the BUYER's public key (ECIES, the same primitive as group rooms). That
/// re-wrap is a `salekey::` public entry the seller posts on the agent right before settlement.
///
/// FAIR EXCHANGE IS THE HARD PART. Exchanging a secret (the key) for money with no trusted third
/// party and no zero-knowledge proof is provably impossible — you can't let the buyer read the key
/// before they pay (they'd read-then-refuse), and you can't make the seller reveal it after payment
/// with no recourse (they'd take-the-money-and-post-garbage). This contract splits the problem:
///
///   * NFT <-> payment is FULLY TRUSTLESS: funds are escrowed here, the token moves seller->buyer
///     atomically with payment release, and the listing PINS the exact head hash the buyer inspected
///     so a seller cannot front-run a poisoned checkpoint between listing and sale.
///   * KEY correctness uses a seller BOND + a dispute window with an arbiter. The arbiter role is
///     narrow and OBJECTIVE, not a matter of taste: on dispute the buyer reveals their key to the
///     arbiter, who deterministically checks whether the seller's on-chain `salekey::` wrap actually
///     decrypts the agent's checkpoints to valid data. A cheating seller loses the bond to the buyer;
///     a false dispute is found groundless and the seller is paid. A stalled arbiter cannot trap
///     funds forever — after `disputeTimeout` the seller can claim, so griefing-by-dispute is bounded.
///
/// APPROVAL SCOPE (heeds the AgentMemory audit finding that any approval == full control): this
/// contract ONLY ever calls `mem.transferFrom(seller, buyer, agentId)` for a paid listing. It never
/// calls `rebase` and never transfers to any address but the paying buyer. Sellers should grant a
/// PER-TOKEN `approve(market, agentId)`, never `setApprovalForAll`, so the blast radius is one token.
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}

interface IAgentMemory {
    function ownerOf(uint256 id) external view returns (address);
    function getApproved(uint256 id) external view returns (address);
    function isApprovedForAll(address owner, address operator) external view returns (bool);
    function transferFrom(address from, address to, uint256 id) external;
    // Head layout mirrors AgentMemory.headOf: (hash, count, lastBlock, era).
    function headOf(uint256 id) external view returns (bytes32 hash, uint64 count, uint64 lastBlock, uint64 era);
}

contract HeroMemoryMarket {
    IERC20 public immutable hero;        // $HERO on Robinhood Chain — the settlement currency
    IAgentMemory public immutable mem;   // the AgentMemory NFT whose tokens are traded here

    address public owner;                // arbiter + parameter admin (transferable)
    address public feeRecipient;         // receives the marketplace fee (treasury)
    uint16 public feeBps = 250;          // 2.5% marketplace fee, capped at 10%
    uint16 public bondBps = 1000;        // 10% seller bond, capped at 50%
    uint64 public settleDeadline = 3 days;   // buyer refund if the seller never settles a paid order
    uint64 public disputeWindow = 3 days;     // buyer's window to dispute after delivery
    uint64 public disputeTimeout = 14 days;   // seller can claim if a dispute is never resolved
    bool public paused;

    // Timing bounds so owner param changes can never set a nonsensical or fund-trapping deadline.
    uint64 public constant MIN_PERIOD = 1 hours;
    uint64 public constant MAX_PERIOD = 60 days;

    enum Status { None, Listed, Paid, Delivered, Disputed, Complete, Cancelled }

    struct Listing {
        address seller;
        address buyer;
        uint256 price;      // $HERO the buyer pays (18dp)
        uint256 bond;       // $HERO the seller escrows, slashable to the buyer on a proven bad key
        bytes32 headHash;   // the exact memory head being sold — pins state, defeats sale-time front-run
        uint64  era;        // era of that head (a rebase changes it)
        uint16  feeSnap;    // fee bps locked AT SALE, so an owner fee change can't skim the seller later
        uint64  settleBy;   // deadline for the seller to settle (snapshot at buy = now + settleDeadline)
        uint64  disputeBy;  // buyer's dispute deadline (snapshot at settle = now + disputeWindow)
        uint64  timeoutBy;  // seller can force-claim a stuck dispute after this (snapshot at settle)
        Status  status;
    }
    mapping(uint256 => Listing) public listings; // agentId => listing

    // Reentrancy guard (no external contracts are trusted; every fund move is guarded anyway).
    uint256 private _lock = 1;
    modifier nonReentrant() { require(_lock == 1, "reentrant"); _lock = 2; _; _lock = 1; }
    modifier notPaused() { require(!paused, "paused"); _; }
    modifier onlyOwner() { require(msg.sender == owner, "not owner"); _; }

    event Listed(uint256 indexed agentId, address indexed seller, uint256 price, uint256 bond, bytes32 headHash, uint64 era);
    event Cancelled(uint256 indexed agentId, address indexed seller);
    event Bought(uint256 indexed agentId, address indexed buyer, uint256 price);
    event Settled(uint256 indexed agentId, address indexed seller, address indexed buyer);
    event Completed(uint256 indexed agentId, uint256 toSeller, uint256 fee);
    event Refunded(uint256 indexed agentId, address indexed buyer, uint256 amount);
    event Disputed(uint256 indexed agentId, address indexed buyer);
    event Resolved(uint256 indexed agentId, bool buyerWins);
    event ParamsChanged();

    constructor(address _hero, address _mem, address _feeRecipient) {
        require(_hero != address(0) && _mem != address(0) && _feeRecipient != address(0), "zero addr");
        hero = IERC20(_hero);
        mem = IAgentMemory(_mem);
        owner = msg.sender;
        feeRecipient = _feeRecipient;
    }

    // ---- seller: create a listing ----
    /// @notice List agent `agentId` for `price` $HERO. Pins the current head so the buyer is
    ///         guaranteed the exact memory they inspect. Pulls a `bondBps` bond from the seller.
    ///         Grant `approve(market, agentId)` (per-token) BEFORE calling.
    function list(uint256 agentId, uint256 price, bytes32 headHash, uint64 era) external nonReentrant notPaused {
        require(price > 0, "price 0");
        require(mem.ownerOf(agentId) == msg.sender, "not owner");
        require(_marketApproved(agentId, msg.sender), "approve market for this token first");
        (bytes32 h,,, uint64 e) = mem.headOf(agentId);
        require(h == headHash && e == era, "head mismatch"); // the listing commits to the live head
        Listing storage L = listings[agentId];
        require(L.status == Status.None || L.status == Status.Cancelled || L.status == Status.Complete, "active listing");

        uint256 bond = (price * bondBps) / 10_000;
        if (bond > 0) require(hero.transferFrom(msg.sender, address(this), bond), "bond transfer failed");

        listings[agentId] = Listing({
            seller: msg.sender, buyer: address(0), price: price, bond: bond,
            headHash: headHash, era: era, feeSnap: 0, settleBy: 0, disputeBy: 0, timeoutBy: 0,
            status: Status.Listed
        });
        emit Listed(agentId, msg.sender, price, bond, headHash, era);
    }

    /// @notice Cancel a listing that has not yet been paid; returns the bond.
    function cancel(uint256 agentId) external nonReentrant {
        Listing storage L = listings[agentId];
        require(L.status == Status.Listed, "not cancellable");
        require(msg.sender == L.seller || msg.sender == owner, "not seller");
        uint256 bond = L.bond;
        L.status = Status.Cancelled;
        if (bond > 0) require(hero.transfer(L.seller, bond), "bond return failed");
        emit Cancelled(agentId, L.seller);
    }

    // ---- buyer: pay into escrow ----
    /// @notice Buy a listed agent. `expectedHeadHash` must match the pinned head AND the live head,
    ///         so a seller who appends a poisoned checkpoint after listing cannot complete the sale.
    ///         Escrows `price` $HERO here (approve $HERO for this contract first). The buyer must have
    ///         published their ECIES pubkey (a `pubkey::` entry) so the seller can re-wrap the key.
    function buy(uint256 agentId, bytes32 expectedHeadHash, uint256 maxPrice) external nonReentrant notPaused {
        Listing storage L = listings[agentId];
        require(L.status == Status.Listed, "not for sale");
        require(msg.sender != L.seller, "seller cannot buy");
        require(L.price <= maxPrice, "price too high");
        require(L.headHash == expectedHeadHash, "head changed");
        require(mem.ownerOf(agentId) == L.seller, "seller no longer owns");
        (bytes32 h,,, uint64 e) = mem.headOf(agentId);
        require(h == L.headHash && e == L.era, "memory changed since listing"); // defeats sale-time front-run

        L.buyer = msg.sender;
        L.feeSnap = feeBps;                                        // lock the fee at sale time
        L.settleBy = uint64(block.timestamp) + settleDeadline;    // snapshot deadline; owner changes can't move it
        L.status = Status.Paid;
        require(hero.transferFrom(msg.sender, address(this), L.price), "payment failed");
        emit Bought(agentId, msg.sender, L.price);
    }

    /// @notice Buyer refund if the seller never delivers within `settleDeadline`. Returns the bond to
    ///         the seller (non-delivery is not cheating, just a no-show) and the price to the buyer.
    function refundUnsettled(uint256 agentId) external nonReentrant {
        Listing storage L = listings[agentId];
        require(L.status == Status.Paid, "not awaiting delivery");
        require(block.timestamp >= L.settleBy, "too early");
        require(msg.sender == L.buyer || msg.sender == owner, "not buyer");
        (uint256 price, uint256 bond, address buyer, address seller) = (L.price, L.bond, L.buyer, L.seller);
        L.status = Status.Cancelled;
        if (price > 0) require(hero.transfer(buyer, price), "refund failed");
        if (bond > 0) require(hero.transfer(seller, bond), "bond return failed");
        emit Refunded(agentId, buyer, price);
    }

    // ---- seller: deliver (post the salekey:: wrap off-chain, then settle) ----
    /// @notice ESCROW the NFT in the market and open the dispute window. Call this ONLY after posting
    ///         the `salekey::` re-wrap of the memory key to the buyer's pubkey on the agent (do that
    ///         while you still own the token). The NFT is held by the market, not handed to the buyer,
    ///         so a won dispute can claw it back to the seller. It releases to the buyer on confirm /
    ///         claim / a seller-favorable resolution.
    function settle(uint256 agentId) external nonReentrant {
        Listing storage L = listings[agentId];
        require(L.status == Status.Paid, "not paid");
        require(msg.sender == L.seller, "not seller");
        require(mem.ownerOf(agentId) == L.seller, "seller no longer owns");
        // Catch a rebase between buy and settle: a wiped era would deliver a different memory than the
        // buyer paid for, and the key-scoped dispute would not catch it (the key still decrypts).
        (,,, uint64 e) = mem.headOf(agentId);
        require(e == L.era, "era changed since sale");
        L.status = Status.Delivered;
        L.disputeBy = uint64(block.timestamp) + disputeWindow;   // snapshot: owner can't shrink the buyer's window
        L.timeoutBy = uint64(block.timestamp) + disputeTimeout;
        mem.transferFrom(L.seller, address(this), agentId);       // escrow the token (per-token approval from list())
        emit Settled(agentId, L.seller, L.buyer);
    }

    // ---- release paths ----
    /// @notice Buyer confirms the re-wrapped key decrypts the history; releases funds to the seller.
    function confirm(uint256 agentId) external nonReentrant {
        Listing storage L = listings[agentId];
        require(L.status == Status.Delivered, "not delivered");
        require(msg.sender == L.buyer, "not buyer");
        _release(agentId);
    }

    /// @notice Seller claims after the dispute window passes with no dispute (buyer went silent).
    function claim(uint256 agentId) external nonReentrant {
        Listing storage L = listings[agentId];
        require(L.status == Status.Delivered, "not delivered");
        require(msg.sender == L.seller, "not seller");
        require(block.timestamp >= L.disputeBy, "window open");
        _release(agentId);
    }

    /// @notice Buyer disputes a bad/garbage key within the window. Freezes funds for arbiter review.
    function dispute(uint256 agentId) external nonReentrant {
        Listing storage L = listings[agentId];
        require(L.status == Status.Delivered, "not delivered");
        require(msg.sender == L.buyer, "not buyer");
        require(block.timestamp < L.disputeBy, "window closed");
        L.status = Status.Disputed;
        emit Disputed(agentId, L.buyer);
    }

    /// @notice Arbiter ruling. buyerWins => the on-chain salekey:: wrap did NOT decrypt the memory
    ///         (objectively checkable when the buyer reveals their key to the arbiter): refund price +
    ///         slash the seller's bond to the buyer, and CLAW THE NFT BACK to the seller. Otherwise
    ///         pay the seller and release the NFT to the buyer as normal.
    function resolve(uint256 agentId, bool buyerWins) external nonReentrant onlyOwner {
        Listing storage L = listings[agentId];
        require(L.status == Status.Disputed, "not disputed");
        if (buyerWins) {
            (uint256 price, uint256 bond, address buyer, address seller) = (L.price, L.bond, L.buyer, L.seller);
            L.status = Status.Cancelled;
            uint256 pay = price + bond; // buyer made whole + compensated with the seller's bond
            mem.transferFrom(address(this), seller, agentId); // return the escrowed token to the seller
            if (pay > 0) require(hero.transfer(buyer, pay), "refund failed");
            emit Resolved(agentId, true);
            emit Refunded(agentId, buyer, pay);
        } else {
            emit Resolved(agentId, false);
            _release(agentId);
        }
    }

    /// @notice If a dispute is never resolved within `disputeTimeout`, the seller can still claim.
    ///         Bounds griefing-by-dispute: the buyer cannot trap the seller's funds by disputing and
    ///         relying on an absent arbiter.
    function claimDisputed(uint256 agentId) external nonReentrant {
        Listing storage L = listings[agentId];
        require(L.status == Status.Disputed, "not disputed");
        require(msg.sender == L.seller, "not seller");
        require(block.timestamp >= L.timeoutBy, "timeout open");
        _release(agentId);
    }

    // Release the escrowed NFT to the buyer, the fee to treasury, and price-minus-fee plus the
    // returned bond to the seller. Fee uses the rate LOCKED AT SALE (feeSnap), not the current one.
    function _release(uint256 agentId) private {
        Listing storage L = listings[agentId];
        (uint256 price, uint256 bond, address seller, address buyer) = (L.price, L.bond, L.seller, L.buyer);
        L.status = Status.Complete;
        uint256 fee = (price * L.feeSnap) / 10_000;
        uint256 toSeller = price - fee + bond;
        mem.transferFrom(address(this), buyer, agentId); // release the escrowed token to the buyer
        if (fee > 0) require(hero.transfer(feeRecipient, fee), "fee failed");
        if (toSeller > 0) require(hero.transfer(seller, toSeller), "payout failed");
        emit Completed(agentId, toSeller, fee);
    }

    function _marketApproved(uint256 agentId, address seller) private view returns (bool) {
        return mem.getApproved(agentId) == address(this) || mem.isApprovedForAll(seller, address(this));
    }

    // ---- admin ----
    function setParams(uint16 _feeBps, uint16 _bondBps, uint64 _settle, uint64 _window, uint64 _timeout) external onlyOwner {
        require(_feeBps <= 1000, "fee too high");   // <= 10%
        require(_bondBps <= 5000, "bond too high"); // <= 50%
        require(_window <= _timeout, "window > timeout");
        require(_settle >= MIN_PERIOD && _settle <= MAX_PERIOD, "settle bounds");
        require(_window >= MIN_PERIOD && _window <= MAX_PERIOD, "window bounds");
        require(_timeout >= MIN_PERIOD && _timeout <= MAX_PERIOD, "timeout bounds");
        feeBps = _feeBps; bondBps = _bondBps; settleDeadline = _settle; disputeWindow = _window; disputeTimeout = _timeout;
        emit ParamsChanged();
    }
    function setFeeRecipient(address v) external onlyOwner { require(v != address(0), "zero"); feeRecipient = v; emit ParamsChanged(); }
    function setPaused(bool v) external onlyOwner { paused = v; emit ParamsChanged(); }
    function transferOwnership(address v) external onlyOwner { require(v != address(0), "zero"); owner = v; emit ParamsChanged(); }
}
