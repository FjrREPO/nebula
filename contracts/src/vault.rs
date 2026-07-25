//! `NebulaVault` — the compliance-aware RWA yield vault.
//!
//! Investors deposit [`crate::NebulaUsd`] and receive vault shares; the
//! portfolio agent (`manager`) allocates idle funds to real-world-asset
//! originators. The trust construction is the point:
//!
//! - **Deposits / share transfers** are gated by the
//!   [`crate::ComplianceEngine`] (ERC-3643-style identity checks) — on-chain.
//! - **Allocations** are gated by the [`crate::OracleHub`]: the asset's latest
//!   risk attestation must exist, be *fresh*, and score at or below the
//!   vault's risk limit — on-chain. The AI portfolio agent *proposes*
//!   allocations, but an allocation into an unattested, stale-attested, or
//!   too-risky asset is structurally impossible. The model proposes; code
//!   disposes.
//! - **Yield** arrives when originators settle allocations with a premium,
//!   which accrues to the share price — depositors simply hold shares.
//!
//! Accounting invariant: `total_assets = cash + total_allocated`, where `cash`
//! mirrors the vault's own nUSD balance and `total_allocated` is outstanding
//! principal.

use odra::casper_types::U256;
use odra::prelude::Address;
use odra::prelude::*;

use odra::ContractRef;

use crate::compliance::ComplianceEngineContractRef;
use crate::nusd::NebulaUsdContractRef;
use crate::oracle::OracleHubContractRef;

#[odra::odra_error]
pub enum VaultError {
    NotOwner = 81,
    NotManager = 82,
    /// The compliance engine rejected this movement.
    ComplianceCheckFailed = 83,
    ZeroAmount = 84,
    InsufficientShares = 85,
    /// Not enough idle (unallocated) funds in the vault.
    InsufficientLiquidity = 86,
    /// The attestation's risk score exceeds the vault's risk limit.
    AttestationTooRisky = 87,
    /// The attestation is older than `max_attestation_age_ms`.
    AttestationStale = 88,
    UnknownAllocation = 89,
    AllocationNotActive = 90,
}

/// The vault's wiring + risk parameters, as one readable view.
#[odra::odra_type]
pub struct VaultConfig {
    pub nusd: Address,
    pub compliance: Address,
    pub oracle_hub: Address,
    pub manager: Address,
    pub risk_limit: u8,
    pub max_attestation_age_ms: u64,
}

/// An outstanding (or settled) allocation of vault funds to an RWA originator.
#[odra::odra_type]
pub struct Allocation {
    pub asset_id: String,
    pub recipient: Address,
    pub principal: U256,
    /// The oracle attestation this allocation was justified by.
    pub attestation_id: u64,
    pub funded_at: u64,
    pub active: bool,
    pub repaid: U256,
}

#[odra::event]
pub struct Deposited {
    pub depositor: Address,
    pub amount: U256,
    pub shares: U256,
}

#[odra::event]
pub struct Withdrawn {
    pub depositor: Address,
    pub shares: U256,
    pub amount: U256,
}

#[odra::event]
pub struct SharesTransferred {
    pub from: Address,
    pub to: Address,
    pub amount: U256,
}

#[odra::event]
pub struct Allocated {
    pub allocation_id: u64,
    pub asset_id: String,
    pub recipient: Address,
    pub amount: U256,
    pub attestation_id: u64,
    pub risk_score: u8,
}

#[odra::event]
pub struct AllocationSettled {
    pub allocation_id: u64,
    pub principal: U256,
    pub repaid: U256,
}

#[odra::event]
pub struct ManagerUpdated {
    pub manager: Address,
}

#[odra::event]
pub struct RiskParamsUpdated {
    pub risk_limit: u8,
    pub max_attestation_age_ms: u64,
}

#[odra::module(
    events = [Deposited, Withdrawn, SharesTransferred, Allocated, AllocationSettled, ManagerUpdated, RiskParamsUpdated],
    errors = VaultError
)]
pub struct NebulaVault {
    owner: Var<Address>,
    /// The portfolio agent authorized to allocate funds.
    manager: Var<Address>,
    nusd: Var<Address>,
    compliance: Var<Address>,
    oracle_hub: Var<Address>,
    total_shares: Var<U256>,
    shares: Mapping<Address, U256>,
    /// Idle nUSD held by the vault (deposits + settlements − withdrawals − allocations).
    cash: Var<U256>,
    /// Outstanding allocated principal.
    total_allocated: Var<U256>,
    allocations: Mapping<u64, Option<Allocation>>,
    total_allocations: Var<u64>,
    /// Maximum acceptable attestation risk score (0..=100).
    risk_limit: Var<u8>,
    /// Maximum attestation age (millis) at allocation time.
    max_attestation_age_ms: Var<u64>,
}

