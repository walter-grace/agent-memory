// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {HeroMemoryMarket} from "../../contracts/HeroMemoryMarket.sol";

// Minimal $HERO mock.
contract MockHero {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    function mint(address to, uint256 a) external { balanceOf[to] += a; }
    function approve(address s, uint256 a) external returns (bool) { allowance[msg.sender][s] = a; return true; }
    function transfer(address to, uint256 a) external returns (bool) { require(balanceOf[msg.sender] >= a, "bal"); balanceOf[msg.sender] -= a; balanceOf[to] += a; return true; }
    function transferFrom(address f, address t, uint256 a) external returns (bool) {
        require(balanceOf[f] >= a, "bal"); require(allowance[f][msg.sender] >= a, "allow");
        allowance[f][msg.sender] -= a; balanceOf[f] -= a; balanceOf[t] += a; return true;
    }
}

// Minimal AgentMemory mock: just the bits the market touches, plus setters to simulate head/era/rebase.
contract MockMem {
    mapping(uint256 => address) public ownerOf;
    mapping(uint256 => address) public getApproved;
    mapping(address => mapping(address => bool)) public isApprovedForAll;
    struct H { bytes32 hash; uint64 count; uint64 lastBlock; uint64 era; }
    mapping(uint256 => H) internal _head;
    function mintTo(address to, uint256 id, bytes32 hash, uint64 era) external { ownerOf[id] = to; _head[id] = H(hash, 1, 0, era); }
    function setHead(uint256 id, bytes32 hash, uint64 era) external { _head[id].hash = hash; _head[id].era = era; }
    function headOf(uint256 id) external view returns (bytes32, uint64, uint64, uint64) { H memory h = _head[id]; return (h.hash, h.count, h.lastBlock, h.era); }
    function approve(address to, uint256 id) external { require(msg.sender == ownerOf[id], "own"); getApproved[id] = to; }
    function setApprovalForAll(address op, bool v) external { isApprovedForAll[msg.sender][op] = v; }
    function transferFrom(address from, address to, uint256 id) external {
        require(ownerOf[id] == from, "from");
        require(msg.sender == from || msg.sender == getApproved[id] || isApprovedForAll[from][msg.sender], "auth");
        delete getApproved[id]; ownerOf[id] = to;
    }
}

