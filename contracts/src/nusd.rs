//! `NebulaUsd` (nUSD) — the protocol's CEP-18-style settlement asset and the
//! **x402 payment rail**. On top of the standard token surface it implements
//! EIP-3009 `transfer_with_authorization`: a payer signs an EIP-712 typed-data
//! authorization off-chain, and any third party (the x402 facilitator, or an
//! agent acting as its own facilitator) can submit it to move the payer's
//! funds — bounded by a validity window and a single-use nonce.
//!
//! ## EIP-712 digest (must match `@casper-ecosystem/casper-eip-712` exactly)
//!
//! `digest = keccak256(0x19 0x01 || domainSeparator || structHash)`
//!
//! Domain (Casper-native domain types):
//! ```text
//! EIP712Domain(string name,string version,string chain_name,bytes32 contract_package_hash)
//! ```
//!
//! Struct (the x402 `exact` scheme's local type — `uint256` timestamps):
//! ```text
//! TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)
//! ```
//!
//! Field encodings:
//! - `from` / `to`: 33-byte Casper key (`00 || account_hash`) hashed with
//!   keccak256, mirroring `casper-eip-712`'s `encodeAddress`.
//! - `value` / `validAfter` / `validBefore`: 32-byte big-endian `uint256`.
//! - `nonce`: the raw 32 bytes.
//!
//! The domain's `contract_package_hash` is this contract's own package hash at
//! runtime (`self.env().self_address()`), so the on-chain domain is always
//! self-consistent with the asset the facilitator addresses. Verification is
//! Casper-native: the payer's public key is an explicit argument and the host's
//! `verify_signature` (ed25519 / secp256k1) checks the 65-byte
//! `[algo_tag | signature]` payload — no address recovery.

use odra::casper_types::bytesrepr::Bytes;
use odra::casper_types::crypto::PublicKey;
use odra::casper_types::U256;
use odra::prelude::Address;
use odra::prelude::*;
use tiny_keccak::{Hasher, Keccak};

/// CAIP-2 chain name for Casper Testnet, the buildathon network. Used as the
/// EIP-712 domain `chain_name`.
const DEFAULT_CHAIN_NAME: &str = "casper:casper-test";

#[odra::odra_error]
pub enum NusdError {
    InsufficientBalance = 61,
    InsufficientAllowance = 62,
    /// `block_time < valid_after` — the authorization is not yet usable.
    AuthNotYetValid = 63,
    /// `block_time > valid_before` — the authorization has expired.
    AuthExpired = 64,
    /// This `(from, nonce)` authorization was already settled.
    NonceUsed = 65,
    /// The signature does not verify against `from`'s public key, or the
    /// supplied public key does not hash to `from`.
    InvalidSignature = 66,
    /// `nonce` was not exactly 32 bytes.
    InvalidNonce = 67,
}

#[odra::event]
pub struct Transfer {
    pub from: Address,
    pub to: Address,
    pub amount: U256,
}

#[odra::event]
pub struct Approval {
    pub owner: Address,
    pub spender: Address,
    pub amount: U256,
}

/// Emitted when a `transfer_with_authorization` is settled, so indexers can
/// tie an x402 payment to its replay-protection nonce.
#[odra::event]
pub struct AuthorizationUsed {
    pub from: Address,
    pub to: Address,
    pub amount: U256,
    pub nonce: Bytes,
}

#[odra::module(events = [Transfer, Approval, AuthorizationUsed], errors = NusdError)]
pub struct NebulaUsd {
    balances: Mapping<Address, U256>,
    allowances: Mapping<(Address, Address), U256>,
    total_supply: Var<U256>,
    name: Var<String>,
    symbol: Var<String>,
    decimals: Var<u8>,
    chain_name: Var<String>,
    /// `(from, nonce) -> used`. Replay protection for authorizations.
    used_nonces: Mapping<(Address, Bytes), bool>,
}

#[odra::module]
impl NebulaUsd {
    /// Install the token. Mints the initial supply (1,000,000 nUSD at
    /// 9 decimals) to the deployer for demo distribution; `mint` stays open so
    /// testnet actors can self-fund (this is a test asset, not a mainnet one).
    pub fn init(&mut self) {
        let supply = U256::from(1_000_000u64) * U256::from(1_000_000_000u64);
        self.total_supply.set(supply);
        self.balances.set(&self.env().caller(), supply);
        self.name.set("Nebula USD".to_string());
        self.symbol.set("nUSD".to_string());
        self.decimals.set(9);
        self.chain_name.set(DEFAULT_CHAIN_NAME.to_string());
    }

