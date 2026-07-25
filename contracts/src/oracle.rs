//! `OracleHub` — the trust-minimized RWA oracle layer.
//!
//! Oracle agents (holding a verified [`crate::IdentityRegistry`] identity)
//! publish **risk attestations** for real-world assets: a 0..=100 risk score
//! plus a keccak/blake hash of the underlying report and a URI where the
//! x402-paywalled report can be bought. Each attestation is later **resolved**
//! (accurate / inaccurate) by the protocol adjudicator, building a public,
//! on-chain **accuracy track record** per oracle:
//!
//! `reputation_bps = accurate / resolved * 10_000`
//!
//! Consumers ([`crate::NebulaVault`]) read the latest attestation per asset and
//! enforce freshness + risk bounds *on-chain* — an oracle with a decaying
//! track record simply stops being economically relevant. The model proposes;
//! code disposes.

use odra::prelude::Address;
use odra::prelude::*;

use odra::ContractRef;

use crate::identity::IdentityRegistryContractRef;

#[odra::odra_error]
pub enum OracleError {
    NotOwner = 21,
    /// The caller's address is already bound to an oracle id.
    AlreadyRegistered = 22,
    /// The caller is not a registered oracle agent.
    NotRegisteredOracle = 23,
    /// The caller's address holds no verified identity in the registry.
    IdentityNotVerified = 24,
    UnknownAttestation = 25,
    AlreadyResolved = 26,
    /// Risk score must be 0..=100.
    ScoreOutOfRange = 27,
    UnknownOracle = 28,
}

/// A single on-chain risk attestation for an asset.
#[odra::odra_type]
pub struct Attestation {
    pub oracle_id: u64,
    /// Protocol-level asset identifier, e.g. `"INV-2026-0007"`.
    pub asset_id: String,
    /// 0 (safest) ..= 100 (riskiest).
    pub risk_score: u8,
    /// Hash of the full off-chain risk report (integrity anchor).
    pub data_hash: String,
    /// Where the paywalled report is served (x402 endpoint).
    pub report_uri: String,
    /// Block time (unix millis) at attestation.
    pub attested_at: u64,
    pub resolved: bool,
    pub accurate: bool,
}

#[odra::event]
pub struct OracleRegistered {
    pub oracle_id: u64,
    pub oracle: Address,
    pub metadata_uri: String,
}

#[odra::event]
pub struct RiskAttested {
    pub attestation_id: u64,
    pub oracle_id: u64,
    pub asset_id: String,
    pub risk_score: u8,
    pub data_hash: String,
}

#[odra::event]
pub struct AttestationResolved {
    pub attestation_id: u64,
    pub oracle_id: u64,
    pub accurate: bool,
}

#[odra::module(
    events = [OracleRegistered, RiskAttested, AttestationResolved],
    errors = OracleError
)]
pub struct OracleHub {
    owner: Var<Address>,
    identity_registry: Var<Address>,
    total_oracles: Var<u64>,
    total_attestations: Var<u64>,
    /// Operational address → oracle id (0 = none).
    oracle_id_by_address: Mapping<Address, u64>,
    oracle_addresses: Mapping<u64, Option<Address>>,
    oracle_uris: Mapping<u64, String>,
    attestations: Mapping<u64, Option<Attestation>>,
    /// Latest attestation id per asset (0 = none).
    latest_by_asset: Mapping<String, u64>,
    /// Per-oracle counters backing the reputation score.
    attested_count: Mapping<u64, u64>,
    resolved_count: Mapping<u64, u64>,
    accurate_count: Mapping<u64, u64>,
}

#[odra::module]
impl OracleHub {
    /// Install the hub, wiring the identity registry that gates oracle
    /// registration. The deployer becomes the adjudicating `owner`.
    pub fn init(&mut self, identity_registry: Address) {
        self.owner.set(self.env().caller());
        self.identity_registry.set(identity_registry);
    }

    pub fn owner(&self) -> Address {
        self.owner.get_or_revert_with(OracleError::NotOwner)
    }

    pub fn identity_registry(&self) -> Address {
        self.identity_registry
            .get_or_revert_with(OracleError::NotOwner)
    }

    /// Register the caller as an oracle agent. Requires a verified identity in
    /// the [`crate::IdentityRegistry`] — anonymous oracles cannot attest.
    pub fn register_oracle(&mut self, metadata_uri: String) -> u64 {
        let oracle = self.env().caller();
        if self.oracle_id_by_address.get_or_default(&oracle) != 0 {
            self.env().revert(OracleError::AlreadyRegistered);
        }
        let registry = IdentityRegistryContractRef::new(self.env(), self.identity_registry());
        if !registry.is_verified(oracle) {
            self.env().revert(OracleError::IdentityNotVerified);
        }

        let oracle_id = self.total_oracles.get_or_default() + 1;
        self.total_oracles.set(oracle_id);
        self.oracle_id_by_address.set(&oracle, oracle_id);
        self.oracle_addresses.set(&oracle_id, Some(oracle));
        self.oracle_uris.set(&oracle_id, metadata_uri.clone());
        self.env().emit_event(OracleRegistered {
            oracle_id,
            oracle,
            metadata_uri,
        });
        oracle_id
    }

