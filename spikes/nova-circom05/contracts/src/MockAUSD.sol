// SPDX-License-Identifier: MIT
pragma solidity ^0.8.21;

/// @dev Test-only 6-decimal ERC-20 standing in for AUSD. Anyone can mint.
contract MockAUSD {
  string public constant name = "Mock AUSD";
  string public constant symbol = "AUSD";
  uint8 public constant decimals = 6;
  uint256 public totalSupply;
  mapping(address => uint256) public balanceOf;
  mapping(address => mapping(address => uint256)) public allowance;

  event Transfer(address indexed from, address indexed to, uint256 value);
  event Approval(address indexed owner, address indexed spender, uint256 value);

  function mint(address to, uint256 amount) external {
    totalSupply += amount;
    balanceOf[to] += amount;
    emit Transfer(address(0), to, amount);
  }

  function approve(address spender, uint256 amount) external returns (bool) {
    allowance[msg.sender][spender] = amount;
    emit Approval(msg.sender, spender, amount);
    return true;
  }

  function transfer(address to, uint256 amount) external returns (bool) {
    _move(msg.sender, to, amount);
    return true;
  }

  function transferFrom(address from, address to, uint256 amount) external returns (bool) {
    uint256 a = allowance[from][msg.sender];
    if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
    _move(from, to, amount);
    return true;
  }

  function _move(address from, address to, uint256 amount) internal {
    balanceOf[from] -= amount;
    balanceOf[to] += amount;
    emit Transfer(from, to, amount);
  }
}