contract HeroMemoryMarketTest is Test {
    HeroMemoryMarket market;
    MockHero hero;
    MockMem mem;
    address treasury = address(0xFEE);
    address seller = address(0x5E11E9);
    address buyer = address(0xB47E9);
    uint256 constant ID = 7;
    bytes32 constant HEAD = keccak256("head-v1");
    uint64 constant ERA = 3;
    uint256 constant PRICE = 1_000e18;

    function setUp() public {
        hero = new MockHero();
        mem = new MockMem();
        market = new HeroMemoryMarket(address(hero), address(mem), treasury); // owner = this test contract
        mem.mintTo(seller, ID, HEAD, ERA);
        hero.mint(seller, 10_000e18);
        hero.mint(buyer, 10_000e18);
    }

    function _list() internal {
        vm.startPrank(seller);
        mem.approve(address(market), ID);
        hero.approve(address(market), type(uint256).max);
        market.list(ID, PRICE, HEAD, ERA);
        vm.stopPrank();
    }
    function _buy() internal {
        vm.startPrank(buyer);
        hero.approve(address(market), type(uint256).max);
        market.buy(ID, HEAD, PRICE);
        vm.stopPrank();
    }
    function _settle() internal { vm.prank(seller); market.settle(ID); }

    function testHappyPath() public {
        uint256 bond = PRICE * 1000 / 10_000; // 10%
        uint256 fee = PRICE * 250 / 10_000;    // 2.5%
        uint256 sBefore = hero.balanceOf(seller);
        _list(); _buy(); _settle();
        assertEq(mem.ownerOf(ID), address(market), "NFT escrowed in market after settle");
        vm.prank(buyer); market.confirm(ID);
        assertEq(mem.ownerOf(ID), buyer, "NFT to buyer on confirm");
        assertEq(hero.balanceOf(treasury), fee, "fee to treasury");
        // seller: -bond (list) + (price - fee + bond) (release) = +price-fee
        assertEq(hero.balanceOf(seller), sBefore + PRICE - fee, "seller net = price - fee");
        assertEq(hero.balanceOf(address(market)), 0, "escrow drained to zero");
    }

    function testClaimAfterWindow() public {
        _list(); _buy(); _settle();
        vm.warp(block.timestamp + 3 days + 1);
        vm.prank(seller); market.claim(ID);
        assertEq(mem.ownerOf(ID), buyer, "NFT to buyer");
        assertEq(hero.balanceOf(address(market)), 0, "drained");
    }

    function testDisputeBuyerWins() public {
        uint256 bond = PRICE * 1000 / 10_000;
        uint256 bBefore = hero.balanceOf(buyer);
        _list(); _buy(); _settle();
        vm.prank(buyer); market.dispute(ID);
        market.resolve(ID, true); // owner = test contract
        assertEq(mem.ownerOf(ID), seller, "NFT clawed back to seller on buyerWins");
        assertEq(hero.balanceOf(buyer), bBefore + bond, "buyer made whole (paid price back) + seller bond");
        assertEq(hero.balanceOf(address(market)), 0, "drained");
    }

    function testDisputeSellerWins() public {
        uint256 fee = PRICE * 250 / 10_000;
        uint256 sBefore = hero.balanceOf(seller);
        _list(); _buy(); _settle();
        vm.prank(buyer); market.dispute(ID);
        market.resolve(ID, false);
        assertEq(mem.ownerOf(ID), buyer, "NFT to buyer");
        assertEq(hero.balanceOf(seller), sBefore + PRICE - fee, "seller paid price - fee");
        assertEq(hero.balanceOf(address(market)), 0, "drained");
    }

    function testRefundUnsettled() public {
        uint256 bBefore = hero.balanceOf(buyer);
        uint256 sBefore = hero.balanceOf(seller);
        _list(); _buy();
        vm.warp(block.timestamp + 3 days + 1);
        vm.prank(buyer); market.refundUnsettled(ID);
        assertEq(hero.balanceOf(buyer), bBefore, "buyer fully refunded");
        assertEq(hero.balanceOf(seller), sBefore, "seller bond returned (net zero)");
        assertEq(mem.ownerOf(ID), seller, "NFT never left seller");
        assertEq(hero.balanceOf(address(market)), 0, "drained");
    }

    function testNoDoubleRelease() public {
        _list(); _buy(); _settle();
        vm.prank(buyer); market.confirm(ID);
        vm.warp(block.timestamp + 3 days + 1);
        vm.prank(seller); vm.expectRevert(); market.claim(ID);
    }

    function testBuyRevertsIfHeadMoved() public {
        _list();
        mem.setHead(ID, keccak256("poisoned"), ERA); // seller front-runs a checkpoint after listing
        vm.startPrank(buyer); hero.approve(address(market), type(uint256).max);
        vm.expectRevert(); market.buy(ID, HEAD, PRICE);
        vm.stopPrank();
    }

    function testSettleRevertsIfEraChanged() public {
        _list(); _buy();
        mem.setHead(ID, HEAD, ERA + 1); // seller rebases between buy and settle
        vm.prank(seller); vm.expectRevert(); market.settle(ID);
    }

    function testFeeLockedAtSale() public {
        _list(); _buy();
        // owner raises fee to max AFTER the buyer paid
        market.setParams(1000, 1000, 3 days, 3 days, 14 days);
        _settle();
        uint256 bond = PRICE * 1000 / 10_000;
        uint256 sBefore = hero.balanceOf(seller);
        vm.prank(buyer); market.confirm(ID);
        uint256 lockedFee = PRICE * 250 / 10_000; // still 2.5%, not the raised 10%
        // seller gets price - fee + bond back; the fee must be the SALE-TIME 2.5%, proving the snapshot
        assertEq(hero.balanceOf(seller), sBefore + PRICE - lockedFee + bond, "fee locked at sale-time 2.5%");
        assertEq(hero.balanceOf(treasury), lockedFee, "treasury got locked 2.5% fee, not the raised 10%");
    }

    function testCannotBuyOwnListing() public {
        _list();
        vm.startPrank(seller); hero.approve(address(market), type(uint256).max);
        vm.expectRevert(); market.buy(ID, HEAD, PRICE);
        vm.stopPrank();
    }

    function testCancelReturnsBond() public {
        uint256 sBefore = hero.balanceOf(seller);
        _list();
        vm.prank(seller); market.cancel(ID);
        assertEq(hero.balanceOf(seller), sBefore, "bond returned on cancel");
        assertEq(hero.balanceOf(address(market)), 0, "drained");
    }

    function testParamsBounds() public {
        vm.expectRevert(); market.setParams(1001, 1000, 3 days, 3 days, 14 days);   // fee > 10%
        vm.expectRevert(); market.setParams(250, 5001, 3 days, 3 days, 14 days);    // bond > 50%
        vm.expectRevert(); market.setParams(250, 1000, 1 minutes, 3 days, 14 days); // settle < MIN_PERIOD
        vm.expectRevert(); market.setParams(250, 1000, 3 days, 3 days, 61 days);    // timeout > MAX_PERIOD
    }

    function testClaimDisputedAfterTimeout() public {
        _list(); _buy(); _settle();
        vm.prank(buyer); market.dispute(ID);
        vm.warp(block.timestamp + 14 days + 1);
        vm.prank(seller); market.claimDisputed(ID);
        assertEq(mem.ownerOf(ID), buyer, "NFT to buyer");
        assertEq(hero.balanceOf(address(market)), 0, "drained");
    }

    function testNonSellerCannotList() public {
        vm.prank(buyer);
        vm.expectRevert(); market.list(ID, PRICE, HEAD, ERA); // buyer doesn't own ID
    }

    function testListRequiresApproval() public {
        vm.startPrank(seller);
        hero.approve(address(market), type(uint256).max);
        vm.expectRevert(); market.list(ID, PRICE, HEAD, ERA); // no NFT approval
        vm.stopPrank();
    }
}
