# makefun-btc-race-24h

An entry for the make.fun bounty [Race a BTC trading bot live for 24 hours](https://make.fun/bounty/btc-race-24h-20261109-2239).

## What it does

`main.ts` is a bot for the `agent-fun/bars-replay/v1` harness. It trades Coinbase Wrapped BTC (cbBTC)
against USDC on one-minute bars recorded from an Orca Whirlpool on Solana, starting from 1,000 USDC
of paper money, long only.

The harness sends one `hello`, then one `batch` per minute (the bar that just closed, the fills of
the previous batch's orders, the account), then `done`. The bot answers every batch with one reply
carrying its orders, which fill at the next bar's open.

The strategy is one round trip, sized at nearly all of the equity:

1. A 1.73 USDC probe on the first batch, so one order of its own fills on every path.
2. Entry on the first pullback of 0.2% from the running high of the closes, or by bar 30 if the
   pool has not pulled back by then.
3. Exit at a take-profit target over the entry close: 0.8% for the first half of the window, then
   shrinking in a straight line to 0.2% at the end. With no target hit, the position is held.
4. Whatever is still held is sold over the last six decision bars, ahead of the replay's forced
   sale at the last close.
5. A stop 16% under the entry close, far outside any ordinary day: it exists only to keep a crash
   inside the 25% drawdown guardrail.

Execution:

- Every decision is taken from the account in the batch (cash, position), so an order the market
  refuses (`no_bar`, `max_slippage`) is sized again on the next batch.
- Orders are cut into eight slices over consecutive bars: the pool's price impact starts again
  from its open depth every bar, so N slices pay about 1/N of the impact of one order. A slice
  counts as used when it fills, so after a minute with no bar the order is still cut into the
  same slices instead of catching up in one large piece.
- No clock, no randomness, no network, no dependencies: two runs give the same bytes.

Why this shape: the ranking pays by place on one unseen 24 hour window, and one-minute bars carry
no edge after costs, so the setting was chosen by how often it would finish first against a
simulated field of other entries (full longs, dip buyers that hold, dip buyers that sell the
bounce, ladders, probes) over 150 days of 24 hour windows, not by its mean PnL.

## How it is scored

Net PnL in USDC after every fee (4 bps fee, 2 bps slippage, price impact against the pool's depth)
on the 24 hours of one-minute bars that start one hour after the deadline. An entry races only if
it made money on the published dev window, must make at least one trade, and must keep its maximum
drawdown at 25% or less.

## Run it locally

Node 22 or later, nothing to install. With make.fun's kit unpacked in `kit/`:

```
cd kit
node cli/makefun.mjs grade-local --kit . --bot .. --driver docker
```

The bot itself reads the protocol on stdin and writes replies on stdout:

```
node main.ts < session.ndjson
```