#[odra::module]
impl NebulaVault {
    /// Install the vault, wiring the settlement token, compliance engine,
    /// oracle hub, and the portfolio agent (`manager`).
    pub fn init(
        &mut self,
        nusd: Address,
        compliance: Address,
        oracle_hub: Address,
        manager: Address,
        risk_limit: u8,
        max_attestation_age_ms: u64,
    ) {
        self.owner.set(self.env().caller());
        self.nusd.set(nusd);
        self.compliance.set(compliance);
        self.oracle_hub.set(oracle_hub);
        self.manager.set(manager);
        self.risk_limit.set(risk_limit);
        self.max_attestation_age_ms.set(max_attestation_age_ms);
        self.total_shares.set(U256::zero());
        self.cash.set(U256::zero());
        self.total_allocated.set(U256::zero());
        self.total_allocations.set(0);
    }

    // --- investor surface ----------------------------------------------

    /// Deposit `amount` nUSD (requires prior `approve` to the vault) and mint
    /// shares at the current share price. Compliance-gated on the depositor.
    pub fn deposit(&mut self, amount: U256) {
        if amount.is_zero() {
            self.env().revert(VaultError::ZeroAmount);
        }
        let depositor = self.env().caller();
        self.assert_compliant(depositor, depositor, amount);

        let minted = if self.total_shares.get_or_default().is_zero() {
            amount
        } else {
            amount * self.total_shares.get_or_default() / self.total_assets()
        };

        self.token()
            .transfer_from(depositor, self.env().self_address(), amount);
        self.cash.set(self.cash.get_or_default() + amount);
        self.total_shares
            .set(self.total_shares.get_or_default() + minted);
        self.shares
            .set(&depositor, self.shares.get_or_default(&depositor) + minted);
        self.env().emit_event(Deposited {
            depositor,
            amount,
            shares: minted,
        });
    }

    /// Burn `share_amount` shares and pay out the pro-rata slice of vault
    /// assets from idle cash.
    pub fn withdraw(&mut self, share_amount: U256) {
        if share_amount.is_zero() {
            self.env().revert(VaultError::ZeroAmount);
        }
        let depositor = self.env().caller();
        let held = self.shares.get_or_default(&depositor);
        if held < share_amount {
            self.env().revert(VaultError::InsufficientShares);
        }

        let amount = share_amount * self.total_assets() / self.total_shares.get_or_default();
        self.assert_compliant(depositor, depositor, amount);
        if self.cash.get_or_default() < amount {
            self.env().revert(VaultError::InsufficientLiquidity);
        }

        self.shares.set(&depositor, held - share_amount);
        self.total_shares
            .set(self.total_shares.get_or_default() - share_amount);
        self.cash.set(self.cash.get_or_default() - amount);
        self.token().transfer(depositor, amount);
        self.env().emit_event(Withdrawn {
            depositor,
            shares: share_amount,
            amount,
        });
    }

    /// Transfer vault shares — the ERC-3643-gated secondary movement.
    pub fn transfer_shares(&mut self, to: Address, amount: U256) {
        let from = self.env().caller();
        let held = self.shares.get_or_default(&from);
        if held < amount {
            self.env().revert(VaultError::InsufficientShares);
        }
        self.assert_compliant(from, to, amount);
        self.shares.set(&from, held - amount);
        self.shares
            .set(&to, self.shares.get_or_default(&to) + amount);
        self.env()
            .emit_event(SharesTransferred { from, to, amount });
    }

    // --- portfolio-agent surface ----------------------------------------

