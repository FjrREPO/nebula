<h1 align="center">Nebula</h1>

<p align="center">
  <b>Agentic RWA infrastructure on Casper.</b><br/>
  <sub>Oracle agents with verifiable on-chain identity and accuracy-backed
  reputation, feeding a compliance-aware yield vault — wired together with x402
  micropayments. The AI proposes; deterministic Wasm disposes.</sub>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="MIT"/></a>
  <a href="https://casper.network"><img src="https://img.shields.io/badge/built%20on-Casper%202.0-red.svg" alt="Casper"/></a>
  <img src="https://img.shields.io/badge/contracts-Odra%20%2F%20Rust%E2%86%92Wasm-orange.svg" alt="Odra"/>
  <img src="https://img.shields.io/badge/payments-x402-blue.svg" alt="x402"/>
  <img src="https://img.shields.io/badge/runtime-Bun-black.svg" alt="Bun"/>
</p>

---

For the investor, Nebula is one sentence: **deposit once, hold one token, earn
real-world yield.** Everything that makes that sentence safe happens underneath,
on-chain, on Casper Testnet:

- **Oracle agents** underwrite real-world assets (invoice financing) with an
  LLM, anchor every risk assessment on-chain, and build a public,
  **accuracy-backed reputation** — oracles that call risk wrong lose relevance,
  verifiably.
- A **portfolio agent** buys those risk reports over **x402** — one agent paying
  another agent per API call, settled in nUSD on Casper — and allocates vault
  funds.
- The **vault contract independently re-verifies every allocation**: no fresh
  oracle attestation, or a risk score above the vault's limit, and the transfer
  is structurally impossible. A jailbroken agent cannot move funds the chain
  doesn't approve of.
- Deposits and share transfers pass an **ERC-3643-style compliance engine**
  (on-chain identity registry + upgradeable rule set). Casper joined the
  [ERC-3643 Association](https://www.casper.network/news/casper-network-joins-erc-3643)
  but has no public implementation on-chain yet — Nebula implements the pattern
  natively in Odra, with Casper's package versioning standing in for T-REX
  proxies: **when regulation changes, the rules upgrade in place; no token
  migration, no holder touched.**

## Live on Casper Testnet

All five contracts are deployed on `casper-test` as **upgradeable packages**,
and the full lifecycle below ran as real transactions (see
[`DEPLOYMENTS.md`](DEPLOYMENTS.md) for every link).

| Contract                                  | Package hash                                                            |
| ----------------------------------------- | ----------------------------------------------------------------------- |
| **NebulaUsd** (nUSD, CEP-18 + EIP-3009)   | `hash-88850405e67d8b375b3307cdf2afa86b215a9625780803a77125b050bec942aa` |
| **IdentityRegistry** (ERC-3643-style)     | `hash-6a4b72b925b0e86a9fd3adc5bda1b7b9f0fa1e0d697c644bad4020809dc0db8d` |
| **OracleHub** (attestations + reputation) | `hash-888b54eb6ab775124b8eb58284dca0dbf62e8f702cebd7141768b03b36c421ff` |
| **ComplianceEngine** (upgradeable rules)  | `hash-e79a7e260ebf4cabe7ca66d950fb8d5bbc54c2dcbde715754edcb67c94632390` |
| **NebulaVault** (risk-gated yield vault)  | `hash-d0e61415ade59455d098e1c4c6f9bafe8dd6b29f98821649bd4f9ab70a05c8cb` |

## How it works

```
                        ┌────────────────────────────────────────────┐
                        │              IdentityRegistry              │
                        │   trusted issuers → verified identities    │
                        │   (investors AND oracle agents)            │
                        └───────▲──────────────────────▲─────────────┘
                                │ is_verified          │ is_verified
                                │                      │
┌──────────────┐  can_transfer ┌┴───────────────┐     ┌┴───────────────────────┐
│  NebulaVault │──────────────▶│ Compliance     │     │ OracleHub              │
│              │               │ Engine         │     │ attest / resolve       │
│ deposit      │               │ (upgradeable)  │     │ reputation = accuracy  │
│ withdraw     │               └────────────────┘     └───────▲────────────────┘
│ allocate ────┼── latest_attestation? fresh? risk ≤ limit? ──┘
│ settle       │        (enforced ON-CHAIN, not in the prompt)
└───────▲──────┘
        │ transfer_from / transfer                 x402 (HTTP 402 + EIP-3009)
┌───────┴──────┐    ┌─────────────────┐  pays nUSD   ┌─────────────────┐
│ NebulaUsd    │◀───│ Portfolio Agent │◀────────────▶│  Oracle Agent   │
│ nUSD + EIP-  │    │ buys reports,   │  per report  │  LLM underwriter│
│ 3009 auths   │    │ plans, allocates│              │  sells reports  │
└──────────────┘    └─────────────────┘              └─────────────────┘
```

### The trust construction

LLMs are good at _deciding_ and bad at _being a safety boundary_. Nebula splits
the two:

| Layer                                 | Who                                         | Enforced by     |
| ------------------------------------- | ------------------------------------------- | --------------- |
| Underwriting & allocation _decisions_ | AI agents (LLM)                             | — advisory only |
| Who may hold/move value               | IdentityRegistry + ComplianceEngine         | on-chain        |
| What may be financed                  | OracleHub attestation: fresh + risk ≤ limit | on-chain        |
| Who pays whom for data                | x402 / EIP-3009 signed authorizations       | on-chain        |
| Oracle credibility                    | resolution → accuracy track record (bps)    | on-chain        |

The portfolio agent's LLM plan is _also_ filtered by a deterministic guard (risk
cap, budget rescale) before submission — and then the vault re-verifies
everything again on-chain. Three layers deep, only the last one matters for
safety; the first two just save gas.

