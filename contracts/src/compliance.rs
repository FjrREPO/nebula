//! `ComplianceEngine` — the ERC-3643-style transfer-rule engine.
//!
//! Every value movement in the vault (deposits, share transfers) is checked
//! against `can_transfer(from, to, amount)` **on-chain**, which consults the
//! [`crate::IdentityRegistry`] and this engine's rule set. The engine is
//! deployed **upgradable** (Casper contract-package versioning), which is the
//! point: when regulation changes, the rules evolve *without reissuing the
//! asset or migrating a single holder* — Casper's core RWA pitch.
//!
//! Rules kept deliberately small and auditable:
//! - `paused`: global halt.
//! - `require_verified`: both parties must hold a verified identity.
//! - `max_transfer`: per-transfer amount ceiling (0 = unlimited).

use odra::casper_types::U256;
use odra::prelude::Address;
use odra::prelude::*;

use odra::ContractRef;

use crate::identity::IdentityRegistryContractRef;

#[odra::odra_error]
pub enum ComplianceError {
    NotOwner = 41,
}

#[odra::event]
pub struct RulesUpdated {
    pub paused: bool,
    pub require_verified: bool,
    pub max_transfer: U256,
}

#[odra::module(events = [RulesUpdated], errors = ComplianceError)]
pub struct ComplianceEngine {
    owner: Var<Address>,
    identity_registry: Var<Address>,
    paused: Var<bool>,
    require_verified: Var<bool>,
    /// Per-transfer ceiling; zero disables the rule.
    max_transfer: Var<U256>,
}

#[odra::module]
impl ComplianceEngine {
    /// Install the engine wired to an identity registry. Starts unpaused with
    /// identity verification required and no amount ceiling.
    pub fn init(&mut self, identity_registry: Address) {
        self.owner.set(self.env().caller());
        self.identity_registry.set(identity_registry);
        self.paused.set(false);
        self.require_verified.set(true);
        self.max_transfer.set(U256::zero());
    }

    pub fn owner(&self) -> Address {
        self.owner.get_or_revert_with(ComplianceError::NotOwner)
    }

    pub fn identity_registry(&self) -> Address {
        self.identity_registry
            .get_or_revert_with(ComplianceError::NotOwner)
    }

    /// Update the rule set. Owner only.
    pub fn set_rules(&mut self, paused: bool, require_verified: bool, max_transfer: U256) {
        if self.env().caller() != self.owner() {
            self.env().revert(ComplianceError::NotOwner);
        }
        self.paused.set(paused);
        self.require_verified.set(require_verified);
        self.max_transfer.set(max_transfer);
        self.env().emit_event(RulesUpdated {
            paused,
            require_verified,
            max_transfer,
        });
    }

    /// The ERC-3643 primitive: may `amount` move from `from` to `to`?
    /// Pure view — callers (the vault) revert on `false`.
    pub fn can_transfer(&self, from: Address, to: Address, amount: U256) -> bool {
        if self.paused.get_or_default() {
            return false;
        }
        let ceiling = self.max_transfer.get_or_default();
        if !ceiling.is_zero() && amount > ceiling {
            return false;
        }
        if self.require_verified.get_or_default() {
            let registry = IdentityRegistryContractRef::new(self.env(), self.identity_registry());
            if !registry.is_verified(from) || !registry.is_verified(to) {
                return false;
            }
        }
        true
    }

    /// Current rule set: (paused, require_verified, max_transfer).
    pub fn rules(&self) -> (bool, bool, U256) {
        (
            self.paused.get_or_default(),
            self.require_verified.get_or_default(),
            self.max_transfer.get_or_default(),
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::IdentityRegistry;
    use odra::host::{Deployer, NoArgs};

    fn setup() -> (
        odra::host::HostEnv,
        crate::identity::IdentityRegistryHostRef,
        ComplianceEngineHostRef,
    ) {
        let env = odra_test::env();
        let identity = IdentityRegistry::deploy(&env, NoArgs);
        let engine = ComplianceEngine::deploy(
            &env,
            ComplianceEngineInitArgs {
                identity_registry: identity.address(),
            },
        );
        (env, identity, engine)
    }

    #[test]
    fn verified_parties_pass_unverified_fail() {
        let (env, mut identity, engine) = setup();
        let alice = env.get_account(1);
        let bob = env.get_account(2);

        env.set_caller(env.get_account(0));
        identity.register_identity(alice, 360, "uri".to_string());

        // Bob is not verified → blocked both directions.
        assert!(!engine.can_transfer(alice, bob, U256::from(10u64)));
        assert!(!engine.can_transfer(bob, alice, U256::from(10u64)));

        identity.register_identity(bob, 458, "uri".to_string());
        assert!(engine.can_transfer(alice, bob, U256::from(10u64)));
    }

    #[test]
    fn pause_blocks_everything() {
        let (env, mut identity, mut engine) = setup();
        let alice = env.get_account(1);
        env.set_caller(env.get_account(0));
        identity.register_identity(alice, 360, "uri".to_string());

        engine.set_rules(true, true, U256::zero());
        assert!(!engine.can_transfer(alice, alice, U256::from(1u64)));

        engine.set_rules(false, true, U256::zero());
        assert!(engine.can_transfer(alice, alice, U256::from(1u64)));
    }

    #[test]
    fn max_transfer_ceiling_applies() {
        let (env, mut identity, mut engine) = setup();
        let alice = env.get_account(1);
        env.set_caller(env.get_account(0));
        identity.register_identity(alice, 360, "uri".to_string());

        engine.set_rules(false, true, U256::from(100u64));
        assert!(engine.can_transfer(alice, alice, U256::from(100u64)));
        assert!(!engine.can_transfer(alice, alice, U256::from(101u64)));
    }

    #[test]
    fn rules_update_is_owner_only() {
        let (env, _identity, mut engine) = setup();
        env.set_caller(env.get_account(1));
        assert_eq!(
            engine.try_set_rules(true, true, U256::zero()).unwrap_err(),
            ComplianceError::NotOwner.into()
        );
    }

    #[test]
    fn verification_can_be_waived() {
        let (env, _identity, mut engine) = setup();
        let stranger_a = env.get_account(3);
        let stranger_b = env.get_account(4);

        env.set_caller(env.get_account(0));
        engine.set_rules(false, false, U256::zero());
        assert!(engine.can_transfer(stranger_a, stranger_b, U256::from(1u64)));
    }
}
