pragma solidity ^0.6.2;

import "@openzeppelin/contracts/math/Math.sol";
import "@hq20/contracts/contracts/math/DecimalMath.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./interfaces/IDealer.sol";
import "./interfaces/ITreasury.sol";
import "./Constants.sol";


/// @dev The Liquidations contract for a Dealer allows to liquidate undercollateralized positions in a reverse Dutch auction.
contract Liquidations is Constants {
    using DecimalMath for uint256;
    using DecimalMath for uint8;

    IDealer internal _dealer;
    ITreasury internal _treasury;
    IERC20 internal _dai;

    uint256 public auctionTime;

    mapping(bytes32 => mapping(address => uint256)) public auctions;

    constructor (
        address dealer_,
        address treasury_,
        address dai_,
        uint256 auctionTime_
    ) public {
        _dealer = IDealer(dealer_);
        _treasury = ITreasury(treasury_);
        _dai = IERC20(dai_);
        require(
            auctionTime_ > 0,
            "Liquidations: Auction time is zero"
        );
    }

    /// @dev Starts a liquidation process for a given collateral and user.
    function start(bytes32 collateral, address user) public {
        require(
            auctions[collateral][user] == 0,
            "Liquidations: User is already targeted"
        );
        require(
            _dealer.isCollateralized(collateral, user),
            "Liquidations: User is not undercollateralized"
        );
        // solium-disable-next-line security/no-block-members
        auctions[collateral][user] = now;
    }

    /// @dev Cancels a liquidation process
    function cancel(bytes32 collateral, address user) public {
        require(
            auctions[collateral][user] > 0,
            "Liquidations: User is not in liquidation"
        );
        require(
            !_dealer.isCollateralized(collateral, user),
            "Liquidations: User is undercollateralized"
        );
        // solium-disable-next-line security/no-block-members
        delete auctions[collateral][user];
    }

    /// @dev Liquidates a position. The caller pays the debt of `from`, and `to` receives an amount of collateral.
    /// @param from User vault to liquidate
    /// @param to Account paying the debt and receiving the collateral
    function liquidate(bytes32 collateral, uint256 series, address from, address to, uint256 daiAmount) public {
        require(
            auctions[collateral][from] > 0,
            "Liquidations: User is not targeted"
        );
        require(
            !_dealer.isCollateralized(collateral, from),
            "Liquidations: User is not undercollateralized"
        );
        require( // grab dai from liquidator and push to treasury
            _dai.transferFrom(from, address(_treasury), daiAmount),
            "Dealer: Dai transfer fail"
        );
        _treasury.pushDai();
        
        // calculate collateral to grab
        uint256 toGrab = daiAmount * price(collateral, from);
        // grab collateral from dealer
        _dealer.grab(collateral, series, from, daiAmount, toGrab);
    }

    /// @dev Return price of a collateral unit, in dai, at the present moment
    // collateral = price * dai - TODO: Consider reversing so that it matches the Oracles
    // TODO: Optimize this for gas
    //                     3 * auctionTime
    // price = (3/2) +  * -----------------
    //                       elapsedTime

    function price(bytes32 collateral, address user) public view returns (uint256) {
        require(
            auctions[collateral][user] > 0,
            "Liquidations: User is not targeted"
        );
        uint256 oneAndAHalf = RAY.unit() + RAY.unit() / 2;
        uint256 elapsedTimeRay = (now - auctions[collateral][user]) * RAY.unit();
        return oneAndAHalf + (3 * auctionTime * RAY.unit()).divd(elapsedTimeRay, RAY);
    }
}