# Method — token launch radar

## Who is on the board (the tokenless rule)

A protocol from the snapshot is eligible when both of these hold:

1. **It records no token**: `gecko_id` is null **and** `symbol` is null.
   (`mcap_usd` is not used for this test: hundreds of protocols carry a token
   record with no market cap, and the snapshot README defines "records no
   token" by the two id fields.)
2. **It is not a wrapped, staked or bridged product of a tokenized protocol.**
   The snapshot carries no `parentProtocol` field, so this is tested with the
   same observable proxies the watchlist's own definition uses:
   - `category` is one of `Bridge`, `Canonical Bridge`, `Liquid Staking`,
     `Liquid Restaking`, `Restaked BTC`, `CEX`; or
   - `name` ends in a version marker (`\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$`); or
   - `name` contains the whole word `wrapped`, `staked` or `staking` (any case); or
   - `name` begins with an exchange name (Binance, Coinbase, Bybit, Kraken,
     Bitget, OKX, Bitfinex, Gemini).

The rule is applied at every TVL, not only above the $50M floor: the watchlist
is this same rule restricted to the floor, so all 40 watchlist slugs are on
the board by construction. Result on this snapshot: 198 eligible protocols of
758 (342 record no token; 144 of those are derivative products by the tests
above).

## The valuation model

For each eligible protocol:

```
implied_value_usd = round( TVL x peer_multiple x growth_factor x maturity_factor )
```

- **Peer multiple** (per category): among the snapshot's tokenized protocols
  in the same category that record a market cap, take the market-cap/TVL
  ratios and use their **40th percentile** — what the market pays for the
  cheaper half of that kind of business — times a **0.85 launch discount** (a
  token that does not exist yet prices below seasoned peers), clamped to
  **0.02..2.5**. A category with fewer than three such peers uses the whole
  snapshot's 40th-percentile multiple instead (this fallback is what prices
  Risk Curators, which has only one peer with a recorded market cap).
- **Growth factor**: `1 + clamp(change_7d, -50, +100) / 100 x 0.45`, so a week
  of TVL movement moves the value by at most ±45%. Unreported change scores 1.
- **Maturity factor**: `0.78 + 0.22 x min(age_days / 1460, 1)`, where age is
  `listed_at` to the snapshot's `as_of`. Four tokenless years reach 1.0; an
  unreported listing date scores 0.80.

No protocol name, slug or category value is hardcoded in the model; the
category playbooks used for farm steps key off the snapshot's own category
strings only. Rows are sorted by implied value descending (ties: TVL
descending, then slug ascending) and ranked 1..N.

## Farm steps

Each row carries 5–6 steps assembled from its own record: a setup step priced
by its first chain's cost class, two steps from its category's playbook
(swapping, supplying, vault deposits, staking, chain usage, …), a second-chain
step when it runs on more than one chain, a cadence step that reflects how
long it has already run tokenless, and a risk step that quotes its actual
7-day TVL move. Every step names an action, a cost and a timeframe, and is
20–600 characters as the gate requires.