    pub fn name(&self) -> String {
        self.name.get_or_default()
    }

    pub fn symbol(&self) -> String {
        self.symbol.get_or_default()
    }

    pub fn decimals(&self) -> u8 {
        self.decimals.get_or_default()
    }

    /// EIP-712 domain `version`. Fixed at `"1"`; the off-chain side passes this
    /// in `PaymentRequirements.extra.version`.
    pub fn version(&self) -> String {
        "1".to_string()
    }

    /// EIP-712 domain `chain_name` (CAIP-2), e.g. `casper:casper-test`.
    pub fn chain_name(&self) -> String {
        self.chain_name.get_or_default()
    }

    pub fn total_supply(&self) -> U256 {
        self.total_supply.get_or_default()
    }

    pub fn balance_of(&self, owner: Address) -> U256 {
        self.balances.get_or_default(&owner)
    }

    pub fn allowance(&self, owner: Address, spender: Address) -> U256 {
        self.allowances.get_or_default(&(owner, spender))
    }

    /// Whether a `(from, nonce)` authorization has already been settled.
    pub fn authorization_used(&self, from: Address, nonce: Bytes) -> bool {
        self.used_nonces.get_or_default(&(from, nonce))
    }

    /// Mint `amount` new tokens to `to` (open on testnet: demo faucet).
    pub fn mint(&mut self, to: Address, amount: U256) {
        self.total_supply
            .set(self.total_supply.get_or_default() + amount);
        self.balances
            .set(&to, self.balances.get_or_default(&to) + amount);
        self.env().emit_event(Transfer {
            from: to,
            to,
            amount,
        });
    }

    /// Transfer `amount` from the caller to `recipient`.
    pub fn transfer(&mut self, recipient: Address, amount: U256) {
        let from = self.env().caller();
        self.do_transfer(from, recipient, amount);
    }

    /// Approve `spender` to move up to `amount` of the caller's tokens.
    pub fn approve(&mut self, spender: Address, amount: U256) {
        let owner = self.env().caller();
        self.allowances.set(&(owner, spender), amount);
        self.env().emit_event(Approval {
            owner,
            spender,
            amount,
        });
    }

    /// Move `amount` from `owner` to `recipient` using the caller's allowance.
    /// This is how the vault pulls deposits.
    pub fn transfer_from(&mut self, owner: Address, recipient: Address, amount: U256) {
        let spender = self.env().caller();
        let allowed = self.allowances.get_or_default(&(owner, spender));
        if allowed < amount {
            self.env().revert(NusdError::InsufficientAllowance);
        }
        self.allowances.set(&(owner, spender), allowed - amount);
        self.do_transfer(owner, recipient, amount);
    }

    /// **EIP-3009.** Settle an off-chain-authorized transfer. Anyone (the x402
    /// facilitator) may call this; funds move only if the EIP-712 signature
    /// over the canonical digest verifies against `from`'s `public_key`.
    ///
    /// Arg names/types match what `@make-software/casper-x402` builds:
    /// - `from` / `to`: account-hash `Key`s (payer / payee).
    /// - `amount`: `U256` — the x402 message field `value`.
    /// - `valid_after` / `valid_before`: unix seconds.
    /// - `nonce`: 32 replay-protection bytes.
    /// - `public_key`: the payer's Casper public key.
    /// - `signature`: 65 bytes, `[algo_tag | 64-byte signature]`.
    #[allow(clippy::too_many_arguments)]
    pub fn transfer_with_authorization(
        &mut self,
        from: Address,
        to: Address,
        amount: U256,
        valid_after: u64,
        valid_before: u64,
        nonce: Bytes,
        public_key: PublicKey,
        signature: Bytes,
    ) {
        if nonce.len() != 32 {
            self.env().revert(NusdError::InvalidNonce);
        }

        // Validity window (unix seconds). Block time is unix-epoch millis.
        let now = self.env().get_block_time_secs();
        if now < valid_after {
            self.env().revert(NusdError::AuthNotYetValid);
        }
        if now > valid_before {
            self.env().revert(NusdError::AuthExpired);
        }

        // Single-use nonce, scoped to the payer.
        let nonce_key = (from, nonce.clone());
        if self.used_nonces.get_or_default(&nonce_key) {
            self.env().revert(NusdError::NonceUsed);
        }

        // The public key must be `from`'s, and it must have signed the digest.
        let signer: Address = public_key.clone().into();
        if signer != from {
            self.env().revert(NusdError::InvalidSignature);
        }
        let digest = self.transfer_with_authorization_digest(
            from,
            to,
            amount,
            valid_after,
            valid_before,
            &nonce,
        );
        let digest_bytes = Bytes::from(digest.to_vec());
        if !self
            .env()
            .verify_signature(&digest_bytes, &signature, &public_key)
        {
            self.env().revert(NusdError::InvalidSignature);
        }

        // All checks passed: mark the nonce used, then move the funds.
        self.used_nonces.set(&nonce_key, true);
        self.do_transfer(from, to, amount);
        self.env().emit_event(AuthorizationUsed {
            from,
            to,
            amount,
            nonce,
        });
    }

