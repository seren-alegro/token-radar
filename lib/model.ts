// Token launch radar: the valuation model.
//
// Every number on the board is derived from the sealed snapshot alone.
// Tokenized protocols in the snapshot are the peer set: for each category we
// read the market-cap-to-TVL ratios the market actually pays for that kind of
// business, take a low percentile of them (a token that does not exist yet
// prices below seasoned peers), and apply that multiple to the TVL of the
// protocols in the category that still record no token. Two snapshot factors
// then move the result: seven-day TVL growth (momentum) and maturity (how
// long the protocol has run with no token, from listed_at to the snapshot's
// as_of date). No protocol name is hardcoded anywhere in this file.

export interface Protocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

export interface Snapshot {
  as_of: string;
  floor_usd: number;
  protocols: Protocol[];
  watchlist: string[];
}

export interface Row {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
}

export interface Detail extends Row {
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  peer_multiple: number;
  growth_factor: number;
  maturity_factor: number;
  on_watchlist: boolean;
}

export function parseSnapshot(text: string): Snapshot {
  const raw = JSON.parse(text) as Snapshot;
  if (!Array.isArray(raw.protocols) || !Array.isArray(raw.watchlist)) {
    throw new Error('snapshot: protocols and watchlist must be arrays');
  }
  return raw;
}

// ------------------------------------------------------------ eligibility
//
// A protocol belongs on the radar when the snapshot records no token for it
// (both gecko_id and symbol null) and it is not a wrapped, staked or bridged
// product of a protocol whose token already trades. The derivative test is
// the watchlist's own, from the snapshot's README, applied at every TVL: the
// watchlist is the same rule above the floor, so every watchlist slug is
// eligible here by construction.

const DERIVATIVE_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

export function recordsNoToken(p: Protocol): boolean {
  return p.gecko_id === null && p.symbol === null;
}

export function isDerivativeProduct(p: Protocol): boolean {
  if (p.category !== null && DERIVATIVE_CATEGORIES.has(p.category)) return true;
  if (VERSION_SUFFIX.test(p.name)) return true;
  if (WRAPPED_WORD.test(p.name)) return true;
  return EXCHANGE_PREFIXES.some((x) => p.name.startsWith(x));
}

export function isEligible(p: Protocol): boolean {
  return recordsNoToken(p) && !isDerivativeProduct(p);
}

// ------------------------------------------------------------ peer multiples

const MULTIPLE_MIN = 0.02;
const MULTIPLE_MAX = 2.5;
const LAUNCH_DISCOUNT = 0.85;
const PEER_PERCENTILE = 0.4;

/** The element at percentile q of an ascending array, nearest-rank. */
function percentile(sortedAsc: number[], q: number): number {
  const at = Math.min(sortedAsc.length - 1, Math.floor(q * (sortedAsc.length - 1)));
  return sortedAsc[at]!;
}

/**
 * The multiple the snapshot supports for one category: the 40th percentile of
 * its tokenized peers' market-cap/TVL ratios, discounted for a launch that
 * has not happened, clamped to a sane band. A category with fewer than three
 * peers with a recorded market cap falls back to the whole snapshot's peers.
 */
export function peerMultiples(snapshot: Snapshot): Map<string | null, number> {
  const byCategory = new Map<string | null, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    all.push(ratio);
    const list = byCategory.get(p.category) ?? [];
    list.push(ratio);
    byCategory.set(p.category, list);
  }
  all.sort((a, b) => a - b);
  const globalMultiple = clamp(percentile(all, PEER_PERCENTILE) * LAUNCH_DISCOUNT, MULTIPLE_MIN, MULTIPLE_MAX);
  const out = new Map<string | null, number>();
  for (const p of snapshot.protocols) {
    if (out.has(p.category)) continue;
    const list = byCategory.get(p.category);
    if (list !== undefined && list.length >= 3) {
      const sorted = [...list].sort((a, b) => a - b);
      out.set(p.category, clamp(percentile(sorted, PEER_PERCENTILE) * LAUNCH_DISCOUNT, MULTIPLE_MIN, MULTIPLE_MAX));
    } else {
      out.set(p.category, globalMultiple);
    }
  }
  return out;
}

function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

// ------------------------------------------------------------ factors

/** Momentum: a week of TVL growth, clamped, moves the value by at most ±45%. */
export function growthFactor(change7d: number | null): number {
  if (change7d === null) return 1;
  return 1 + (clamp(change7d, -50, 100) / 100) * 0.45;
}

