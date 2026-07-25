# Deployments & Live Run — Casper Testnet (`casper-test`)

Deployer / protocol admin:
`0203dc4a23af775ed29fc045565256c35b3519cc9bad1b7e7051172ce2cffc61cc45`

## Contract packages (upgradeable)

| Contract             | Package hash                                                            | Install tx                                                                                                                  |
| -------------------- | ----------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| **NebulaUsd (nUSD)** | `hash-88850405e67d8b375b3307cdf2afa86b215a9625780803a77125b050bec942aa` | first install run                                                                                                           |
| **IdentityRegistry** | `hash-6a4b72b925b0e86a9fd3adc5bda1b7b9f0fa1e0d697c644bad4020809dc0db8d` | [`94482ed3…4e67ca`](https://testnet.cspr.live/transaction/94482ed3386ffd33f6a84bdc497764879ae0ba52458d396bdc7e1bace74e67ca) |
| **OracleHub**        | `hash-888b54eb6ab775124b8eb58284dca0dbf62e8f702cebd7141768b03b36c421ff` | [`f19957c5…029c9d`](https://testnet.cspr.live/transaction/f19957c5df51b1abaca358cfcff6b547d47aa4f4677a12a19d49e42f98029c9d) |
| **ComplianceEngine** | `hash-e79a7e260ebf4cabe7ca66d950fb8d5bbc54c2dcbde715754edcb67c94632390` | [`472def4a…619c44`](https://testnet.cspr.live/transaction/472def4a8b24b913c49fa045bb4c77263969c0249b5684c8a3f666acd1619c44) |
| **NebulaVault**      | `hash-d0e61415ade59455d098e1c4c6f9bafe8dd6b29f98821649bd4f9ab70a05c8cb` | [`34a3b6a0…83635a`](https://testnet.cspr.live/transaction/34a3b6a00bef1216853febe723ef6ffef7caf173f9de610dc1e937084183635a) |

## The demo run — every transaction

One end-to-end lifecycle executed on 2026-07-26 (UTC): funding → identity
issuance → deposit → LLM underwriting + on-chain attestation → x402 report sales
(agent pays agent in nUSD) → risk-gated allocations → settlement with premium →
yield withdrawal → oracle reputation resolution.

| #   | Actor           | Action                                                    | Tx                                                                                                                          |
| --- | --------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 1   | admin           | Funded portfolioAgent with 60 CSPR gas                    | [`da2c13bc…6d0154`](https://testnet.cspr.live/transaction/da2c13bc8f88b98a0cab0e20bd8186f472d9e6cf6a78776cdcc35e7f2b6d0154) |
| 2   | admin           | Funded originator with 60 CSPR gas                        | [`1484c278…253734`](https://testnet.cspr.live/transaction/1484c2788369d331e1600963022541b7376a90a1324a396e8685a7cab7253734) |
| 3   | admin           | Funded investor with 60 CSPR gas                          | [`3b44ca0d…b7c90d`](https://testnet.cspr.live/transaction/3b44ca0d7a2affb56fa38cfb56da7f1a1391a5453b2367e832aa6e66b1b7c90d) |
| 4   | admin           | KYC-verified the investor (country 360)                   | [`ec1400f3…f37a6c`](https://testnet.cspr.live/transaction/ec1400f3af8964265b763092dd51796d94227b0fe4ba936dc2cd80e9ccf37a6c) |
| 5   | admin           | Verified the oracle agent identity                        | [`98213995…14e985`](https://testnet.cspr.live/transaction/98213995ddfdb8ebe194b90df43413ee451f1af06224619b4fabc884f614e985) |
| 6   | admin           | Sent 5000 nUSD to the investor                            | [`0a5003c5…de96bd`](https://testnet.cspr.live/transaction/0a5003c5df93c2a86b06acec837bad2aa8d160ac90ab317862c69c8013de96bd) |
| 7   | admin           | Sent 5000 nUSD to the originator                          | [`0d2eb684…abb39b`](https://testnet.cspr.live/transaction/0d2eb684b2ab844916dc6cfbf486b1f6ca76f69bd89a19a795a11d1c29abb39b) |
| 8   | admin           | Sent 100 nUSD to the portfolio agent (x402 budget)        | [`cb73564c…cbfd12`](https://testnet.cspr.live/transaction/cb73564c49a4d0b049983b45c6ea13958668bd030f0fa52ffb1491a86dcbfd12) |
| 9   | investor        | Approved the vault to pull 2,000 nUSD                     | [`bf745dea…a904d4`](https://testnet.cspr.live/transaction/bf745dea88607fec279753f186f27fd364d022426bec1404a51b67b2a2a904d4) |
| 10  | investor        | Deposited 2,000 nUSD → vault shares minted                | [`1def9e1a…eda35b`](https://testnet.cspr.live/transaction/1def9e1a49ae6cd67b80b2061ffc56dd162253185f2ebb676558b2c6d6eda35b) |
| 11  | oracle-agent    | Registered oracle identity on the hub                     | [`807adcad…f4ef42`](https://testnet.cspr.live/transaction/807adcad453ca9bee2f6ac145d697a2947facda51a776889ed943d78e1f4ef42) |
| 12  | oracle-agent    | Attested INV-2026-0007 at risk 15 (finance)               | [`9184897f…60a95a`](https://testnet.cspr.live/transaction/9184897f71271f4c4907972f733e2818a2b4d7e688e308a11096ee3adb60a95a) |
| 13  | oracle-agent    | Attested INV-2026-0012 at risk 45 (finance)               | [`0c55f8a3…6267dd`](https://testnet.cspr.live/transaction/0c55f8a37ddd0b6f264f18d16eb1849502ccedf6098e0b90b633df2ba16267dd) |
| 14  | oracle-agent    | Attested INV-2026-0019 at risk 80 (decline)               | [`f051c668…c06200`](https://testnet.cspr.live/transaction/f051c668708f38097c08c435fbcb57fc623891a008d4aa07bd72b4499ec06200) |
| 15  | oracle-agent    | Sold /reports/INV-2026-0007 for 0.5 nUSD via x402         | [`daa19747…3f23a1`](https://testnet.cspr.live/transaction/daa1974740b58aa83f765b92a9f3bd07a7c201049dcd4e73955a8e7c593f23a1) |
| 16  | portfolio-agent | Bought risk report INV-2026-0007 from the oracle via x402 | [`daa19747…3f23a1`](https://testnet.cspr.live/transaction/daa1974740b58aa83f765b92a9f3bd07a7c201049dcd4e73955a8e7c593f23a1) |
| 17  | oracle-agent    | Sold /reports/INV-2026-0012 for 0.5 nUSD via x402         | [`31d6ae90…4cf21e`](https://testnet.cspr.live/transaction/31d6ae90e8c89c65f3316b3b3d7445efb29c988db6be63493268d42f604cf21e) |
| 18  | portfolio-agent | Bought risk report INV-2026-0012 from the oracle via x402 | [`31d6ae90…4cf21e`](https://testnet.cspr.live/transaction/31d6ae90e8c89c65f3316b3b3d7445efb29c988db6be63493268d42f604cf21e) |
| 19  | oracle-agent    | Sold /reports/INV-2026-0019 for 0.5 nUSD via x402         | [`9e963a53…10bd91`](https://testnet.cspr.live/transaction/9e963a53d256afee706eecdc29c77b22108146b186ee4e085e5e057b1810bd91) |
| 20  | portfolio-agent | Bought risk report INV-2026-0019 from the oracle via x402 | [`9e963a53…10bd91`](https://testnet.cspr.live/transaction/9e963a53d256afee706eecdc29c77b22108146b186ee4e085e5e057b1810bd91) |
| 21  | portfolio-agent | Allocated 947.368421052 nUSD to INV-2026-0007             | [`49e15b4e…015321`](https://testnet.cspr.live/transaction/49e15b4ea0ba108ed426a6edd9a7fe5c9188fba76fc8b8e31f9ccadfde015321) |
| 22  | portfolio-agent | Allocated 852.631578947 nUSD to INV-2026-0012             | [`279b15fe…9e60f6`](https://testnet.cspr.live/transaction/279b15fee0467e30a1011bcf3d04ee31b114a496e841f245ac1672b28c9e60f6) |
| 23  | originator      | Approved repayment of 994.736842104 nUSD                  | [`294f2046…9dcb52`](https://testnet.cspr.live/transaction/294f2046add4dee503395b6235d2854737b0d645cc6e62be979bc4987e9dcb52) |
| 24  | originator      | Settled INV-2026-0007: repaid 994.736842104 nUSD (+5%)    | [`749c5512…64043e`](https://testnet.cspr.live/transaction/749c5512bdf39cfb654b38727e079815daf4b6c77190a22900fa26bae764043e) |
| 25  | originator      | Approved repayment of 895.263157894 nUSD                  | [`1f9f4264…400524`](https://testnet.cspr.live/transaction/1f9f4264e60a9167a670470a30954106cf5df121d818f0380c2385939e400524) |
| 26  | originator      | Settled INV-2026-0012: repaid 895.263157894 nUSD (+5%)    | [`3cf0a1c8…f8f51c`](https://testnet.cspr.live/transaction/3cf0a1c8a0f05598be21ff37d093b6a13fa7d22db658a5370261c577c6f8f51c) |
| 27  | investor        | Withdrew 1,000 shares at the appreciated price            | [`ca7cd2bf…3cd1de`](https://testnet.cspr.live/transaction/ca7cd2bfdfc718086aa0f51fd3eeca94bb62f302eaa206cf871b4541d43cd1de) |
| 28  | admin           | Resolved attestation for INV-2026-0007 as accurate        | [`e2272ca7…904819`](https://testnet.cspr.live/transaction/e2272ca7dbad56bbe3eec6af606dcdcea68daea2935e7df9bcb8060a98904819) |
| 29  | admin           | Resolved attestation for INV-2026-0012 as accurate        | [`c561a028…6e8c58`](https://testnet.cspr.live/transaction/c561a028a564eced89aea305f1d92b58fb215d42549750dd05ac1489eb6e8c58) |
| 30  | admin           | Resolved attestation for INV-2026-0019 as accurate        | [`942469bd…91611d`](https://testnet.cspr.live/transaction/942469bddab505a9490205d3eca6559d66caca2d38f4b97ddee704560791611d) |

## Numbers that matter

- Deposited: **2,000 nUSD** → 2,000 vault shares
- Allocated: **1,800 nUSD** across 2 assets the oracle scored ≤ 60; the risk-80
  asset was structurally rejected by the vault's on-chain gate
- Repaid: **1,890 nUSD** (+5% premium) → share price 1.045
- Reports sold via x402: **3 × 0.5 nUSD**, settled on-chain (EIP-3009
  `transfer_with_authorization`)
- Oracle reputation after resolution: **10,000 bps (3/3 accurate)**