    /// Publish a risk attestation for `asset_id`. Registered oracles only.
    /// Returns the attestation id and marks it the asset's latest.
    pub fn attest(
        &mut self,
        asset_id: String,
        risk_score: u8,
        data_hash: String,
        report_uri: String,
    ) -> u64 {
        if risk_score > 100 {
            self.env().revert(OracleError::ScoreOutOfRange);
        }
        let oracle = self.env().caller();
        let oracle_id = self.oracle_id_by_address.get_or_default(&oracle);
        if oracle_id == 0 {
            self.env().revert(OracleError::NotRegisteredOracle);
        }

        let attestation_id = self.total_attestations.get_or_default() + 1;
        self.total_attestations.set(attestation_id);
        self.attestations.set(
            &attestation_id,
            Some(Attestation {
                oracle_id,
                asset_id: asset_id.clone(),
                risk_score,
                data_hash: data_hash.clone(),
                report_uri,
                attested_at: self.env().get_block_time(),
                resolved: false,
                accurate: false,
            }),
        );
        self.latest_by_asset.set(&asset_id, attestation_id);
        self.attested_count.set(
            &oracle_id,
            self.attested_count.get_or_default(&oracle_id) + 1,
        );
        self.env().emit_event(RiskAttested {
            attestation_id,
            oracle_id,
            asset_id,
            risk_score,
            data_hash,
        });
        attestation_id
    }

    /// Adjudicate an attestation as accurate / inaccurate. Owner only, once
    /// per attestation. This is what turns attestations into a track record.
    pub fn resolve(&mut self, attestation_id: u64, accurate: bool) {
        if self.env().caller() != self.owner() {
            self.env().revert(OracleError::NotOwner);
        }
        let mut attestation = self
            .attestations
            .get(&attestation_id)
            .flatten()
            .unwrap_or_revert_with(&self.env(), OracleError::UnknownAttestation);
        if attestation.resolved {
            self.env().revert(OracleError::AlreadyResolved);
        }
        attestation.resolved = true;
        attestation.accurate = accurate;
        let oracle_id = attestation.oracle_id;
        self.attestations.set(&attestation_id, Some(attestation));

        self.resolved_count.set(
            &oracle_id,
            self.resolved_count.get_or_default(&oracle_id) + 1,
        );
        if accurate {
            self.accurate_count.set(
                &oracle_id,
                self.accurate_count.get_or_default(&oracle_id) + 1,
            );
        }
        self.env().emit_event(AttestationResolved {
            attestation_id,
            oracle_id,
            accurate,
        });
    }

    // --- views ----------------------------------------------------------

    pub fn attestation(&self, attestation_id: u64) -> Attestation {
        self.attestations
            .get(&attestation_id)
            .flatten()
            .unwrap_or_revert_with(&self.env(), OracleError::UnknownAttestation)
    }

    /// Latest attestation id for an asset (0 = none yet).
    pub fn latest_attestation_id(&self, asset_id: String) -> u64 {
        self.latest_by_asset.get_or_default(&asset_id)
    }

    /// Latest attestation for an asset. Reverts if none exists.
    pub fn latest_attestation(&self, asset_id: String) -> Attestation {
        let id = self.latest_by_asset.get_or_default(&asset_id);
        if id == 0 {
            self.env().revert(OracleError::UnknownAttestation);
        }
        self.attestation(id)
    }

    pub fn oracle_id_of(&self, oracle: Address) -> u64 {
        self.oracle_id_by_address.get_or_default(&oracle)
    }

    /// (operational address, metadata URI) of an oracle.
    pub fn oracle(&self, oracle_id: u64) -> (Address, String) {
        let address = self
            .oracle_addresses
            .get(&oracle_id)
            .flatten()
            .unwrap_or_revert_with(&self.env(), OracleError::UnknownOracle);
        (address, self.oracle_uris.get_or_default(&oracle_id))
    }

    /// Raw reputation counters: (attested, resolved, accurate).
    pub fn oracle_stats(&self, oracle_id: u64) -> (u64, u64, u64) {
        (
            self.attested_count.get_or_default(&oracle_id),
            self.resolved_count.get_or_default(&oracle_id),
            self.accurate_count.get_or_default(&oracle_id),
        )
    }

    /// Accuracy-backed reputation in basis points (0..=10_000). Oracles with
    /// no resolved attestations yet score 0 — reputation must be earned.
    pub fn reputation_bps(&self, oracle_id: u64) -> u64 {
        let resolved = self.resolved_count.get_or_default(&oracle_id);
        if resolved == 0 {
            return 0;
        }
        self.accurate_count.get_or_default(&oracle_id) * 10_000 / resolved
    }