/** Whole days from a YYYY-MM-DD date to the snapshot's as_of date. */
export function ageInDays(listedAt: string | null, asOf: string): number | null {
  if (listedAt === null) return null;
  const ms = Date.parse(`${asOf}T00:00:00Z`) - Date.parse(`${listedAt}T00:00:00Z`);
  if (Number.isNaN(ms)) return null;
  return Math.max(0, Math.round(ms / 86_400_000));
}

/**
 * Maturity: a protocol that has run for years with no token has an
 * established business to price; a weeks-old one is mostly promise. The
 * factor rises from 0.78 for a brand-new listing to 1.0 at four years.
 * An unreported listing date scores as a young protocol.
 */
export function maturityFactor(ageDays: number | null): number {
  if (ageDays === null) return 0.8;
  return 0.78 + 0.22 * Math.min(ageDays / 1460, 1);
}

// ------------------------------------------------------------ farm plans
//
// Steps are assembled from the protocol's own record: its category's way of
// being used, its first chain's cost class, its size band, its age and the
// direction its TVL moved this week. Every step names an action, a cost and
// a timeframe, and stays inside the gate's 20 to 600 characters.

const HIGH_COST_CHAINS = new Set(['Ethereum']);

function money(usd: number): string {
  if (usd >= 1e9) return `$${(usd / 1e9).toFixed(2)}B`;
  if (usd >= 1e6) return `$${(usd / 1e6).toFixed(1)}M`;
  return `$${Math.round(usd).toLocaleString('en-US')}`;
}

function chainCost(chain: string): string {
  return HIGH_COST_CHAINS.has(chain)
    ? 'budget roughly $5-$40 of ETH per transaction in mainnet gas, and batch actions into one visit'
    : 'gas is a few cents to about $1 per transaction, so small test amounts cost almost nothing';
}

function sizeBand(tvl: number): string {
  if (tvl >= 500_000_000) return 'a $1,000-$5,000 position is a small share of its pool depth';
  if (tvl >= 100_000_000) return 'a $500-$2,000 position sits comfortably inside its pool depth';
  if (tvl >= 25_000_000) return 'a $250-$1,000 position is meaningful without moving its markets';
  return 'a $100-$500 position is a sensible size for a protocol of this depth';
}

interface Playbook {
  open: string;
  deepen: string;
}

