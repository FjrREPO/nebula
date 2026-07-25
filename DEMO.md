# Demo Walkthrough

A 3–4 minute video script for the Nebula demo, mirroring the recorded testnet
run in [`DEPLOYMENTS.md`](DEPLOYMENTS.md).

## 0:00 — The hook

> "This is Nebula. For an investor it's one sentence: deposit once, hold one
> token, earn real-world yield. Everything that makes that sentence safe is an
> AI agent economy running on Casper — and I'll show it live on testnet."

Show: dashboard header + the four stat tiles.

## 0:30 — The problem

> "RWA protocols have two trust problems: who verified the real-world asset, and
> why should an AI agent be allowed near the money? Nebula answers both
> on-chain."

Show: architecture diagram in the README.

## 1:00 — Oracle agents with skin in the game

> "An oracle agent underwrites invoices with an LLM. Every assessment is
> anchored on-chain: risk score, report hash, and the x402 URL where the full
> report is sold. Later, each attestation is resolved accurate or not — the
> oracle's reputation is literally its accuracy track record, in basis points,
> on-chain."

Show: attestation txs on testnet.cspr.live; `reputation_bps` in OracleHub.

## 1:45 — Agents paying agents (x402)

> "The portfolio agent buys those reports over x402. HTTP 402, a signed nUSD
> authorization — EIP-3009 on Casper, verified byte-for-byte on-chain — and the
> payment settles as a real transaction. No subscriptions, no invoices:
> machine-to-machine commerce per API call."

Show: the x402 sale txs; the `PAYMENT-SIGNATURE` flow in code or logs.

## 2:15 — The chain has the last word

> "Here's the part that makes this trustworthy: the vault re-verifies every
> allocation itself. This asset scored 80 — above the vault's risk limit — and
> the allocation is structurally impossible. Not 'the prompt said no' — the Wasm
> said no."

Show: the risk-80 asset excluded in the allocations table; `AttestationTooRisky`
in `vault.rs`.

## 2:45 — Yield lands, compliance holds

> "Allocations settled with a 5% premium. The share price moved from 1.000 to
> 1.045, and the investor withdrew more than they put in — real yield from a
> real-world flow. And every deposit passed an ERC-3643-style compliance engine:
> on-chain identities, upgradeable rules. Casper joined the ERC-3643
> Association; Nebula is that layer, working, today."

Show: withdraw tx; the compliance engine rules; yield tile.

## 3:15 — Close

> "Five upgradeable contracts on Casper Testnet, thirty-plus transactions in one
> autonomous run, forty-five tests. Nebula: the trust layer where AI agents and
> real-world assets meet. Built on Casper."

Show: DEPLOYMENTS.md transaction table scroll.