    /// Rebuild the EIP-712 digest for a `TransferWithAuthorization` exactly as
    /// `@casper-ecosystem/casper-eip-712` `hashTypedData(...)` produces it for
    /// the x402 `exact` scheme. Pure; no state read except the domain inputs.
    pub fn transfer_with_authorization_digest(
        &self,
        from: Address,
        to: Address,
        amount: U256,
        valid_after: u64,
        valid_before: u64,
        nonce: &Bytes,
    ) -> [u8; 32] {
        let domain_separator = self.domain_separator();
        let struct_hash = transfer_with_authorization_struct_hash(
            from,
            to,
            amount,
            valid_after,
            valid_before,
            nonce,
        );

        // keccak256(0x19 || 0x01 || domainSeparator || structHash)
        let mut buf = Vec::with_capacity(2 + 32 + 32);
        buf.push(0x19);
        buf.push(0x01);
        buf.extend_from_slice(&domain_separator);
        buf.extend_from_slice(&struct_hash);
        keccak256(&buf)
    }

    // --- internal -------------------------------------------------------

    fn do_transfer(&mut self, from: Address, to: Address, amount: U256) {
        let from_balance = self.balances.get_or_default(&from);
        if from_balance < amount {
            self.env().revert(NusdError::InsufficientBalance);
        }
        self.balances.set(&from, from_balance - amount);
        self.balances
            .set(&to, self.balances.get_or_default(&to) + amount);
        self.env().emit_event(Transfer { from, to, amount });
    }

    /// EIP-712 domain separator for the Casper-native domain. The
    /// `contract_package_hash` is this contract's own package hash.
    fn domain_separator(&self) -> [u8; 32] {
        // The address `value()` is the 32-byte package hash for a contract.
        let package_hash: [u8; 32] = self.env().self_address().value();
        domain_separator(
            &self.name(),
            &self.version(),
            &self.chain_name(),
            &package_hash,
        )
    }
}

/// `keccak256` of `data`.
fn keccak256(data: &[u8]) -> [u8; 32] {
    let mut out = [0u8; 32];
    let mut hasher = Keccak::v256();
    hasher.update(data);
    hasher.finalize(&mut out);
    out
}

/// EIP-712 `encodeAddress` for a Casper 33-byte key:
/// `keccak256(00 || account_hash)` — the account-hash key tag plus hash, as
/// `casper-eip-712` encodes any 33-byte address input.
fn encode_casper_address(address: Address) -> [u8; 32] {
    let mut input = [0u8; 33];
    input[1..].copy_from_slice(&address.value());
    keccak256(&input)
}

/// EIP-712 `uint256` encoding: 32-byte big-endian.
fn encode_uint256(value: U256) -> [u8; 32] {
    let mut out = [0u8; 32];
    value.to_big_endian(&mut out);
    out
}

/// The EIP-712 struct hash for `TransferWithAuthorization`.
fn transfer_with_authorization_struct_hash(
    from: Address,
    to: Address,
    amount: U256,
    valid_after: u64,
    valid_before: u64,
    nonce: &Bytes,
) -> [u8; 32] {
    let type_hash = keccak256(
        b"TransferWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)",
    );

    let mut buf = Vec::with_capacity(32 * 7);
    buf.extend_from_slice(&type_hash);
    buf.extend_from_slice(&encode_casper_address(from));
    buf.extend_from_slice(&encode_casper_address(to));
    buf.extend_from_slice(&encode_uint256(amount));
    buf.extend_from_slice(&encode_uint256(U256::from(valid_after)));
    buf.extend_from_slice(&encode_uint256(U256::from(valid_before)));
    buf.extend_from_slice(nonce.as_slice());
    keccak256(&buf)
}

