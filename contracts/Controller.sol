pragma solidity ^0.6.10;

import "@openzeppelin/contracts/math/Math.sol";
import "@openzeppelin/contracts/math/SafeMath.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "./interfaces/IVat.sol";
import "./interfaces/IPot.sol";
import "./interfaces/IChai.sol";
import "./interfaces/ITreasury.sol";
import "./interfaces/IController.sol";
import "./interfaces/IYDai.sol";
import "./helpers/Delegable.sol";
import "./helpers/DecimalMath.sol";
import "./helpers/Orchestrated.sol";
import "@nomiclabs/buidler/console.sol";

/**
 * @dev The Controller manages collateral and debt levels for all users, and it is a major user entry point for the Yield protocol.
 * Controller keeps track of a number of yDai contracts.
 * Controller allows users to post and withdraw Chai and Weth collateral.
 * Any transactions resulting in a user weth collateral below dust are reverted.
 * Controller allows users to borrow yDai against their Chai and Weth collateral.
 * Controller allows users to repay their yDai debt with yDai or with Dai.
 * Controller integrates with yDai contracts for minting yDai on borrowing, and burning yDai on repaying debt with yDai.
 * Controller relies on Treasury for all other asset transfers.
 * Controller allows orchestrated contracts to erase any amount of debt or collateral for an user. This is to be used during liquidations or during unwind.
 * Users can delegate the control of their accounts in Controllers to any address.
 */
