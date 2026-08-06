// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24; // OpenZeppelin 5.6.1 ERC721 requires ^0.8.24

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {ERC721URIStorage} from "@openzeppelin/contracts/token/ERC721/extensions/ERC721URIStorage.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title HeroMemoryCard — fully on-chain "memory NFT" covers on Robinhood Chain.
/// @notice A wallet mints a card whose ENTIRE token URI is supplied at mint time and stored on-chain:
///         a `data:application/json` document carrying the name, description, and a small embedded
///         `data:` image. There is no server, gateway, or IPFS in the path, so the card renders in any
///         wallet for as long as Robinhood Chain exists and depends on nothing we host. The full-size
///         artifact (image bytes, code, or a conversation) is stored separately as a checkpoint blob on
///         the agent-memory contract; this card is the small, wallet-visible cover for it.
///
/// @dev Paid in $HERO: the mint pulls `mintFee` from the caller to the treasury (approve first), so
///      every card is a small $HERO sink. `maxUriBytes` bounds the on-chain string, since the URI is
///      kept in contract storage (keep covers to a compressed thumbnail, not a full-res image).
contract HeroMemoryCard is ERC721URIStorage, ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;

    IERC20 public immutable hero; // $HERO on Robinhood Chain, the mint currency
    address public treasury;      // receives the mint fee
    uint256 public mintFee;       // $HERO per mint (18dp); 0 = free
    uint256 public nextId = 1;
    uint256 public maxUriBytes = 24_000; // cap the on-chain URI so a mint can't be used as unbounded storage

    event CardMinted(uint256 indexed id, address indexed to, uint256 fee);

    error BadTo();
    error BadUri();
    error FeeTooHigh();

    constructor(address _hero, address _treasury) ERC721("Hero Memory Card", "HMC") Ownable(msg.sender) {
        require(_treasury != address(0), "treasury");
        hero = IERC20(_hero);
        treasury = _treasury;
    }

    /// @notice Mint a fully on-chain card. `uri` is a complete token URI built client-side
    ///         (`data:application/json,...` or `;base64,...`) with a small embedded `data:` image.
    ///         Pays `mintFee` in $HERO to the treasury; approve this contract for the fee first.
    /// @param maxFee the most the caller is willing to pay, checked against the live `mintFee` so a
    ///        setMintFee raise in-flight (or a compromised owner key) can never charge more than agreed.
    function mint(address to, string calldata uri, uint256 maxFee) external nonReentrant returns (uint256 id) {
        if (to == address(0)) revert BadTo();
        uint256 len = bytes(uri).length;
        if (len == 0 || len > maxUriBytes) revert BadUri();
        uint256 fee = mintFee;
        if (fee > maxFee) revert FeeTooHigh();
        if (fee > 0) hero.safeTransferFrom(msg.sender, treasury, fee);
        id = nextId++;
        _safeMint(to, id);
        _setTokenURI(id, uri);
        emit CardMinted(id, to, fee);
    }

    function setMintFee(uint256 v) external onlyOwner { mintFee = v; }
    function setTreasury(address v) external onlyOwner { require(v != address(0), "treasury"); treasury = v; }
    function setMaxUriBytes(uint256 v) external onlyOwner {
        require(v > 0 && v <= 100_000, "bounds");
        maxUriBytes = v;
    }

    /// @notice Recover tokens sent to this contract by mistake. The contract never holds $HERO in
    ///         normal flow since mint fees go straight to treasury, so this is purely for stranded tokens.
    function rescue(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert BadTo();
        IERC20(token).safeTransfer(to, amount);
    }
}
