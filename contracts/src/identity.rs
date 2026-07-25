//! `IdentityRegistry` — ERC-3643-style on-chain identity, shared by two kinds
//! of subjects:
//!
//! - **Investors**: compliance claims (verified flag + ISO-3166 numeric country
//!   code + claim URI) issued by *trusted issuers*. The [`crate::ComplianceEngine`]
//!   consults these claims before any vault value movement.
//! - **Oracle agents**: the same registry anchors the identity that the
//!   [`crate::OracleHub`] requires before an agent may attest.
//!
//! Mirrors the T-REX split of registry vs. issuers: the registry `owner`
//! manages the trusted-issuer set; issuers manage identity claims. Both roles
//! are plain `Address`es, so an issuer can itself be a contract.

use odra::prelude::Address;
use odra::prelude::*;

/// ISO-3166 numeric country code. `u32` because Casper's `CLTyped` has no
/// 16-bit integer type.
pub type CountryCode = u32;

#[odra::odra_error]
pub enum IdentityError {
    NotOwner = 1,
    NotIssuer = 2,
}

#[odra::event]
pub struct IssuerAdded {
    pub issuer: Address,
}

#[odra::event]
pub struct IssuerRemoved {
    pub issuer: Address,
}

#[odra::event]
pub struct IdentityRegistered {
    pub subject: Address,
    pub issuer: Address,
    pub country: u32,
    pub claim_uri: String,
}

#[odra::event]
pub struct IdentityRevoked {
    pub subject: Address,
    pub issuer: Address,
}

#[odra::module(
    events = [IssuerAdded, IssuerRemoved, IdentityRegistered, IdentityRevoked],
    errors = IdentityError
)]
pub struct IdentityRegistry {
    owner: Var<Address>,
    issuers: Mapping<Address, bool>,
    verified: Mapping<Address, bool>,
    /// ISO-3166 numeric country code of the verified subject (0 = unset).
    countries: Mapping<Address, u32>,
    /// URI of the off-chain claim evidence (KYC attestation, agent card, ...).
    claim_uris: Mapping<Address, String>,
    total_identities: Var<u64>,
}

#[odra::module]
impl IdentityRegistry {
    /// Install the registry. The deployer becomes `owner` and the first
    /// trusted issuer.
    pub fn init(&mut self) {
        let deployer = self.env().caller();
        self.owner.set(deployer);
        self.issuers.set(&deployer, true);
        self.env().emit_event(IssuerAdded { issuer: deployer });
    }

    pub fn owner(&self) -> Address {
        self.owner.get_or_revert_with(IdentityError::NotOwner)
    }

    /// Add a trusted issuer. Owner only.
    pub fn add_issuer(&mut self, issuer: Address) {
        self.assert_owner();
        self.issuers.set(&issuer, true);
        self.env().emit_event(IssuerAdded { issuer });
    }

    /// Remove a trusted issuer. Owner only.
    pub fn remove_issuer(&mut self, issuer: Address) {
        self.assert_owner();
        self.issuers.set(&issuer, false);
        self.env().emit_event(IssuerRemoved { issuer });
    }

    pub fn is_issuer(&self, address: Address) -> bool {
        self.issuers.get_or_default(&address)
    }

    /// Register (or refresh) a verified identity for `subject`. Issuer only.
    pub fn register_identity(&mut self, subject: Address, country: u32, claim_uri: String) {
        let issuer = self.assert_issuer();
        if !self.verified.get_or_default(&subject) {
            self.total_identities
                .set(self.total_identities.get_or_default() + 1);
        }
        self.verified.set(&subject, true);
        self.countries.set(&subject, country);
        self.claim_uris.set(&subject, claim_uri.clone());
        self.env().emit_event(IdentityRegistered {
            subject,
            issuer,
            country,
            claim_uri,
        });
    }

