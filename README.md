# makefun-btc-race-24h

An entry for the make.fun bounty [Race a BTC trading bot live for 24 hours](https://make.fun/bounty/btc-race-24h-20261109-2239).

## What it does

`main.ts` is a bot for the `agent-fun/bars-replay/v1` harness. It trades Coinbase Wrapped BTC (cbBTC)
against USDC on one-minute bars recorded from an Orca Whirlpool on Solana, starting from 1,000 USDC
of paper money, long only.

The harness sends one `hello`, then one `batch` per minute (the bar that just closed, the fills of
the previous batch's orders, the account), then `done`. The bot answers every batch with one reply
carrying its orders, which fill at the next bar's open.

- Every decision is taken from the account in the batch (cash, position), so an order the market
  refuses (`no_bar`, `max_slippage`) is sized again on the next batch.
- Orders are cut into slices over consecutive bars: the pool's price impact starts again from its
  open depth every bar, so N slices pay about 1/N of the impact of one order.
- The position is sold in slices over the last bars of the window, before the replay's forced sale
  at the last close.
- No clock, no randomness, no network, no dependencies: two runs give the same bytes.

## How it is scored

Net PnL in USDC after every fee (4 bps fee, 4 bps pool fee, 2 bps slippage, price impact) on the
24 hours of one-minute bars that start one hour after the deadline. An entry races only if it made
money on the published dev window, must make at least one trade, and must keep its maximum drawdown
at 25% or less.

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