const PLAYBOOKS: Record<string, Playbook> = {
  Dexs: {
    open: 'Route real swaps through its main pairs each week rather than wash trading: ten to twenty swaps of $100-$500 across two or three pairs, which costs the swap fees shown in the interface plus gas.',
    deepen: 'Add liquidity to its deepest pair at 0.5-1% of your swap volume and leave it for at least four weeks; concentrated ranges need a weekly rebalance of about ten minutes.',
  },
  Lending: {
    open: 'Supply a mainstream asset (ETH or a major stablecoin) to its main market and keep the deposit in place; avoid borrowing against it in the first two weeks while you learn its liquidation rules.',
    deepen: 'Once the supply position is seasoned, take a conservative borrow at under 40% of the supplied value and recycle half of it back as supply, keeping a wide liquidation buffer at all times.',
  },
  'Risk Curators': {
    open: 'Deposit a stablecoin into its flagship curated vault rather than spreading thin: one vault, one asset, held for a full month so the position is unambiguously active capital.',
    deepen: 'Split a second deposit across two more of its vaults with different strategies, and note the curator reallocation notices each week; ten minutes of reading keeps you ahead of strategy changes.',
  },
  'Onchain Capital Allocator': {
    open: 'Allocate to its main vault product and hold through at least one full rebalancing cycle, which for most allocators runs weekly; short hops in and out read as noise, not participation.',
    deepen: 'Add a second allocation in a different risk tranche of the same allocator and compare the reported yields monthly, moving size toward the tranche you actually understand.',
  },
  Yield: {
    open: 'Deposit into its highest-TVL vault and leave the position untouched for at least four weeks; yield vaults reward duration, and churning between vaults mostly pays gas.',
    deepen: 'Ladder a second deposit into a different vault or chain deployment of the same protocol, staggered by two weeks, so your activity spans more than one snapshot window.',
  },
  'Yield Aggregator': {
    open: 'Move one asset you already hold into its main aggregator vault instead of opening a new position elsewhere; the deposit itself is the participation signal.',
    deepen: 'Enable its auto-compound or lock option if it offers one, and add a small monthly top-up of $50-$100 so the position shows continuing, not one-off, use.',
  },
  RWA: {
    open: 'Complete its onboarding and KYC first (usually 1-3 days and free), then make a first mint or subscription at the minimum the product allows, often $100-$1,000.',
    deepen: 'Hold the tokenized asset through at least one full yield or coupon period, typically 30-90 days, and run one redemption end to end so you know the exit before you size up.',
  },
  Derivatives: {
    open: 'Trade its perpetual markets with deliberately small size, $10-$25 of margin per position, several sessions a week; volume and consistency matter here, not profit.',
    deepen: 'Work more than one market and one order type (a limit order left resting counts differently from a market order), and keep total open interest exposure under $100 while you learn its funding rhythm.',
  },
  CDP: {
    open: 'Open a small vault: deposit ETH or an accepted liquid staking token as collateral and mint its stablecoin at no more than a third of the maximum the collateral allows.',
    deepen: 'Use the minted stablecoin inside the same ecosystem (a lending market or a DEX pair) and keep the collateral ratio above 200%, checking it weekly against price moves.',
  },
  'Basis Trading': {
    open: 'Deposit a stablecoin or ETH into its basis vault and hold for a full funding cycle, usually four to eight weeks; basis returns accrue slowly and exit fees punish short stays.',
    deepen: 'Add a second, smaller deposit a month later and compare the realised yield against the headline rate before committing more; basis spreads compress as TVL grows.',
  },
  'Staking Pool': {
    open: 'Stake the chain asset the pool serves in a modest amount first, $100-$500 worth, and confirm the pool share or receipt position appears in your wallet before staking more.',
    deepen: 'Stake on a monthly cadence rather than once, and if the pool runs more than one validator set or vault, spread across two of them.',
  },
  Chain: {
    open: 'Bridge a small amount, $100-$300, onto the chain and make it your active wallet there for a month: swaps, a lending deposit and ordinary transfers all count as real usage.',
    deepen: 'Use three or four of the chain native applications across different categories (a DEX, a lending market, a bridge out and back) so your activity is broad, not one repeated action.',
  },
  'Leveraged Farming': {
    open: 'Open its simplest leveraged position at the lowest leverage offered, with $100-$250 of collateral, and set aside an hour to understand its liquidation price before adding anything.',
    deepen: 'Keep the position for at least three weeks, topping collateral up if the liquidation price comes within 25% of the market price; leveraged farms reward survival, not size.',
  },
  Farm: {
    open: 'Deposit into its main farm pair or single-asset farm and stake the receipt in its own staking contract, which is the step most casual users skip.',
    deepen: 'Harvest and restake the rewards weekly for at least six weeks; the compounding record is both yield and a visible history of participation.',
  },
};

const DEFAULT_PLAYBOOK: Playbook = {
  open: 'Use its core product the way it is meant to be used, with a real position rather than a dust test: open it, fund it, and complete one full cycle of its main action this week.',
  deepen: 'Repeat the core action on a second chain deployment or product line of the same protocol if it has one, and keep both positions open for at least a month.',
};

export function farmSteps(p: Protocol, ageDays: number | null): string[] {
  const chain = p.chains[0] ?? 'its main chain';
  const book = PLAYBOOKS[p.category ?? ''] ?? DEFAULT_PLAYBOOK;
  const steps: string[] = [];

  steps.push(
    `Set up on ${chain}: use a wallet you control and fund it for ${p.name}; ${chainCost(chain)}. Setup takes about 15 minutes and ${sizeBand(p.tvl_usd)}.`,
  );
  steps.push(book.open);
  steps.push(book.deepen);
  if (p.chains.length > 1) {
    steps.push(
      `${p.name} runs on ${p.chains.length} chains (${p.chains.slice(0, 3).join(', ')}${p.chains.length > 3 ? ' and more' : ''}). Repeat your main position on a second chain within the first month; bridging $100-$300 costs a few dollars and doubles the surface a snapshot can see.`,
    );
  }
  if (ageDays !== null && ageDays >= 365) {
    steps.push(
      `This protocol has run ${Math.floor(ageDays / 365) > 1 ? `${Math.floor(ageDays / 365)} years` : 'over a year'} with no token recorded, so past activity may already count if it ever issues one. Start now, then keep a light weekly cadence for 8-12 weeks rather than one burst.`,
    );
  } else {
    steps.push(
      'Build the record gradually: one or two genuine sessions a week for 8-12 weeks. Steady, varied activity over months is what separates a user from a one-day sybil pattern, and it costs only the gas you would pay anyway.',
    );
  }
  if (p.change_7d !== null && p.change_7d <= -10) {
    steps.push(
      `Risk check before sizing up: its TVL fell ${Math.abs(p.change_7d).toFixed(1)}% in the seven days before the snapshot. Keep the position at the small end of the band above, re-check its TVL monthly, and be ready to withdraw to a stablecoin in one transaction.`,
    );
  } else if (p.change_7d !== null && p.change_7d >= 10) {
    steps.push(
      `Momentum note: its TVL grew ${p.change_7d.toFixed(1)}% in the seven days before the snapshot, so its pools are deepening. That supports holding the position, but do not chase size after a fast rise; add on the original weekly schedule.`,
    );
  } else {
    steps.push(
      'Risk check: keep any single position small enough to exit in one transaction, re-check its TVL and this board monthly, and never borrow elsewhere to fund a farm. The implied value is an estimate, not a promise of a token.',
    );
  }
  return steps;
}