contract Controller is IController, Orchestrated(), Delegable(), DecimalMath {
    using SafeMath for uint256;

    event Posted(bytes32 indexed collateral, address indexed user, int256 amount);
    event Borrowed(bytes32 indexed collateral, uint256 indexed maturity, address indexed user, int256 amount);

    bytes32 public constant CHAI = "CHAI";
    bytes32 public constant WETH = "ETH-A";
    uint256 public constant DUST = 50000000000000000; // 0.05 ETH

    IVat internal _vat;
    IERC20 internal _dai;
    IPot internal _pot;
    ITreasury internal _treasury;

    mapping(bytes32 => IERC20) internal _token;                       // Weth or Chai
    mapping(uint256 => IYDai) public override series;                 // YDai series, indexed by maturity
    uint256[] internal seriesIterator;                                // We need to know all the series

    mapping(bytes32 => mapping(address => uint256)) public override posted;               // Collateral posted by each user
    mapping(bytes32 => mapping(uint256 => mapping(address => uint256))) public override debtYDai;  // Debt owed by each user, by series

    mapping(bytes32 => uint256) public override systemPosted;                        // Sum of collateral posted by all users
    mapping(bytes32 => mapping(uint256 => uint256)) public override systemDebtYDai;  // Sum of debt owed by all users, by series

    bool public live = true;

    constructor (
        address vat_,
        address weth_,
        address dai_,
        address pot_,
        address chai_,
        address treasury_
    ) public {
        _vat = IVat(vat_);
        _dai = IERC20(dai_);
        _pot = IPot(pot_);
        _treasury = ITreasury(treasury_);
        _token[WETH] = IERC20(weth_);
        _token[CHAI] = IERC20(chai_);
    }

    modifier onlyLive() {
        require(live == true, "Controller: Not available during unwind");
        _;
    }

    /// @dev Only series added through `addSeries` are valid.
    modifier validSeries(uint256 maturity) {
        require(
            containsSeries(maturity),
            "Controller: Unrecognized series"
        );
        _;
    }

    /// @dev Only valid collateral types are Weth and Chai.
    modifier validCollateral(bytes32 collateral) {
        require(
            collateral == WETH || collateral == CHAI,
            "Controller: Unrecognized collateral"
        );
        _;
    }

    /// @dev Returns if a series has been added to the Controller, for a given series identified by maturity
    function containsSeries(uint256 maturity) public view returns (bool) {
        return address(series[maturity]) != address(0);
    }

    /// @dev Adds an yDai series to this Controller
    function addSeries(address yDaiContract) public onlyOwner {
        uint256 maturity = IYDai(yDaiContract).maturity();
        require(
            !containsSeries(maturity),
            "Controller: Series already added"
        );
        series[maturity] = IYDai(yDaiContract);
        seriesIterator.push(maturity);
    }

    /// @dev Disables post, withdraw, borrow and repay. To be called only when Treasury shuts down.
    function shutdown() public override {
        require(
            _treasury.live() == false,
            "Dealer: Treasury is live"
        );
        live = false;
    }

    /// @dev Returns the dai equivalent of an yDai amount, for a given series identified by maturity
    function inDai(bytes32 collateral, uint256 maturity, uint256 yDaiAmount) public returns (uint256) {
        if (series[maturity].isMature()){
            if (collateral == WETH){
                return muld(yDaiAmount, series[maturity].rateGrowth());
            } else if (collateral == CHAI) {
                return muld(yDaiAmount, series[maturity].chiGrowth());
            } else {
                revert("Controller: Unsupported collateral");
            }
        } else {
            return yDaiAmount;
        }
    }

    /// @dev Returns the yDai equivalent of a dai amount, for a given series identified by maturity
    function inYDai(bytes32 collateral, uint256 maturity, uint256 daiAmount) public returns (uint256) {
        if (series[maturity].isMature()){
            if (collateral == WETH){
                return divd(daiAmount, series[maturity].rateGrowth());
            } else if (collateral == CHAI) {
                return divd(daiAmount, series[maturity].chiGrowth());
            } else {
                revert("Controller: Unsupported collateral");
            }
        } else {
            return daiAmount;
        }
    }

    /// @dev Return debt in dai of an user, for a given collateral and series identified by maturity
    //
    //                        rate_now
    // debt_now = debt_mat * ----------
    //                        rate_mat
    //
    function debtDai(bytes32 collateral, uint256 maturity, address user) public returns (uint256) {
        return inDai(collateral, maturity, debtYDai[collateral][maturity][user]);
    }

    /// @dev Returns the total debt of an user, for a given collateral, across all series, in Dai
    function totalDebtDai(bytes32 collateral, address user) public override returns (uint256) {
        uint256 totalDebt;
        for (uint256 i = 0; i < seriesIterator.length; i += 1) {
            if (debtYDai[collateral][seriesIterator[i]][user] > 0) {
                totalDebt = totalDebt + debtDai(collateral, seriesIterator[i], user);
            }
        } // We don't expect hundreds of maturities per controller
        return totalDebt;
    }

    /// @dev Maximum borrowing power of an user in dai for a given collateral
    //
    // powerOf[user](wad) = posted[user](wad) * oracle.price()(ray)
    //
    function powerOf(bytes32 collateral, address user) public returns (uint256) {
        // dai = price * collateral
        if (collateral == WETH){
            (,, uint256 spot,,) = _vat.ilks(WETH);  // Stability fee and collateralization ratio for Weth
            return muld(posted[collateral][user], spot);
        } else if (collateral == CHAI) {
            uint256 chi = (now > _pot.rho()) ? _pot.drip() : _pot.chi();
            return muld(posted[collateral][user], chi);
        }
        return 0;
    }

    /// @dev Return if the borrowing power for a given collateral of an user is equal or greater than its debt for the same collateral
    function isCollateralized(bytes32 collateral, address user) public override returns (bool) {
        return powerOf(collateral, user) >= totalDebtDai(collateral, user);
    }

    /// @dev Return if the debt of an user is between zero and the dust level
    function aboveDustOrZero(bytes32 collateral, address user) public returns (bool) {
        return posted[collateral][user] == 0 || DUST < posted[collateral][user];
    }

    /// @dev Takes collateral _token from `from` address, and credits it to `to` collateral account.
    // from --- Token ---> us(to)
    function post(bytes32 collateral, address from, address to, uint256 amount)
        public override 
        validCollateral(collateral)
        onlyHolderOrDelegate(from, "Controller: Only Holder Or Delegate")
        onlyLive
    {
        posted[collateral][to] = posted[collateral][to].add(amount);
        systemPosted[collateral] = systemPosted[collateral].add(amount);

        if (collateral == WETH){ // TODO: Refactor Treasury to be `push(collateral, amount)`
            require(
                aboveDustOrZero(collateral, to),
                "Controller: Below dust"
            );
            _treasury.pushWeth(from, amount);
        } else if (collateral == CHAI) {
            _treasury.pushChai(from, amount);
        }
        
        emit Posted(collateral, to, int256(amount)); // TODO: Watch for overflow
    }

    /// @dev Returns collateral to `to` address, taking it from `from` collateral account.
    // us(from) --- Token ---> to
    function withdraw(bytes32 collateral, address from, address to, uint256 amount)
        public override
        validCollateral(collateral)
        onlyHolderOrDelegate(from, "Controller: Only Holder Or Delegate")
        onlyLive
    {
        posted[collateral][from] = posted[collateral][from].sub(amount); // Will revert if not enough posted
        systemPosted[collateral] = systemPosted[collateral].sub(amount);

        require(
            isCollateralized(collateral, from),
            "Controller: Too much debt"
        );

        if (collateral == WETH){ // TODO: Refactor Treasury to be `pull(collateral, amount)`
            require(
                aboveDustOrZero(collateral, to),
                "Controller: Below dust"
            );
            _treasury.pullWeth(to, amount);
        } else if (collateral == CHAI) {
            _treasury.pullChai(to, amount);
        }

        emit Posted(collateral, from, -int256(amount)); // TODO: Watch for overflow
    }

    /// @dev Mint yDai for a given series for address `to` by locking its market value in collateral, user debt is increased in the given collateral.
    //
    // posted[user](wad) >= (debtYDai[user](wad)) * amount (wad)) * collateralization (ray)
    //
    // us(from) --- yDai ---> to
    // debt++
    function borrow(bytes32 collateral, uint256 maturity, address from, address to, uint256 yDaiAmount)
        public override
        validCollateral(collateral)
        validSeries(maturity)
        onlyHolderOrDelegate(from, "Controller: Only Holder Or Delegate")
        onlyLive
    {
        require(
            series[maturity].isMature() != true,
            "Controller: No mature borrow"
        );

        debtYDai[collateral][maturity][from] = debtYDai[collateral][maturity][from].add(yDaiAmount);
        systemDebtYDai[collateral][maturity] = systemDebtYDai[collateral][maturity].add(yDaiAmount);

        require(
            isCollateralized(collateral, from),
            "Controller: Too much debt"
        );

        series[maturity].mint(to, yDaiAmount);
        emit Borrowed(collateral, maturity, from, int256(yDaiAmount)); // TODO: Watch for overflow
    }

    /// @dev Burns yDai of a given series from `from` address, user debt is decreased for the given collateral and yDai series.
    //                                                  debt_nominal
    // debt_discounted = debt_nominal - repay_amount * ---------------
    //                                                  debt_now
    //
    // user(from) --- yDai ---> us(to)
    // debt--
    function repayYDai(bytes32 collateral, uint256 maturity, address from, address to, uint256 yDaiAmount)
        public override
        validCollateral(collateral)
        validSeries(maturity)
        onlyHolderOrDelegate(from, "Controller: Only Holder Or Delegate")
        onlyLive
    {
        uint256 toRepay = Math.min(yDaiAmount, debtYDai[collateral][maturity][to]);
        series[maturity].burn(from, toRepay);
        _repay(collateral, maturity, to, toRepay);
    }

    /// @dev Takes dai from `from` address, user debt is decreased for the given collateral and yDai series.
    //                                                  debt_nominal
    // debt_discounted = debt_nominal - repay_amount * ---------------
    //                                                  debt_now
    //
    // user --- dai ---> us
    // debt--
    function repayDai(bytes32 collateral, uint256 maturity, address from, address to, uint256 daiAmount)
        public override
        validCollateral(collateral)
        validSeries(maturity)
        onlyHolderOrDelegate(from, "Controller: Only Holder Or Delegate")
        onlyLive
    {
        uint256 toRepay = Math.min(daiAmount, debtDai(collateral, maturity, to));
        _treasury.pushDai(from, toRepay);                                      // Have Treasury process the dai
        _repay(collateral, maturity, to, inYDai(collateral, maturity, toRepay));
    }

    /// @dev Removes an amount of debt from an user's vault. If interest was accrued debt is only paid proportionally.
    //
    //                                                principal
    // principal_repayment = gross_repayment * ----------------------
    //                                          principal + interest
    //    
    function _repay(bytes32 collateral, uint256 maturity, address user, uint256 yDaiAmount) internal {
        debtYDai[collateral][maturity][user] = debtYDai[collateral][maturity][user].sub(yDaiAmount);
        systemDebtYDai[collateral][maturity] = systemDebtYDai[collateral][maturity].sub(yDaiAmount);

        emit Borrowed(collateral, maturity, user, -int256(yDaiAmount)); // TODO: Watch for overflow
    }

    /// @dev Removes collateral and debt for an user.
    function grab(bytes32 collateral, address user, uint256 daiAmount, uint256 tokenAmount)
        public override
        validCollateral(collateral)
        onlyOrchestrated("Controller: Not Authorized")
    {

        posted[collateral][user] = posted[collateral][user].sub(
            tokenAmount,
            "Controller: Not enough collateral"
        );
        systemPosted[collateral] = systemPosted[collateral].sub(tokenAmount);

        uint256 totalGrabbed;
        for (uint256 i = 0; i < seriesIterator.length; i += 1) {
            uint256 maturity = seriesIterator[i];
            uint256 thisGrab = Math.min(debtDai(collateral, maturity, user), daiAmount.sub(totalGrabbed));
            totalGrabbed = totalGrabbed.add(thisGrab); // SafeMath shouldn't be needed
            debtYDai[collateral][maturity][user] =
                debtYDai[collateral][maturity][user].sub(inYDai(collateral, maturity, thisGrab)); // SafeMath shouldn't be needed
            systemDebtYDai[collateral][maturity] =
                systemDebtYDai[collateral][maturity].sub(inYDai(collateral, maturity, thisGrab)); // SafeMath shouldn't be needed
            if (totalGrabbed == daiAmount) break;
        } // We don't expect hundreds of maturities per controller
        require(
            totalGrabbed == daiAmount,
            "Controller: Not enough user debt"
        );

        require( // TODO: Untested, but to be moved to Liquidations and refactored there
            collateral != WETH || aboveDustOrZero(collateral, user),
            "Controller: Below dust"
        );
    }
}