    pub fn total_oracles(&self) -> u64 {
        self.total_oracles.get_or_default()
    }

    pub fn total_attestations(&self) -> u64 {
        self.total_attestations.get_or_default()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::identity::IdentityRegistry;
    use odra::host::{Deployer, NoArgs};

    fn setup() -> (odra::host::HostEnv, OracleHubHostRef, Address) {
        let env = odra_test::env();
        let mut identity = IdentityRegistry::deploy(&env, NoArgs);
        let hub = OracleHub::deploy(
            &env,
            OracleHubInitArgs {
                identity_registry: identity.address(),
            },
        );

        // Verify the oracle agent's identity (account 1).
        let oracle = env.get_account(1);
        env.set_caller(env.get_account(0));
        identity.register_identity(oracle, 0, "ipfs://agent-card/risk-oracle".to_string());
        (env, hub, oracle)
    }

    #[test]
    fn register_requires_verified_identity() {
        let (env, mut hub, oracle) = setup();

        // Account 2 has no verified identity.
        env.set_caller(env.get_account(2));
        assert_eq!(
            hub.try_register_oracle("uri".to_string()).unwrap_err(),
            OracleError::IdentityNotVerified.into()
        );

        env.set_caller(oracle);
        let id = hub.register_oracle("ipfs://agent-card/risk-oracle".to_string());
        assert_eq!(id, 1);
        assert_eq!(hub.oracle_id_of(oracle), 1);
        assert_eq!(
            hub.try_register_oracle("uri".to_string()).unwrap_err(),
            OracleError::AlreadyRegistered.into()
        );
    }

    #[test]
    fn attest_and_read_latest() {
        let (env, mut hub, oracle) = setup();
        env.set_caller(oracle);
        hub.register_oracle("uri".to_string());

        let id = hub.attest(
            "INV-2026-0007".to_string(),
            35,
            "blake2b:abc".to_string(),
            "https://oracle.nebula/reports/INV-2026-0007".to_string(),
        );
        assert_eq!(id, 1);

        let attestation = hub.latest_attestation("INV-2026-0007".to_string());
        assert_eq!(attestation.oracle_id, 1);
        assert_eq!(attestation.risk_score, 35);
        assert!(!attestation.resolved);
        assert_eq!(hub.latest_attestation_id("INV-2026-0007".to_string()), 1);

        // A second attestation supersedes the first as "latest".
        let id2 = hub.attest(
            "INV-2026-0007".to_string(),
            40,
            "blake2b:def".to_string(),
            "https://oracle.nebula/reports/INV-2026-0007".to_string(),
        );
        assert_eq!(hub.latest_attestation_id("INV-2026-0007".to_string()), id2);
    }

    #[test]
    fn unregistered_cannot_attest() {
        let (env, mut hub, _oracle) = setup();
        env.set_caller(env.get_account(2));
        assert_eq!(
            hub.try_attest("A".to_string(), 10, "h".to_string(), "u".to_string())
                .unwrap_err(),
            OracleError::NotRegisteredOracle.into()
        );
    }

    #[test]
    fn score_out_of_range_reverts() {
        let (env, mut hub, oracle) = setup();
        env.set_caller(oracle);
        hub.register_oracle("uri".to_string());
        assert_eq!(
            hub.try_attest("A".to_string(), 101, "h".to_string(), "u".to_string())
                .unwrap_err(),
            OracleError::ScoreOutOfRange.into()
        );
    }

    #[test]
    fn resolution_builds_reputation() {
        let (env, mut hub, oracle) = setup();
        env.set_caller(oracle);
        hub.register_oracle("uri".to_string());
        let a1 = hub.attest("A".to_string(), 10, "h1".to_string(), "u".to_string());
        let a2 = hub.attest("B".to_string(), 90, "h2".to_string(), "u".to_string());
        let a3 = hub.attest("C".to_string(), 55, "h3".to_string(), "u".to_string());

        // Only the owner adjudicates.
        assert_eq!(
            hub.try_resolve(a1, true).unwrap_err(),
            OracleError::NotOwner.into()
        );

        env.set_caller(env.get_account(0));
        hub.resolve(a1, true);
        hub.resolve(a2, true);
        hub.resolve(a3, false);

        assert_eq!(hub.oracle_stats(1), (3, 3, 2));
        assert_eq!(hub.reputation_bps(1), 6_666);
        assert_eq!(
            hub.try_resolve(a1, false).unwrap_err(),
            OracleError::AlreadyResolved.into()
        );

        let resolved = hub.attestation(a3);
        assert!(resolved.resolved);
        assert!(!resolved.accurate);
    }

    #[test]
    fn unresolved_oracle_has_zero_reputation() {
        let (env, mut hub, oracle) = setup();
        env.set_caller(oracle);
        hub.register_oracle("uri".to_string());
        hub.attest("A".to_string(), 10, "h".to_string(), "u".to_string());
        assert_eq!(hub.reputation_bps(1), 0);
    }
}