// ------------------------------------------------------------ the board

export function buildBoard(snapshot: Snapshot): { rows: Row[]; details: Detail[] } {
  const multiples = peerMultiples(snapshot);
  const watch = new Set(snapshot.watchlist);
  const details: Detail[] = [];
  for (const p of snapshot.protocols) {
    if (!isEligible(p)) continue;
    const age = ageInDays(p.listed_at, snapshot.as_of);
    const multiple = multiples.get(p.category) ?? multiples.get(null)!;
    const growth = growthFactor(p.change_7d);
    const maturity = maturityFactor(age);
    const value = Math.max(1, Math.round(p.tvl_usd * multiple * growth * maturity));
    details.push({
      slug: p.slug,
      name: p.name,
      rank: 0,
      implied_value_usd: value,
      farm_steps: farmSteps(p, age),
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      age_days: age,
      peer_multiple: multiple,
      growth_factor: growth,
      maturity_factor: maturity,
      on_watchlist: watch.has(p.slug),
    });
  }
  details.sort(
    (a, b) =>
      b.implied_value_usd - a.implied_value_usd ||
      b.tvl_usd - a.tvl_usd ||
      (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0),
  );
  details.forEach((d, i) => {
    d.rank = i + 1;
  });
  const rows: Row[] = details.map((d) => ({
    slug: d.slug,
    name: d.name,
    rank: d.rank,
    implied_value_usd: d.implied_value_usd,
    farm_steps: d.farm_steps,
  }));
  return { rows, details };
}

/** The gate's shape, checked before anything is written. Null means the board is well-formed. */
export function boardIssue(rows: Row[], snapshot: Snapshot): string | null {
  if (rows.length < 100 || rows.length > 4000) return `board holds ${rows.length} rows, outside 100..4000`;
  const slugs = new Set(snapshot.protocols.map((p) => p.slug));
  const seen = new Set<string>();
  for (const r of rows) {
    if (!slugs.has(r.slug)) return `row names a protocol the snapshot does not: ${r.slug}`;
    if (seen.has(r.slug)) return `slug appears twice: ${r.slug}`;
    seen.add(r.slug);
    if (!Number.isInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 1e14) {
      return `implied value out of range for ${r.slug}`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `farm steps out of range for ${r.slug}`;
    for (const s of r.farm_steps) {
      const n = s.trim().length;
      if (n < 20 || n > 600) return `a farm step for ${r.slug} is ${n} characters, outside 20..600`;
    }
  }
  for (const slug of snapshot.watchlist) {
    if (!seen.has(slug)) return `watchlist protocol missing from the board: ${slug}`;
  }
  const byRank = [...rows].sort((a, b) => a.rank - b.rank);
  for (let i = 0; i < byRank.length; i++) {
    if (byRank[i]!.rank !== i + 1) return 'ranks are not exactly 1..N';
    if (i > 0 && byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) {
      return 'implied value rises as rank ascends';
    }
  }
  if (rows.every((r) => r.implied_value_usd === rows[0]!.implied_value_usd)) return 'every implied value is the same';
  return null;
}

/** The dashboard's data file: the same board, with the model's workings shown per protocol. */
export function dataScript(snapshot: Snapshot, details: Detail[]): string {
  const payload = {
    as_of: snapshot.as_of,
    floor_usd: snapshot.floor_usd,
    model: {
      summary:
        'Implied value = TVL x peer multiple x growth factor x maturity factor. The peer multiple is the 40th percentile of market-cap/TVL among the snapshot tokenized protocols in the same category, discounted 15% for a launch that has not happened and clamped to 0.02..2.5. Growth uses the 7-day TVL change clamped to -50%..+100%, weighted 0.45. Maturity rises from 0.78 at listing to 1.0 at four years tokenless.',
      peer_percentile: PEER_PERCENTILE,
      launch_discount: LAUNCH_DISCOUNT,
    },
    rows: details,
  };
  return `window.RADAR = ${JSON.stringify(payload)};\n`;
}
