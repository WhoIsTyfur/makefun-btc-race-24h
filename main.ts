// cbBTC/USDC bot for make.fun's bars-replay/v1 harness (Node 22, standard library only).
//
// Wire: newline-delimited JSON. The harness sends one hello, then one batch per minute, then done.
// Every batch gets exactly one reply that echoes its seq and carries the orders decided on that bar.
// Orders fill at the next bar's open, so everything here is decided from the latest close and from
// the account the batch reports (cash and position), never from what we remember having sent:
// a rejected order (no_bar, max_slippage) is simply sized again on the next batch.

import { createInterface } from 'node:readline';

const SYMBOL = 'CBBTC';
const MINUTE_MS = 60_000;
const WINDOW_BARS = 1_440; // both windows are 24 h of one-minute bars

// Entry: the cash to deploy is bought in ENTRY_SLICES pieces, one per bar, because the pool's impact
// starts again from its open depth on every bar (N slices pay about 1/N of the impact).
const ENTRY_SLICES = 7;
// Exit: the position is sold over the last EXIT_SLICES decision bars, so the forced sale at the last
// close (full impact, no limit) has nothing left to sell.
const EXIT_SLICES = 7;
// Share of equity to hold, in bps. Odd on purpose: no other entry sends these sizes.
const TARGET_BPS = 9_713n;
const MAX_SLIPPAGE_BPS = 400;

interface Bar { symbol: string; t: number; o: string; h: string; l: string; c: string; o_depth: string[]; c_depth: string[] }
interface Position { symbol: string; qty: string; cost_quote_units: string }
interface Account { cash_quote_units: string; positions: Position[]; equity_quote_units: string }
interface Batch { type: 'batch'; seq: number; t: number; bars: Bar[]; fills: unknown[]; account: Account }
interface Order { side: 'buy' | 'sell'; client_id: string; symbol: string; notional_quote_units?: string; qty?: string; max_slippage_bps: number }

let firstCloseMs = -1;
let minNotional = 1_000_000n;
let lastClose = 0n; // latest close seen, at the symbol's price scale
let orderCount = 0;

function clientId(tag: string, seq: number): string {
  orderCount += 1;
  return `tyf-${tag}-${seq}-${orderCount}`;
}

function onHello(hello: any): void {
  firstCloseMs = hello.first_close_ms;
  minNotional = BigInt(hello.fees.min_notional_quote_units);
}

function onBatch(batch: Batch): Order[] {
  if (firstCloseMs < 0) firstCloseMs = batch.t;
  const bar = batch.bars.find((b) => b.symbol === SYMBOL);
  if (bar !== undefined) lastClose = BigInt(bar.c);
  if (lastClose === 0n) return []; // no bar yet: nothing to price an order against

  const cash = BigInt(batch.account.cash_quote_units);
  const equity = BigInt(batch.account.equity_quote_units);
  const held = batch.account.positions.find((p) => p.symbol === SYMBOL);
  const qty = held === undefined ? 0n : BigInt(held.qty);
  const positionValue = equity - cash;

  const index = Math.round((batch.t - firstCloseMs) / MINUTE_MS); // 0 on the first batch
  const decisionsLeft = WINDOW_BARS - 1 - index; // batches after this one; 0 on the last batch
  if (decisionsLeft <= 0) return []; // an order decided on the last batch is rejected (after_end)

  // Exit phase: sell what is held in equal slices, everything on the last decision bar.
  if (decisionsLeft <= EXIT_SLICES) {
    if (qty === 0n) return [];
    const slice = decisionsLeft === 1 ? qty : qty / BigInt(decisionsLeft);
    if (slice === 0n) return [];
    return [{ side: 'sell', client_id: clientId('x', batch.seq), symbol: SYMBOL, qty: slice.toString(), max_slippage_bps: MAX_SLIPPAGE_BPS }];
  }

  // Entry phase: buy toward the target share of equity, one slice per bar.
  const target = (equity * TARGET_BPS) / 10_000n;
  const missing = target - positionValue;
  if (missing < minNotional) return [];
  const slicesLeft = BigInt(Math.max(1, ENTRY_SLICES - index));
  let spend = missing / slicesLeft;
  if (spend < minNotional) spend = minNotional;
  if (spend > cash) spend = cash;
  if (spend < minNotional) return [];
  return [{ side: 'buy', client_id: clientId('e', batch.seq), symbol: SYMBOL, notional_quote_units: spend.toString(), max_slippage_bps: MAX_SLIPPAGE_BPS }];
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
for await (const line of lines) {
  if (line.trim() === '') continue;
  const msg = JSON.parse(line);
  if (msg.type === 'hello') {
    onHello(msg);
  } else if (msg.type === 'batch') {
    const orders = onBatch(msg as Batch);
    process.stdout.write(`${JSON.stringify({ type: 'reply', seq: msg.seq, orders })}\n`);
  } else if (msg.type === 'done') {
    break;
  }
}
lines.close();
process.stdin.destroy();