    /// Allocate `amount` of idle funds to an RWA originator. Manager only.
    ///
    /// Enforced **on-chain**, independent of anything the AI decided off-chain:
    /// the asset's latest oracle attestation must exist, be no older than
    /// `max_attestation_age_ms`, and score at or below `risk_limit`.
    pub fn allocate(&mut self, asset_id: String, amount: U256, recipient: Address) -> u64 {
        if self.env().caller() != self.manager.get_or_revert_with(VaultError::NotManager) {
            self.env().revert(VaultError::NotManager);
        }
        if amount.is_zero() {
            self.env().revert(VaultError::ZeroAmount);
        }
        if self.cash.get_or_default() < amount {
            self.env().revert(VaultError::InsufficientLiquidity);
        }

        // The on-chain risk gate. Reverts inside the hub if no attestation.
        let hub = OracleHubContractRef::new(self.env(), self.oracle_hub());
        let attestation = hub.latest_attestation(asset_id.clone());
        let attestation_id = hub.latest_attestation_id(asset_id.clone());
        if attestation.risk_score > self.risk_limit.get_or_default() {
            self.env().revert(VaultError::AttestationTooRisky);
        }
        let now = self.env().get_block_time();
        if now - attestation.attested_at > self.max_attestation_age_ms.get_or_default() {
            self.env().revert(VaultError::AttestationStale);
        }

        let allocation_id = self.total_allocations.get_or_default() + 1;
        self.total_allocations.set(allocation_id);
        self.cash.set(self.cash.get_or_default() - amount);
        self.total_allocated
            .set(self.total_allocated.get_or_default() + amount);
        self.allocations.set(
            &allocation_id,
            Some(Allocation {
                asset_id: asset_id.clone(),
                recipient,
                principal: amount,
                attestation_id,
                funded_at: now,
                active: true,
                repaid: U256::zero(),
            }),
        );
        self.token().transfer(recipient, amount);
        self.env().emit_event(Allocated {
            allocation_id,
            asset_id,
            recipient,
            amount,
            attestation_id,
            risk_score: attestation.risk_score,
        });
        allocation_id
    }

    /// Settle an allocation: the caller (originator) repays `repay_amount`
    /// nUSD (requires prior `approve` to the vault). Any premium over the
    /// principal accrues to the share price as yield.
    pub fn settle(&mut self, allocation_id: u64, repay_amount: U256) {
        let mut allocation = self
            .allocations
            .get(&allocation_id)
            .flatten()
            .unwrap_or_revert_with(&self.env(), VaultError::UnknownAllocation);
        if !allocation.active {
            self.env().revert(VaultError::AllocationNotActive);
        }

        let payer = self.env().caller();
        self.token()
            .transfer_from(payer, self.env().self_address(), repay_amount);

        allocation.active = false;
        allocation.repaid = repay_amount;
        let principal = allocation.principal;
        self.allocations.set(&allocation_id, Some(allocation));
        self.total_allocated
            .set(self.total_allocated.get_or_default() - principal);
        self.cash.set(self.cash.get_or_default() + repay_amount);
        self.env().emit_event(AllocationSettled {
            allocation_id,
            principal,
            repaid: repay_amount,
        });
    }

    // --- admin ----------------------------------------------------------

    /// Rotate the portfolio agent. Owner only.
    pub fn set_manager(&mut self, manager: Address) {
        self.assert_owner();
        self.manager.set(manager);
        self.env().emit_event(ManagerUpdated { manager });
    }

    /// Tune the on-chain risk gate. Owner only.
    pub fn set_risk_params(&mut self, risk_limit: u8, max_attestation_age_ms: u64) {
        self.assert_owner();
        self.risk_limit.set(risk_limit);
        self.max_attestation_age_ms.set(max_attestation_age_ms);
        self.env().emit_event(RiskParamsUpdated {
            risk_limit,
            max_attestation_age_ms,
        });
    }

    // --- views ----------------------------------------------------------

    pub fn total_assets(&self) -> U256 {
        self.cash.get_or_default() + self.total_allocated.get_or_default()
    }

    pub fn cash(&self) -> U256 {
        self.cash.get_or_default()
    }

    pub fn total_allocated(&self) -> U256 {
        self.total_allocated.get_or_default()
    }

    pub fn total_shares(&self) -> U256 {
        self.total_shares.get_or_default()
    }

    pub fn share_balance_of(&self, owner: Address) -> U256 {
        self.shares.get_or_default(&owner)
    }

