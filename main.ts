// cbBTC/USDC bot for make.fun's bars-replay/v1 harness (Node 22, standard library only).
//
// Wire: newline-delimited JSON. The harness sends one hello, then one batch per minute, then done.
// Every batch gets exactly one reply that echoes its seq and carries the orders decided on that bar.
// Orders fill at the next bar's open, so everything here is decided from the latest close and from
// the account the batch reports (cash and position), never from what we remember having sent:
// a rejected order (no_bar, max_slippage) is simply sized again on the next batch.
//
// Strategy: a small state machine over one-minute closes.
//   wait  the reference is the first close ('first') or the running high ('high'). Once the close is
//         DIP below it the machine is armed and follows the running low; it enters when the close is
//         REBOUND above that low (0 = at once).
//   in    holds TARGET_BPS of equity. It leaves on a take profit over the entry close, on a trailing
//         stop from the peak (once the gain passed TRAIL_ARM), or on a stop loss; otherwise it holds.
//   done  nothing more, unless re-entries are left: then back to wait with a new reference.
// A probe order on the first batch guarantees one fill on every path, and whatever is held near the
// end is sold in slices before the replay's forced sale.

import { createInterface } from 'node:readline';

const SYMBOL = 'CBBTC';
const MINUTE_MS = 60_000;
const WINDOW_BARS = 1_440; // both windows are 24 h of one-minute bars
const USDC = 1_000_000n;

// ---- settings (shares in bps of equity, moves as fractions of price) ----
const PROBE_UNITS = 1_730_000n; // the first order: 1.73 USDC, a size nobody else sends
const BASE_BPS = 0n; // share held from the first bar, whatever the machine does
const TARGET_BPS = 9_973n; // share held while the machine is in
const REFERENCE: 'first' | 'high' = 'high';
const DIP = 0.002;
const REBOUND = 0;
const ENTER_BY_BAR: number | null = 30; // with no dip by this bar, the first entry is made anyway
const ENTRY_CUTOFF_BAR = WINDOW_BARS; // no new entry after this bar index
const TAKE_PROFIT: number | null = 0.0065;
// The target shrinks in a straight line from TAKE_PROFIT at bar TAKE_PROFIT_DECAY_FROM to
// TAKE_PROFIT_END at the end of the window: with little time left, a smaller gain is the one to take.
const TAKE_PROFIT_END: number | null = 0.002;
const TAKE_PROFIT_DECAY_FROM = 720;
const TRAIL: number | null = null;
const TRAIL_ARM = 0;
// A stop far outside any ordinary day: it only exists to keep a crash inside the 25% drawdown guardrail.
const STOP_LOSS: number | null = 0.16;
const REENTRIES = 0;
const REENTRY_DIP: number | null = null; // DIP for the entries after the first (null = the same)
const REENTRY_REFERENCE: 'first' | 'high' | 'exit' = 'high';
// Orders are cut into slices over consecutive bars: the pool's impact starts again from its open
// depth on every bar, so N slices pay about 1/N of the impact of one order.
const ORDER_SLICES = 8;
const END_SLICES = 6; // the position is sold over the last END_SLICES decision bars
const MAX_SLIPPAGE_BPS = 400;
const FIRST_FILL_SLIPPAGE_BPS = 10_000;
const SLICE_ORDER = /^tyf-[bs]-/; // client ids of the entry and exit slices (not the probe, not the end sale)

interface Bar { symbol: string; t: number; o: string; h: string; l: string; c: string; o_depth: string[]; c_depth: string[] }
interface Position { symbol: string; qty: string; cost_quote_units: string }
interface Account { cash_quote_units: string; positions: Position[]; equity_quote_units: string }
interface Fill { client_id: string; status: 'filled' | 'rejected' }
interface Batch { type: 'batch'; seq: number; t: number; bars: Bar[]; fills: Fill[]; account: Account }
interface Order { side: 'buy' | 'sell'; client_id: string; symbol: string; notional_quote_units?: string; qty?: string; max_slippage_bps: number }

let firstCloseMs = -1;
let minNotional = USDC;
let startCash = 1_000n * USDC;
let orderCount = 0;

// machine state
let mode: 'wait' | 'in' | 'done' = 'wait';
let reference = 0; // price the dip is measured from
let low = 0; // running low once armed
let armed = false;
let entries = 0; // entries made so far
let entry = 0; // close at the entry decision
let peak = 0; // highest close since the entry
let reentriesLeft = REENTRIES;
let dip = DIP;
let targetBps = BASE_BPS;
let slicesLeft = ORDER_SLICES;
let urgentExit = false; // the stop fired: sell without a slippage limit
let seenBar = false;

function clientId(tag: string, seq: number): string {
  orderCount += 1;
  return `tyf-${tag}-${seq}-${orderCount}`;
}

function onHello(hello: any): void {
  firstCloseMs = hello.first_close_ms;
  minNotional = BigInt(hello.fees.min_notional_quote_units);
  startCash = BigInt(hello.capital.quote_units);
}

