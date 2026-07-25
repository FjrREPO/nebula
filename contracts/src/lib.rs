#![cfg_attr(not(test), no_std)]
#![cfg_attr(not(test), no_main)]
//! Nebula on-chain contracts for Casper (Odra / Rust → Wasm).
//!
//! The trust core of an agentic RWA protocol:
//!
//! - [`NebulaUsd`]: CEP-18-style settlement token with EIP-3009
//!   `transfer_with_authorization` — the x402 payment rail.
//! - [`IdentityRegistry`]: ERC-3643-style on-chain identity for investors
//!   (compliance claims) and oracle agents alike.
//! - [`OracleHub`]: RWA risk attestations anchored on-chain, with
//!   accuracy-backed oracle reputation.
//! - [`ComplianceEngine`]: upgradeable transfer-rule engine consulted before
//!   any value movement.
//! - [`NebulaVault`]: yield vault whose allocations are gated on-chain by
//!   fresh, low-risk oracle attestations.

extern crate alloc;

pub mod compliance;
pub mod identity;
pub mod nusd;
pub mod oracle;
pub mod vault;

pub use compliance::ComplianceEngine;
pub use identity::IdentityRegistry;
pub use nusd::NebulaUsd;
pub use oracle::OracleHub;
pub use vault::NebulaVault;
