//! End-to-end protocol integration test.
//!
//! Exercises the full Nebula lifecycle across all five contracts, as the live
//! system runs it on testnet: identity issuance → oracle registration →
//! attestations → risk-gated allocation → settlement with premium → yield
//! withdrawal → reputation resolution → compliance rule changes mid-flight.

use nebula_contracts::compliance::{ComplianceEngine, ComplianceEngineInitArgs};
use nebula_contracts::identity::IdentityRegistry;
use nebula_contracts::nusd::NebulaUsd;
use nebula_contracts::oracle::{OracleHub, OracleHubInitArgs};
use nebula_contracts::vault::{NebulaVault, NebulaVaultInitArgs, VaultError};
use odra::casper_types::U256;
use odra::host::{Deployer, NoArgs};
use odra::prelude::*;

const HOUR_MS: u64 = 60 * 60 * 1000;

#[test]
fn full_protocol_lifecycle() {
    let env = odra_test::env();
    let admin = env.get_account(0);
    let investor_a = env.get_account(1);
    let investor_b = env.get_account(2);
    let oracle_good = env.get_account(3);
    let oracle_sloppy = env.get_account(4);
    let manager = env.get_account(5);
    let originator = env.get_account(6);

    // --- deployment ------------------------------------------------------
    env.set_caller(admin);
    let mut nusd = NebulaUsd::deploy(&env, NoArgs);
    let mut identity = IdentityRegistry::deploy(&env, NoArgs);
    let mut oracle_hub = OracleHub::deploy(
        &env,
        OracleHubInitArgs {
            identity_registry: identity.address(),
        },
    );
    let mut compliance = ComplianceEngine::deploy(
        &env,
        ComplianceEngineInitArgs {
            identity_registry: identity.address(),
        },
    );
    let mut vault = NebulaVault::deploy(
        &env,
        NebulaVaultInitArgs {
            nusd: nusd.address(),
            compliance: compliance.address(),
            oracle_hub: oracle_hub.address(),
            manager,
            risk_limit: 60,
            max_attestation_age_ms: HOUR_MS,
        },
    );

    // --- identity issuance -----------------------------------------------
    identity.register_identity(investor_a, 360, "ipfs://kyc/investor-a".to_string());
    identity.register_identity(investor_b, 458, "ipfs://kyc/investor-b".to_string());
    identity.register_identity(oracle_good, 0, "ipfs://agent-card/good".to_string());
    identity.register_identity(oracle_sloppy, 0, "ipfs://agent-card/sloppy".to_string());
    nusd.transfer(investor_a, U256::from(5_000u64));
    nusd.transfer(investor_b, U256::from(5_000u64));
    nusd.transfer(originator, U256::from(5_000u64));

    // --- oracle registration ---------------------------------------------
    env.set_caller(oracle_good);
    let good_id = oracle_hub.register_oracle("ipfs://agent-card/good".to_string());
    env.set_caller(oracle_sloppy);
    let sloppy_id = oracle_hub.register_oracle("ipfs://agent-card/sloppy".to_string());

    // --- attestations -----------------------------------------------------
    env.set_caller(oracle_good);
    let att_a = oracle_hub.attest(
        "INV-A".to_string(),
        30,
        "blake2b:report-a".to_string(),
        "https://oracle.nebula/reports/INV-A".to_string(),
    );
    env.set_caller(oracle_sloppy);
    let att_b = oracle_hub.attest(
        "INV-B".to_string(),
        90,
        "blake2b:report-b".to_string(),
        "https://oracle.nebula/reports/INV-B".to_string(),
    );

    // --- deposits ---------------------------------------------------------
    env.set_caller(investor_a);
    nusd.approve(vault.address(), U256::from(2_000u64));
    vault.deposit(U256::from(2_000u64));
    env.set_caller(investor_b);
    nusd.approve(vault.address(), U256::from(1_000u64));
    vault.deposit(U256::from(1_000u64));
    assert_eq!(vault.total_assets(), U256::from(3_000u64));
    assert_eq!(vault.share_balance_of(investor_a), U256::from(2_000u64));

    // --- risk-gated allocation -------------------------------------------
    env.set_caller(manager);
    // INV-B's only attestation scores 90 > limit 60: structurally blocked.
    assert_eq!(
        vault
            .try_allocate("INV-B".to_string(), U256::from(1_000u64), originator)
            .unwrap_err(),
        VaultError::AttestationTooRisky.into()
    );
    // INV-A at risk 30 clears the gate.
    let allocation = vault.allocate("INV-A".to_string(), U256::from(2_400u64), originator);
    assert_eq!(vault.cash(), U256::from(600u64));
    assert_eq!(vault.total_allocated(), U256::from(2_400u64));

    // --- settlement with premium (the yield event) ------------------------
    env.set_caller(originator);
    nusd.approve(vault.address(), U256::from(2_520u64));
    vault.settle(allocation, U256::from(2_520u64)); // +5% premium
    assert_eq!(vault.total_assets(), U256::from(3_120u64));
    assert_eq!(vault.share_price_e9(), U256::from(1_040_000_000u64));

    // --- yield withdrawal -------------------------------------------------
    env.set_caller(investor_b);
    vault.withdraw(U256::from(1_000u64));
    // 1_000 shares at 1.04 → 1_040 nUSD back (deposited 1_000).
    assert_eq!(nusd.balance_of(investor_b), U256::from(5_040u64));

    // --- reputation resolution -------------------------------------------
    env.set_caller(admin);
    oracle_hub.resolve(att_a, true);
    oracle_hub.resolve(att_b, false);
    assert_eq!(oracle_hub.reputation_bps(good_id), 10_000);
    assert_eq!(oracle_hub.reputation_bps(sloppy_id), 0);

    // --- compliance rules change mid-flight (no token migration) ----------
    env.set_caller(admin);
    compliance.set_rules(true, true, U256::zero()); // pause everything
    env.set_caller(investor_a);
    nusd.approve(vault.address(), U256::from(100u64));
    assert_eq!(
        vault.try_deposit(U256::from(100u64)).unwrap_err(),
        VaultError::ComplianceCheckFailed.into()
    );
    env.set_caller(admin);
    compliance.set_rules(false, true, U256::zero()); // unpause
    env.set_caller(investor_a);
    vault.deposit(U256::from(100u64));

    // --- identity revocation cuts access ---------------------------------
    env.set_caller(admin);
    identity.revoke_identity(investor_a);
    env.set_caller(investor_a);
    nusd.approve(vault.address(), U256::from(100u64));
    assert_eq!(
        vault.try_deposit(U256::from(100u64)).unwrap_err(),
        VaultError::ComplianceCheckFailed.into()
    );
}