### x402: agents paying agents

The oracle sells each underwriting report behind an **HTTP 402 paywall**. The
buyer signs an **EIP-712 / EIP-3009 `transfer_with_authorization`** for nUSD
off-chain (zero gas for the payer) and replays the request with the
`PAYMENT-SIGNATURE` header. Settlement tries Casper's hosted facilitator
(`x402-facilitator.cspr.cloud`) first and transparently falls back to
self-settlement — the seller submits the authorization on-chain itself. The
on-chain digest verification in `NebulaUsd` reproduces
[`casper-eip-712`](https://github.com/casper-ecosystem/casper-eip-712)
byte-for-byte (nonce replay protection, validity windows, ed25519 + secp256k1).

## Monorepo layout

```
contracts/           Odra (Rust → Wasm): the five protocol contracts + tests
packages/
  core/              LLM client (OpenAI-compatible) + run-log store
  plugin-onchain/    RPC client, BIP-44 keys, deploys, typed entry points
  plugin-x402/       EIP-712 digest, payment payloads, paywall server, settle
  plugin-oracle/     origination book, LLM underwriting + heuristic clamp
apps/
  oracle-agent/      attests on-chain, sells reports behind x402
  portfolio-agent/   buys reports via x402, allocates through the vault
  web/               dashboard (run replay, allocations, reputation)
scripts/
  deploy.ts          wasm-opt MVP lowering + odra_cfg install + hash discovery
  demo.ts            the 8-act end-to-end testnet run
```

## Running it

Prerequisites: [Bun](https://bun.sh) ≥ 1.2, Rust nightly-2026-01-01 with
`wasm32-unknown-unknown`, [`cargo-odra`](https://github.com/odradev/cargo-odra),
`wasm-opt` (binaryen) + `wasm-strip` (wabt), and a funded `casper-test` account.

```bash
bun install
cp .env.example .env          # fill: CSPR_CLOUD_API_KEY, CASPER_MNEMONIC (or PEM), OPENAI_API_KEY

# 1. Contracts: test and build
cd contracts && cargo test && cargo odra build && cd ..

# 2. Deploy to testnet (writes deployments/testnet.json; put hashes in .env)
bun run scripts/deploy.ts

# 3. The full lifecycle as real testnet transactions
bun run scripts/demo.ts

# 4. Dashboard on :4100 — replay the run with explorer links
bun run apps/web/src/index.ts
```

Agents also run standalone: `bun run apps/oracle-agent/src/index.ts` (attest +
serve the x402 shop) and `bun run apps/portfolio-agent/src/index.ts` (buy +
allocate).

## Testing

- **33 Rust unit tests** across the five contracts (`cargo test`), covering
  EIP-3009 signature verification (happy path, replay, expiry, tampered amounts,
  wrong keys), compliance gating, oracle reputation math, share-price
  accounting, and the vault's risk gate.
- **1 Rust integration test** (`contracts/tests/protocol_flow.rs`) driving the
  full five-contract lifecycle, including yield realization and mid-flight
  compliance-rule changes.
- **11 TypeScript tests** (`bun test`) for the EIP-712 digest (determinism,
  field coverage), payment payload roundtrips, signature tagging, and the
  underwriting model's ordering guarantees.

## Why Casper

- **Upgradeable packages at the protocol level** — the compliance engine evolves
  with regulation without reissuing the asset. This is Casper's core RWA pitch,
  exercised end-to-end here.
- **Casper-native EIP-712** (`casper-eip-712`) makes gasless, signed
  authorizations — the x402 rail — verifiable on-chain with `verify_signature`.
- **Deterministic finality + fixed costs** — agents can budget gas without
  auction anxiety.
- The [Casper Manifest](https://www.casper.network/news/manifest) puts an
  ERC-3643 compliance/identity layer on the H2 2026 roadmap; Nebula is a working
  preview of that layer, built agent-first.

## Roadmap

- Real originator onboarding (document upload → LLM extraction → issuance)
- Oracle staking: reputation with slashing-grade economic weight
- Multi-oracle attestation quorums per asset
- csprUSD settlement and mainnet deployment when the facilitator opens
- CSPR.click wallet flow in the dashboard for self-custodial deposits

## License

[MIT](LICENSE)