// One step of the machine on a new close; sets targetBps.
function advance(index: number, close: number): void {
  if (!seenBar) {
    seenBar = true;
    reference = close;
  }
  if (mode === 'wait') {
    if (REFERENCE === 'high' && close > reference) reference = close;
    if (index > ENTRY_CUTOFF_BAR) return;
    // The pool can grind up for hours without a pullback: the first entry is not kept waiting past ENTER_BY_BAR.
    const overdue = entries === 0 && ENTER_BY_BAR !== null && index >= ENTER_BY_BAR;
    if (!armed && (close <= reference * (1 - dip) || overdue)) {
      armed = true;
      low = close;
    }
    if (armed) {
      if (close < low) low = close;
      if (close >= low * (1 + REBOUND)) {
        mode = 'in';
        entries += 1;
        entry = close;
        peak = close;
        targetBps = TARGET_BPS;
        slicesLeft = ORDER_SLICES;
        urgentExit = false;
        armed = false;
      }
    }
    return;
  }
  if (mode === 'in') {
    if (close > peak) peak = close;
    let leave = false;
    if (TAKE_PROFIT !== null) {
      let target = TAKE_PROFIT;
      if (TAKE_PROFIT_END !== null) {
        const progress = Math.max(0, (index - TAKE_PROFIT_DECAY_FROM) / (WINDOW_BARS - TAKE_PROFIT_DECAY_FROM));
        target = TAKE_PROFIT + (TAKE_PROFIT_END - TAKE_PROFIT) * progress;
      }
      if (close >= entry * (1 + target)) leave = true;
    }
    if (TRAIL !== null && peak >= entry * (1 + TRAIL_ARM) && close <= peak * (1 - TRAIL)) leave = true;
    const stopped = STOP_LOSS !== null && close <= entry * (1 - STOP_LOSS);
    if (!leave && !stopped) return;
    targetBps = BASE_BPS;
    // A take profit leaves in slices. The stop leaves at once, in one order with no price limit:
    // it only fires in a crash, where eight more bars could cost more than the impact saved.
    slicesLeft = stopped ? 1 : ORDER_SLICES;
    urgentExit = stopped;
    if (reentriesLeft > 0) {
      reentriesLeft -= 1;
      mode = 'wait';
      if (REENTRY_DIP !== null) dip = REENTRY_DIP;
      if (REENTRY_REFERENCE !== 'first') reference = close;
    } else {
      mode = 'done';
    }
  }
}

function onBatch(batch: Batch): Order[] {
  if (firstCloseMs < 0) firstCloseMs = batch.t;
  const index = Math.round((batch.t - firstCloseMs) / MINUTE_MS); // 0 on the first batch
  // A slice is used up when its order fills, not when it is sent: after a refusal (no bar at the next
  // open, the slippage limit) the same share is cut again, so a gap never merges slices into one order.
  // This runs before the machine advances, because a new entry or exit starts a fresh count.
  for (const fill of batch.fills ?? []) {
    if (fill.status === 'filled' && SLICE_ORDER.test(fill.client_id) && slicesLeft > 1) slicesLeft -= 1;
  }
  const bar = batch.bars.find((b) => b.symbol === SYMBOL);
  if (bar !== undefined) advance(index, Number(bar.c));
  if (!seenBar) return []; // no bar yet: nothing to price an order against

  const cash = BigInt(batch.account.cash_quote_units);
  const equity = BigInt(batch.account.equity_quote_units);
  const held = batch.account.positions.find((p) => p.symbol === SYMBOL);
  const qty = held === undefined ? 0n : BigInt(held.qty);
  const position = equity - cash; // the position at the latest close

  const decisionsLeft = WINDOW_BARS - 1 - index; // batches after this one; 0 on the last batch
  if (decisionsLeft <= 0) return []; // an order decided on the last batch is rejected (after_end)

  // End of the window: sell what is held in equal slices, everything on the last decision bar.
  if (decisionsLeft <= END_SLICES) {
    if (qty === 0n) return [];
    const slice = decisionsLeft === 1 ? qty : qty / BigInt(decisionsLeft);
    if (slice === 0n) return [];
    return [{ side: 'sell', client_id: clientId('z', batch.seq), symbol: SYMBOL, qty: slice.toString(), max_slippage_bps: MAX_SLIPPAGE_BPS }];
  }

  const want = (equity * targetBps) / 10_000n;
  const threshold = (3n * USDC) / 2n;
  const slices = BigInt(Math.max(1, slicesLeft));
  // Until our own first fill the limit is wide open: the guardrail needs one filled order.
  const untouched = qty === 0n && cash === startCash;
  const buyLimit = untouched ? FIRST_FILL_SLIPPAGE_BPS : MAX_SLIPPAGE_BPS;

  if (want - position >= threshold && cash >= minNotional) {
    let spend = (want - position) / slices;
    if (spend < minNotional) spend = minNotional;
    if (spend > cash) spend = cash;
    return [{ side: 'buy', client_id: clientId('b', batch.seq), symbol: SYMBOL, notional_quote_units: spend.toString(), max_slippage_bps: buyLimit }];
  }
  // Selling needs a wider gap than buying, so the probe is never sold back on its own.
  if (position - want >= 3n * USDC && qty > 0n) {
    let amount = targetBps === 0n && slicesLeft <= 1 ? qty : (qty * (position - want)) / (position * slices);
    if (amount > qty) amount = qty;
    if (amount === 0n) return [];
    const sellLimit = urgentExit ? FIRST_FILL_SLIPPAGE_BPS : MAX_SLIPPAGE_BPS;
    return [{ side: 'sell', client_id: clientId('s', batch.seq), symbol: SYMBOL, qty: amount.toString(), max_slippage_bps: sellLimit }];
  }
  // The probe: sent again on every batch until one order of ours has filled.
  if (untouched && PROBE_UNITS >= minNotional) {
    return [{ side: 'buy', client_id: clientId('p', batch.seq), symbol: SYMBOL, notional_quote_units: PROBE_UNITS.toString(), max_slippage_bps: FIRST_FILL_SLIPPAGE_BPS }];
  }
  return [];
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
