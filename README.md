<h1 align="center">Nebula</h1>

<p align="center">
  <b>Agentic RWA infrastructure on Casper.</b><br/>
  <sub>Oracle agents with verifiable on-chain identity and accuracy-backed
  reputation, feeding a compliance-aware yield vault — wired together with
  x402 micropayments.</sub>
</p>

---

> Work in progress — built for the Casper Agentic Buildathon 2026 Final Round.
> Full documentation, deployed contract addresses, and demo walkthrough land
> here as the build progresses.

## Monorepo layout

```
contracts/           Odra (Rust → Wasm) smart contracts for Casper
contracts-session/   Session Wasm helpers (payable entry-point calls)
packages/
  core/              Agent runtime + LLM client
  plugin-onchain/    Casper RPC client, contract bindings, deploy helpers
  plugin-x402/       x402 payments: EIP-712 signing, buyer + seller, facilitator
  plugin-oracle/     RWA data sources + risk assessment
apps/
  oracle-agent/      Attests RWA risk on-chain, sells reports behind x402
  portfolio-agent/   Buys oracle data via x402, allocates vault funds
  web/               Dashboard
scripts/             Deployment & operational scripts
```

## License

[MIT](LICENSE)