    /// Share price scaled by 1e9 (i.e. nUSD-per-share in nUSD's own decimals).
    /// 1e9 exactly until the first yield settles.
    pub fn share_price_e9(&self) -> U256 {
        let total_shares = self.total_shares.get_or_default();
        if total_shares.is_zero() {
            return U256::from(1_000_000_000u64);
        }
        self.total_assets() * U256::from(1_000_000_000u64) / total_shares
    }

    pub fn allocation(&self, allocation_id: u64) -> Allocation {
        self.allocations
            .get(&allocation_id)
            .flatten()
            .unwrap_or_revert_with(&self.env(), VaultError::UnknownAllocation)
    }

    pub fn total_allocations(&self) -> u64 {
        self.total_allocations.get_or_default()
    }

    pub fn manager(&self) -> Address {
        self.manager.get_or_revert_with(VaultError::NotManager)
    }

    pub fn config(&self) -> VaultConfig {
        VaultConfig {
            nusd: self.nusd.get_or_revert_with(VaultError::NotOwner),
            compliance: self.compliance.get_or_revert_with(VaultError::NotOwner),
            oracle_hub: self.oracle_hub(),
            manager: self.manager(),
            risk_limit: self.risk_limit.get_or_default(),
            max_attestation_age_ms: self.max_attestation_age_ms.get_or_default(),
        }
    }

    // --- internal -------------------------------------------------------

    fn assert_owner(&self) {
        if self.env().caller() != self.owner.get_or_revert_with(VaultError::NotOwner) {
            self.env().revert(VaultError::NotOwner);
        }
    }

    fn assert_compliant(&self, from: Address, to: Address, amount: U256) {
        let engine = ComplianceEngineContractRef::new(
            self.env(),
            self.compliance.get_or_revert_with(VaultError::NotOwner),
        );
        if !engine.can_transfer(from, to, amount) {
            self.env().revert(VaultError::ComplianceCheckFailed);
        }
    }

    fn token(&self) -> NebulaUsdContractRef {
        NebulaUsdContractRef::new(
            self.env(),
            self.nusd.get_or_revert_with(VaultError::NotOwner),
        )
    }