/// The EIP-712 domain separator for the Casper-native domain types.
fn domain_separator(
    name: &str,
    version: &str,
    chain_name: &str,
    contract_package_hash: &[u8; 32],
) -> [u8; 32] {
    let type_hash = keccak256(
        b"EIP712Domain(string name,string version,string chain_name,bytes32 contract_package_hash)",
    );

    let mut buf = Vec::with_capacity(32 * 5);
    buf.extend_from_slice(&type_hash);
    buf.extend_from_slice(&keccak256(name.as_bytes()));
    buf.extend_from_slice(&keccak256(version.as_bytes()));
    buf.extend_from_slice(&keccak256(chain_name.as_bytes()));
    buf.extend_from_slice(contract_package_hash);
    keccak256(&buf)
}

#[cfg(test)]
mod tests {
    use super::*;
    use odra::casper_types::bytesrepr::ToBytes;
    use odra::casper_types::crypto::{sign, SecretKey};
    use odra::host::{Deployer, NoArgs};

    fn supply() -> U256 {
        U256::from(1_000_000u64) * U256::from(1_000_000_000u64)
    }

    /// A deterministic ed25519 keypair whose account-hash `Address` we can fund.
    fn payer_keypair() -> (SecretKey, PublicKey, Address) {
        let secret = SecretKey::ed25519_from_bytes([7u8; 32]).unwrap();
        let public = PublicKey::from(&secret);
        let address = Address::from(public.clone());
        (secret, public, address)
    }

    fn nonce32(seed: u8) -> Bytes {
        Bytes::from(vec![seed; 32])
    }

    #[test]
    fn metadata_and_initial_supply() {
        let env = odra_test::env();
        let token = NebulaUsd::deploy(&env, NoArgs);
        assert_eq!(token.name(), "Nebula USD");
        assert_eq!(token.symbol(), "nUSD");
        assert_eq!(token.decimals(), 9);
        assert_eq!(token.version(), "1");
        assert_eq!(token.chain_name(), "casper:casper-test");
        assert_eq!(token.total_supply(), supply());
        assert_eq!(token.balance_of(env.get_account(0)), supply());
    }

    #[test]
    fn transfer_and_mint() {
        let env = odra_test::env();
        let mut token = NebulaUsd::deploy(&env, NoArgs);
        let deployer = env.get_account(0);
        let other = env.get_account(1);

        env.set_caller(deployer);
        token.transfer(other, U256::from(500u64));
        assert_eq!(token.balance_of(other), U256::from(500u64));
        assert_eq!(token.balance_of(deployer), supply() - U256::from(500u64));

        token.mint(other, U256::from(50u64));
        assert_eq!(token.balance_of(other), U256::from(550u64));
    }

    #[test]
    fn transfer_over_balance_reverts() {
        let env = odra_test::env();
        let mut token = NebulaUsd::deploy(&env, NoArgs);
        let other = env.get_account(1);
        env.set_caller(other);
        assert_eq!(
            token
                .try_transfer(env.get_account(0), U256::from(1u64))
                .unwrap_err(),
            NusdError::InsufficientBalance.into()
        );
    }

    #[test]
    fn approve_and_transfer_from() {
        let env = odra_test::env();
        let mut token = NebulaUsd::deploy(&env, NoArgs);
        let owner = env.get_account(0);
        let spender = env.get_account(1);
        let recipient = env.get_account(2);

        env.set_caller(owner);
        token.approve(spender, U256::from(300u64));
        assert_eq!(token.allowance(owner, spender), U256::from(300u64));

        env.set_caller(spender);
        token.transfer_from(owner, recipient, U256::from(200u64));
        assert_eq!(token.balance_of(recipient), U256::from(200u64));
        assert_eq!(token.allowance(owner, spender), U256::from(100u64));

        // Exceeding the remaining allowance reverts.
        assert_eq!(
            token
                .try_transfer_from(owner, recipient, U256::from(101u64))
                .unwrap_err(),
            NusdError::InsufficientAllowance.into()
        );
    }

