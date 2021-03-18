// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity ^0.8.0;
import "@yield-protocol/utils/contracts/token/IERC20.sol";
import "./IJoin.sol";
import "./AccessControl.sol";


library Safe256 {
    /// @dev Safely cast an int128 to an uint128
    function u256(int256 x) internal pure returns (uint256 y) {
        require (x >= 0, "Cast overflow");
        y = uint256(x);
    }
}

contract Join is IJoin, AccessControl() {
    using Safe256 for int256;

    IERC20 public override token;
    // bytes6  public asset;   // Collateral Type
    // uint    public dec;
    // uint    public live;  // Active Flag

    constructor(IERC20 token_) {
        token = token_;
        // asset = asset_;
        // dec = token.decimals();
        // live = 1;
    }

    /*
    function cage() external auth {
        live = 0;
    }
    */

    function join(address payable user, int128 amount)
        external payable override
        auth
        returns (int128)
    {
        require(msg.value == 0, "Not an ETH Join");
        if (amount > 0) {
            // require(live == 1, "GemJoin/not-live");
            // TODO: Consider best practices about safe transfers
            require(token.transferFrom(user, address(this), int256(amount).u256()), "Failed pull");
        } else {
            // TODO: Consider best practices about safe transfers
            require(token.transfer(user, (-int256(amount)).u256()), "Failed push"); 
        }
        return amount;
    }
}