    /// Revoke `subject`'s verification. Issuer only.
    pub fn revoke_identity(&mut self, subject: Address) {
        let issuer = self.assert_issuer();
        if self.verified.get_or_default(&subject) {
            self.total_identities
                .set(self.total_identities.get_or_default() - 1);
        }
        self.verified.set(&subject, false);
        self.env().emit_event(IdentityRevoked { subject, issuer });
    }

    /// The compliance primitive: is `subject` currently verified?
    pub fn is_verified(&self, subject: Address) -> bool {
        self.verified.get_or_default(&subject)
    }

    /// Full identity view: (verified, country code, claim URI).
    pub fn identity(&self, subject: Address) -> (bool, u32, String) {
        (
            self.verified.get_or_default(&subject),
            self.countries.get_or_default(&subject),
            self.claim_uris.get_or_default(&subject),
        )
    }

    pub fn total_identities(&self) -> u64 {
        self.total_identities.get_or_default()
    }

    // --- internal -------------------------------------------------------

    fn assert_owner(&self) {
        if self.env().caller() != self.owner() {
            self.env().revert(IdentityError::NotOwner);
        }
    }

    fn assert_issuer(&self) -> Address {
        let caller = self.env().caller();
        if !self.issuers.get_or_default(&caller) {
            self.env().revert(IdentityError::NotIssuer);
        }
        caller
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use odra::host::{Deployer, NoArgs};

    #[test]
    fn deployer_is_owner_and_issuer() {
        let env = odra_test::env();
        let reg = IdentityRegistry::deploy(&env, NoArgs);
        assert_eq!(reg.owner(), env.get_account(0));
        assert!(reg.is_issuer(env.get_account(0)));
    }

    #[test]
    fn issuer_registers_and_revokes_identity() {
        let env = odra_test::env();
        let mut reg = IdentityRegistry::deploy(&env, NoArgs);
        let investor = env.get_account(1);

        env.set_caller(env.get_account(0));
        reg.register_identity(investor, 360, "ipfs://kyc/1".to_string());
        assert!(reg.is_verified(investor));
        assert_eq!(
            reg.identity(investor),
            (true, 360, "ipfs://kyc/1".to_string())
        );
        assert_eq!(reg.total_identities(), 1);

        reg.revoke_identity(investor);
        assert!(!reg.is_verified(investor));
        assert_eq!(reg.total_identities(), 0);
    }

    #[test]
    fn non_issuer_cannot_register() {
        let env = odra_test::env();
        let mut reg = IdentityRegistry::deploy(&env, NoArgs);
        env.set_caller(env.get_account(2));
        assert_eq!(
            reg.try_register_identity(env.get_account(1), 360, "uri".to_string())
                .unwrap_err(),
            IdentityError::NotIssuer.into()
        );
    }

    #[test]
    fn owner_manages_issuers() {
        let env = odra_test::env();
        let mut reg = IdentityRegistry::deploy(&env, NoArgs);
        let owner = env.get_account(0);
        let issuer = env.get_account(1);
        let investor = env.get_account(2);

        env.set_caller(owner);
        reg.add_issuer(issuer);
        assert!(reg.is_issuer(issuer));

        env.set_caller(issuer);
        reg.register_identity(investor, 458, "uri".to_string());
        assert!(reg.is_verified(investor));

        env.set_caller(owner);
        reg.remove_issuer(issuer);

        env.set_caller(issuer);
        assert_eq!(
            reg.try_register_identity(investor, 458, "uri".to_string())
                .unwrap_err(),
            IdentityError::NotIssuer.into()
        );
    }

    #[test]
    fn non_owner_cannot_add_issuer() {
        let env = odra_test::env();
        let mut reg = IdentityRegistry::deploy(&env, NoArgs);
        env.set_caller(env.get_account(1));
        assert_eq!(
            reg.try_add_issuer(env.get_account(1)).unwrap_err(),
            IdentityError::NotOwner.into()
        );
    }
}