    #[test]
    fn transfer_with_authorization_happy_path() {
        let env = odra_test::env();
        let mut token = NebulaUsd::deploy(&env, NoArgs);
        let deployer = env.get_account(0);
        let facilitator = env.get_account(2);

        let (secret, public, payer) = payer_keypair();
        let payee = env.get_account(1);

        env.set_caller(deployer);
        token.transfer(payer, U256::from(1_000u64));

        let amount = U256::from(250u64);
        let valid_after = 0u64;
        let valid_before = 10_000_000_000u64; // far future
        let nonce = nonce32(1);

        let digest = token.transfer_with_authorization_digest(
            payer,
            payee,
            amount,
            valid_after,
            valid_before,
            &nonce,
        );
        let signature = sign(digest, &secret, &public);
        let sig_bytes = Bytes::from(signature.to_bytes().unwrap());

        // Anyone (the facilitator) may submit; funds still move from the payer.
        env.set_caller(facilitator);
        token.transfer_with_authorization(
            payer,
            payee,
            amount,
            valid_after,
            valid_before,
            nonce.clone(),
            public.clone(),
            sig_bytes,
        );

        assert_eq!(token.balance_of(payee), U256::from(250u64));
        assert_eq!(token.balance_of(payer), U256::from(750u64));
        assert!(token.authorization_used(payer, nonce));
    }

    #[test]
    fn transfer_with_authorization_rejects_reused_nonce() {
        let env = odra_test::env();
        let mut token = NebulaUsd::deploy(&env, NoArgs);
        let deployer = env.get_account(0);
        let (secret, public, payer) = payer_keypair();
        let payee = env.get_account(1);

        env.set_caller(deployer);
        token.transfer(payer, U256::from(1_000u64));

        let amount = U256::from(100u64);
        let nonce = nonce32(2);
        let digest = token.transfer_with_authorization_digest(
            payer,
            payee,
            amount,
            0,
            10_000_000_000,
            &nonce,
        );
        let sig_bytes = Bytes::from(sign(digest, &secret, &public).to_bytes().unwrap());

        token.transfer_with_authorization(
            payer,
            payee,
            amount,
            0,
            10_000_000_000,
            nonce.clone(),
            public.clone(),
            sig_bytes.clone(),
        );

        let err = token
            .try_transfer_with_authorization(
                payer,
                payee,
                amount,
                0,
                10_000_000_000,
                nonce,
                public,
                sig_bytes,
            )
            .unwrap_err();
        assert_eq!(err, NusdError::NonceUsed.into());
    }

    #[test]
    fn transfer_with_authorization_rejects_tampered_amount() {
        let env = odra_test::env();
        let mut token = NebulaUsd::deploy(&env, NoArgs);
        let deployer = env.get_account(0);
        let (secret, public, payer) = payer_keypair();
        let payee = env.get_account(1);

        env.set_caller(deployer);
        token.transfer(payer, U256::from(1_000u64));

        let nonce = nonce32(3);
        // Sign a DIFFERENT amount than the one submitted -> digest mismatch.
        let bad_digest = token.transfer_with_authorization_digest(
            payer,
            payee,
            U256::from(999u64),
            0,
            10_000_000_000,
            &nonce,
        );
        let sig_bytes = Bytes::from(sign(bad_digest, &secret, &public).to_bytes().unwrap());

        let err = token
            .try_transfer_with_authorization(
                payer,
                payee,
                U256::from(100u64),
                0,
                10_000_000_000,
                nonce,
                public,
                sig_bytes,
            )
            .unwrap_err();
        assert_eq!(err, NusdError::InvalidSignature.into());
    }

    #[test]
    fn transfer_with_authorization_rejects_expired() {
        let env = odra_test::env();
        let mut token = NebulaUsd::deploy(&env, NoArgs);
        let deployer = env.get_account(0);
        let (secret, public, payer) = payer_keypair();
        let payee = env.get_account(1);

        env.set_caller(deployer);
        token.transfer(payer, U256::from(1_000u64));

        env.advance_block_time(20_000); // ms → block time 20s
        let nonce = nonce32(4);
        let valid_before = 1u64; // long expired
        let digest = token.transfer_with_authorization_digest(
            payer,
            payee,
            U256::from(100u64),
            0,
            valid_before,
            &nonce,
        );
        let sig_bytes = Bytes::from(sign(digest, &secret, &public).to_bytes().unwrap());

        let err = token
            .try_transfer_with_authorization(
                payer,
                payee,
                U256::from(100u64),
                0,
                valid_before,
                nonce,
                public,
                sig_bytes,
            )
            .unwrap_err();
        assert_eq!(err, NusdError::AuthExpired.into());
    }
}