    fn oracle_hub(&self) -> Address {
        self.oracle_hub.get_or_revert_with(VaultError::NotOwner)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::compliance::{ComplianceEngine, ComplianceEngineInitArgs};
    use crate::identity::IdentityRegistry;
    use crate::nusd::NebulaUsd;
    use crate::oracle::{OracleHub, OracleHubInitArgs};
    use odra::host::{Deployer, HostEnv, NoArgs};

    const HOUR_MS: u64 = 60 * 60 * 1000;

    struct World {
        env: HostEnv,
        nusd: crate::nusd::NebulaUsdHostRef,
        identity: crate::identity::IdentityRegistryHostRef,
        oracle_hub: crate::oracle::OracleHubHostRef,
        vault: NebulaVaultHostRef,
        investor: Address,
        oracle_agent: Address,
        manager: Address,
        originator: Address,
    }

    /// Deploy the full protocol and verify the actors' identities.
    fn setup() -> World {
        let env = odra_test::env();
        let admin = env.get_account(0);
        let investor = env.get_account(1);
        let oracle_agent = env.get_account(2);
        let manager = env.get_account(3);
        let originator = env.get_account(4);

        env.set_caller(admin);
        let mut nusd = NebulaUsd::deploy(&env, NoArgs);
        let mut identity = IdentityRegistry::deploy(&env, NoArgs);
        let mut oracle_hub = OracleHub::deploy(
            &env,
            OracleHubInitArgs {
                identity_registry: identity.address(),
            },
        );
        let compliance = ComplianceEngine::deploy(
            &env,
            ComplianceEngineInitArgs {
                identity_registry: identity.address(),
            },
        );
        let vault = NebulaVault::deploy(
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

        // KYC the investor and the oracle agent; fund investor + originator.
        identity.register_identity(investor, 360, "ipfs://kyc/investor".to_string());
        identity.register_identity(oracle_agent, 0, "ipfs://agent-card/oracle".to_string());
        nusd.transfer(investor, U256::from(10_000u64));
        nusd.transfer(originator, U256::from(10_000u64));

        // The oracle agent registers on the hub.
        env.set_caller(oracle_agent);
        oracle_hub.register_oracle("ipfs://agent-card/oracle".to_string());

        World {
            env,
            nusd,
            identity,
            oracle_hub,
            vault,
            investor,
            oracle_agent,
            manager,
            originator,
        }
    }

    fn deposit(world: &mut World, amount: u64) {
        world.env.set_caller(world.investor);
        world
            .nusd
            .approve(world.vault.address(), U256::from(amount));
        world.vault.deposit(U256::from(amount));
    }

    #[test]
    fn deposit_mints_shares_and_pulls_funds() {
        let mut world = setup();
        deposit(&mut world, 1_000);

        assert_eq!(
            world.vault.share_balance_of(world.investor),
            U256::from(1_000u64)
        );
        assert_eq!(world.vault.total_assets(), U256::from(1_000u64));
        assert_eq!(world.vault.cash(), U256::from(1_000u64));
        assert_eq!(
            world.nusd.balance_of(world.vault.address()),
            U256::from(1_000u64)
        );
        assert_eq!(world.vault.share_price_e9(), U256::from(1_000_000_000u64));
    }

    #[test]
    fn unverified_depositor_is_rejected() {
        let mut world = setup();
        let stranger = world.env.get_account(5);

        world.env.set_caller(world.env.get_account(0));
        world.nusd.transfer(stranger, U256::from(100u64));

        world.env.set_caller(stranger);
        world
            .nusd
            .approve(world.vault.address(), U256::from(100u64));
        assert_eq!(
            world.vault.try_deposit(U256::from(100u64)).unwrap_err(),
            VaultError::ComplianceCheckFailed.into()
        );
    }

    #[test]
    fn allocation_requires_fresh_low_risk_attestation() {
        let mut world = setup();
        deposit(&mut world, 1_000);

        // No attestation for the asset yet → the hub itself reverts.
        world.env.set_caller(world.manager);
        assert!(world
            .vault
            .try_allocate("INV-1".to_string(), U256::from(500u64), world.originator)
            .is_err());

        // Attest at risk 80 — above the vault's limit of 60.
        world.env.set_caller(world.oracle_agent);
        world
            .oracle_hub
            .attest("INV-1".to_string(), 80, "h1".to_string(), "u".to_string());
        world.env.set_caller(world.manager);
        assert_eq!(
            world
                .vault
                .try_allocate("INV-1".to_string(), U256::from(500u64), world.originator)
                .unwrap_err(),
            VaultError::AttestationTooRisky.into()
        );

        // Fresh, low-risk attestation → allocation goes through.
        world.env.set_caller(world.oracle_agent);
        world
            .oracle_hub
            .attest("INV-1".to_string(), 35, "h2".to_string(), "u".to_string());
        world.env.set_caller(world.manager);
        let id = world
            .vault
            .allocate("INV-1".to_string(), U256::from(500u64), world.originator);
        assert_eq!(id, 1);
        assert_eq!(world.vault.cash(), U256::from(500u64));
        assert_eq!(world.vault.total_allocated(), U256::from(500u64));
        assert_eq!(
            world.nusd.balance_of(world.originator),
            U256::from(10_500u64)
        );

        let allocation = world.vault.allocation(id);
        assert!(allocation.active);
        assert_eq!(allocation.principal, U256::from(500u64));
    }

    #[test]
    fn stale_attestation_is_rejected() {
        let mut world = setup();
        deposit(&mut world, 1_000);

        world.env.set_caller(world.oracle_agent);
        world
            .oracle_hub
            .attest("INV-2".to_string(), 20, "h".to_string(), "u".to_string());

        // Older than the 1-hour freshness window.
        world.env.advance_block_time(2 * HOUR_MS);
        world.env.set_caller(world.manager);
        assert_eq!(
            world
                .vault
                .try_allocate("INV-2".to_string(), U256::from(100u64), world.originator)
                .unwrap_err(),
            VaultError::AttestationStale.into()
        );
    }

    #[test]
    fn only_manager_allocates() {
        let mut world = setup();
        deposit(&mut world, 1_000);

        world.env.set_caller(world.oracle_agent);
        world
            .oracle_hub
            .attest("INV-3".to_string(), 10, "h".to_string(), "u".to_string());

        world.env.set_caller(world.investor);
        assert_eq!(
            world
                .vault
                .try_allocate("INV-3".to_string(), U256::from(100u64), world.originator)
                .unwrap_err(),
            VaultError::NotManager.into()
        );
    }

    #[test]
    fn settlement_with_premium_accrues_yield_to_withdrawal() {
        let mut world = setup();
        deposit(&mut world, 1_000);

        world.env.set_caller(world.oracle_agent);
        world
            .oracle_hub
            .attest("INV-4".to_string(), 30, "h".to_string(), "u".to_string());

        world.env.set_caller(world.manager);
        let id = world
            .vault
            .allocate("INV-4".to_string(), U256::from(800u64), world.originator);

        // Originator repays principal + 5% premium.
        world.env.set_caller(world.originator);
        world
            .nusd
            .approve(world.vault.address(), U256::from(840u64));
        world.vault.settle(id, U256::from(840u64));

        assert_eq!(world.vault.total_assets(), U256::from(1_040u64));
        assert_eq!(world.vault.total_allocated(), U256::zero());
        assert_eq!(world.vault.share_price_e9(), U256::from(1_040_000_000u64));
        assert!(!world.vault.allocation(id).active);

        // Settling twice is impossible.
        assert_eq!(
            world.vault.try_settle(id, U256::from(1u64)).unwrap_err(),
            VaultError::AllocationNotActive.into()
        );

        // The investor exits with the yield: 1000 shares → 1040 nUSD.
        world.env.set_caller(world.investor);
        world.vault.withdraw(U256::from(1_000u64));
        assert_eq!(world.nusd.balance_of(world.investor), U256::from(10_040u64));
        assert_eq!(world.vault.total_shares(), U256::zero());
    }

    #[test]
    fn withdraw_is_bounded_by_idle_liquidity() {
        let mut world = setup();
        deposit(&mut world, 1_000);

        world.env.set_caller(world.oracle_agent);
        world
            .oracle_hub
            .attest("INV-5".to_string(), 30, "h".to_string(), "u".to_string());
        world.env.set_caller(world.manager);
        world
            .vault
            .allocate("INV-5".to_string(), U256::from(900u64), world.originator);

        world.env.set_caller(world.investor);
        assert_eq!(
            world.vault.try_withdraw(U256::from(500u64)).unwrap_err(),
            VaultError::InsufficientLiquidity.into()
        );
        // A withdrawal within idle cash still works.
        world.vault.withdraw(U256::from(100u64));
    }

    #[test]
    fn share_transfers_are_compliance_gated() {
        let mut world = setup();
        deposit(&mut world, 1_000);
        let stranger = world.env.get_account(5);

        world.env.set_caller(world.investor);
        assert_eq!(
            world
                .vault
                .try_transfer_shares(stranger, U256::from(100u64))
                .unwrap_err(),
            VaultError::ComplianceCheckFailed.into()
        );

        // Once the stranger is KYC'd, the same transfer clears.
        world.env.set_caller(world.env.get_account(0));
        world
            .identity
            .register_identity(stranger, 458, "ipfs://kyc/2".to_string());
        world.env.set_caller(world.investor);
        world.vault.transfer_shares(stranger, U256::from(100u64));
        assert_eq!(world.vault.share_balance_of(stranger), U256::from(100u64));
    }

    #[test]
    fn second_depositor_pays_the_appreciated_share_price() {
        let mut world = setup();
        deposit(&mut world, 1_000);

        // Yield lands: assets 1000 → 1100 while shares stay 1000.
        world.env.set_caller(world.oracle_agent);
        world
            .oracle_hub
            .attest("INV-6".to_string(), 30, "h".to_string(), "u".to_string());
        world.env.set_caller(world.manager);
        let id = world
            .vault
            .allocate("INV-6".to_string(), U256::from(500u64), world.originator);
        world.env.set_caller(world.originator);
        world
            .nusd
            .approve(world.vault.address(), U256::from(600u64));
        world.vault.settle(id, U256::from(600u64));

        // A new verified depositor now gets shares at 1.1 nUSD each.
        let second = world.env.get_account(5);
        world.env.set_caller(world.env.get_account(0));
        world
            .identity
            .register_identity(second, 458, "ipfs://kyc/3".to_string());
        world.nusd.transfer(second, U256::from(1_100u64));

        world.env.set_caller(second);
        world
            .nusd
            .approve(world.vault.address(), U256::from(1_100u64));
        world.vault.deposit(U256::from(1_100u64));
        assert_eq!(world.vault.share_balance_of(second), U256::from(1_000u64));
    }
}
