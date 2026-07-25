#![cfg_attr(not(test), no_std)]
#![cfg_attr(not(test), no_main)]
//! Nebula on-chain contracts for Casper (Odra / Rust → Wasm).

extern crate alloc;

pub mod nusd;

pub use nusd::NebulaUsd;

pub mod identity;

pub use identity::IdentityRegistry;

pub mod oracle;

pub use oracle::OracleHub;
