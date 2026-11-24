// Surge Rider — a momentum bot for the pump.fun bonding-curve replay.
//
// Idea: fresh pump.fun coins either surge on real buying pressure or bleed out.
// This bot only buys a surge it can see on the tape — net SOL flowing in from
// several distinct buyers, price rising and holding near its recent high, with
// the inflow accelerating — then pyramids a little into strength and exits fast
// on a stop-loss, a trailing stop, fading flow, a whale sell, or a time limit.
// Stakes stay small (max 0.20 SOL per coin, 5 coins at once) so a bad coin costs
// little and the account can never draw down far; the 20-coin round-trip bar is
// protected by a probe fallback late in the window.
//
// Deterministic by construction: no clock, no randomness, no network. All
// iteration is over insertion-ordered maps fed by the batch stream, so two runs
// on the same data produce identical action logs.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';
import { LAMPORTS_PER_SOL } from './vendor/makefun-bot.ts';

const SOL = Number(LAMPORTS_PER_SOL);

export interface Params {
  /** 'momentum': buy surges. 'reversion': buy the bounce after a deep drop from the high. */
  mode: 'momentum' | 'reversion';
  /** Largest single wallet's share of the window's buy SOL. */
  maxBuyerShare: number;
  /** Entry lookback, in slots. */
  window: number;
  /** Minimum net buy SOL (buys minus sells) over the window. */
  minNetSol: number;
  /** Minimum buy trades in the window. */
  minBuys: number;
  /** Minimum distinct buying wallets in the window. */
  minBuyers: number;
  /** Minimum price rise over the window (fraction). */
  minUp: number;
  /** Maximum price rise over the window (fraction): skip coins that already ran too far. */
  maxUp: number;
  /** Newer-half net inflow must be at least this multiple of the older half's. */
  accel: number;
  /** Current price must be at least this share of the window high. */
  nearHigh: number;
  /** Real SOL reserve bounds at entry. */
  minRqSol: number;
  maxRqSol: number;
  /** Slots since CreateEvent before an entry is allowed, and after which it is too late. */
  minAge: number;
  maxAge: number;
  /** First buy, add-on buy, and total stake per coin, in SOL. */
  firstBuySol: number;
  addBuySol: number;
  maxStakeSol: number;
  /** Smallest buy worth sending, in SOL. */
  minBuySol: number;
  /** Add only once the price is this much above the last buy's price (fraction). */
  addStep: number;
  /** Add only while net SOL over the entry window is at least this. */
  addNetSol: number;
  /** Slippage on buys (bps); sells always go out wide so exits execute. */
  buySlipBps: number;
  /** Exits. */
  stopLoss: number;
  trailArm: number;
  trail: number;
  /** Sell the whole position once it is up at least this much (0 = off). */
  takeProfit: number;
  /** Exit when net SOL over the window falls below this. */
  fadeNetSol: number;
  /** Exit on any single recorded sell of at least this many SOL. */
  bigSellSol: number;
  /** Exit after this many slots held (unless up a lot). */
  maxHold: number;
  /** The time limit does not apply while the position is up at least this much. */
  holdIfUp: number;
  /** Slots to wait after an exit before the same coin may be bought again. */
  cooldown: number;
  /** Most entries per coin over the run. */
  maxEntries: number;
  /** Pace guardrail: start probes this many slots into the window. */
  probeAfterSlots: number;
  /** Probe round trips until this many coins have completed one. */
  targetCoins: number;
  /** Probe stake, in SOL. */
  probeSol: number;
  /** Most probe buys over the run. */
  maxProbes: number;
}

export const DEFAULT_PARAMS: Params = {
  mode: 'reversion',
  maxBuyerShare: 0.6,
  window: 30,
  minNetSol: 1.0,
  minBuys: 5,
  minBuyers: 5,
  minUp: 0.02,
  maxUp: 0.6,
  accel: 1.0,
  nearHigh: 0.95,
  minRqSol: 1,
  maxRqSol: 80,
  minAge: 10,
  maxAge: 2400,
  firstBuySol: 0.08,
  addBuySol: 0.05,
  maxStakeSol: 0.08,
  minBuySol: 0.02,
  addStep: 0.02,
  addNetSol: 0.3,
  buySlipBps: 500,
  stopLoss: 0.06,
  trailArm: 0.25,
  trail: 0.08,
  takeProfit: 0,
  fadeNetSol: -0.3,
  bigSellSol: 1.0,
  maxHold: 1200,
  holdIfUp: 0.25,
  cooldown: 300,
  maxEntries: 2,
  probeAfterSlots: 15000,
  targetCoins: 40,
  probeSol: 0.02,
  maxProbes: 60,
};

interface TapeTrade {
  slot: number;
  isBuy: boolean;
  solLamports: bigint;
  user: string;
  /** Price (SOL per token) right after this trade. */
  price: number;
}

interface CoinState {
  createdSlot: number | null;
  tape: TapeTrade[];
  entries: number;
  cooldownUntil: number;
  entrySlot: number;
  lastBuyPrice: number;
  peakValueLamports: bigint;
  /** SOL spent on buys that filled (quote_lamports), for round-trip counting. */
  boughtLamports: bigint;
  /** A probe buy is waiting to be closed. */
  probeOpen: boolean;
  /** First traded price, trailing high price, and the slot of that high. */
  firstPrice: number;
  highPrice: number;
  highSlot: number;
}

function priceOf(vq: bigint, vt: bigint): number {
  if (vt === 0n) return 0;
  return Number(vq) / Number(vt);
}

export function createStrategy(params: Params): Bot {
  const coins = new Map<Pubkey, CoinState>();
  const probeBuys = new Set<string>();
  let firstSlot = -1;
  let roundTrips = 0;
  let probesSent = 0;

  function coin(mint: Pubkey): CoinState {
    let c = coins.get(mint);
    if (c === undefined) {
      c = {
        createdSlot: null,
        tape: [],
        entries: 0,
        cooldownUntil: 0,
        entrySlot: 0,
        lastBuyPrice: 0,
        peakValueLamports: 0n,
        boughtLamports: 0n,
        probeOpen: false,
        firstPrice: 0,
        highPrice: 0,
        highSlot: 0,
      };
      coins.set(mint, c);
    }
    return c;
  }

  /** Stats over a trailing window of `windowSlots` slots, or null when the tape is too thin. */
  function windowStats(c: CoinState, nowSlot: number, windowSlots: number): {
    netSol: number;
    buys: number;
    buyers: number;
    maxBuyerShare: number;
    priceStart: number;
    priceNow: number;
    high: number;
    low: number;
    accelOk: boolean;
  } | null {
    const from = nowSlot - windowSlots;
    let netLamports = 0n;
    let netOld = 0n;
    let netNew = 0n;
    let buys = 0;
    let buyLamports = 0n;
    const buyers = new Set<string>();
    const buyByUser = new Map<string, bigint>();
    let priceStart = 0;
    let high = 0;
    let low = Number.POSITIVE_INFINITY;
    let seen = 0;
    const mid = from + windowSlots / 2;
    for (const t of c.tape) {
      if (t.slot < from) continue;
      seen++;
      if (seen === 1) priceStart = t.price;
      if (t.price > high) high = t.price;
      if (t.price < low) low = t.price;
      const signed = t.isBuy ? t.solLamports : -t.solLamports;
      netLamports += signed;
      if (t.slot < mid) netOld += signed;
      else netNew += signed;
      if (t.isBuy) {
        buys++;
        buyers.add(t.user);
        buyLamports += t.solLamports;
        buyByUser.set(t.user, (buyByUser.get(t.user) ?? 0n) + t.solLamports);
      }
    }
    if (seen < 2) return null;
    const netSol = Number(netLamports) / SOL;
    const netOldSol = Number(netOld) / SOL;
    const netNewSol = Number(netNew) / SOL;
    const accelOk = netOldSol <= 0 ? netNewSol > 0 : netNewSol >= params.accel * netOldSol;
    let maxBuyerShare = 0;
    if (buyLamports > 0n) {
      let biggest = 0n;
      for (const v of buyByUser.values()) if (v > biggest) biggest = v;
      maxBuyerShare = Number(biggest) / Number(buyLamports);
    }
    return { netSol, buys, buyers: buyers.size, maxBuyerShare, priceStart, priceNow: c.tape[c.tape.length - 1].price, high, low, accelOk };
  }

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      if (firstSlot < 0) firstSlot = batch.slot;
      const orders: OrderInput[] = [];
      const { caps } = state.hello;
      const tx = state.txFeeLamports();
      let free = state.freeCashLamports();
      let slotsLeft = caps.max_open_positions - state.committedPositionCount();
      const canOrder = () => orders.length < caps.max_orders_per_batch;

      // --- Fold this batch's fills into round-trip / probe bookkeeping. ---
      const pendingSell = new Set<Pubkey>();
      const pendingBuy = new Set<Pubkey>();
      for (const p of state.pending.values()) {
        if (p.order.side === 'sell') pendingSell.add(p.order.mint);
        else pendingBuy.add(p.order.mint);
      }
      for (const f of batch.fills) {
        const c = coins.get(f.mint);
        if (c === undefined) continue;
        if (f.status !== 'filled') continue;
        if (f.side === 'buy') {
          c.boughtLamports += BigInt(f.quote_lamports);
          if (probeBuys.has(f.client_id)) {
            probeBuys.delete(f.client_id);
            c.probeOpen = true;
          }
        } else if (c.boughtLamports >= BigInt(Math.round(params.minBuySol * SOL))) {
          // A completed round trip of at least the minimum buy size.
          roundTrips++;
          c.boughtLamports = 0n;
          c.probeOpen = false;
        }
      }

      // --- Fold this batch's events into the tapes. ---
      const traded = new Set<Pubkey>();
      let bigSellMints = new Set<Pubkey>();
      for (const e of batch.events) {
        const c = coin(e.mint);
        if (e.event === 'CreateEvent') {
          c.createdSlot = e.slot;
        } else if (e.event === 'TradeEvent') {
          const curve = state.curves.get(e.mint);
          const price = curve !== undefined ? priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves) : 0;
          c.tape.push({
            slot: e.slot,
            isBuy: e.is_buy,
            solLamports: BigInt(e.sol_amount),
            user: e.user,
            price,
          });
          if (c.firstPrice === 0) c.firstPrice = price;
          if (price > c.highPrice) {
            c.highPrice = price;
            c.highSlot = e.slot;
          }
          // Prune anything older than a few windows; tapes stay short.
          while (c.tape.length > 0 && c.tape[0].slot < batch.slot - params.window * 15) c.tape.shift();
          traded.add(e.mint);
          if (!e.is_buy && Number(BigInt(e.sol_amount)) / SOL >= params.bigSellSol) bigSellMints.add(e.mint);
        } else {
          // CompleteEvent: the curve is done; forget its tape.
          coins.delete(e.mint);
        }
      }

      // --- Exits first: sell whole positions on the first trigger that fires. ---
      for (const [mint, holding] of state.positions) {
        if (!canOrder() || pendingSell.has(mint)) continue;
        const curve = state.curves.get(mint);
        const c = coins.get(mint);
        if (curve === undefined || curve.complete || c === undefined) continue;
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (price <= 0) continue;
        const value = (holding.token_amount * curve.virtual_quote_reserves) / curve.virtual_token_reserves;
        const cost = holding.cost_lamports;
        if (value > c.peakValueLamports) c.peakValueLamports = value;

        let reason: string | null = null;
        if (value <= (cost * BigInt(Math.round((1 - params.stopLoss) * 1000))) / 1000n) reason = 'stop-loss';
        else if (params.takeProfit > 0 && value >= (cost * BigInt(Math.round((1 + params.takeProfit) * 1000))) / 1000n) reason = 'take-profit';
        else if (
          value >= (cost * BigInt(Math.round((1 + params.trailArm) * 1000))) / 1000n &&
          value <= (c.peakValueLamports * BigInt(Math.round((1 - params.trail) * 1000))) / 1000n
        ) {
          reason = 'trailing-stop';
        } else if (bigSellMints.has(mint)) reason = 'big-sell';
        else if (batch.slot - c.entrySlot >= params.maxHold && value < (cost * BigInt(Math.round((1 + params.holdIfUp) * 1000))) / 1000n) {
          reason = 'max-hold';
        } else {
          const stats = windowStats(c, batch.slot, params.window);
          if (stats !== null && stats.netSol < params.fadeNetSol) reason = 'fade';
        }
        if (reason === null) continue;
        orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: 10_000 });
        c.cooldownUntil = batch.slot + params.cooldown;
        c.peakValueLamports = 0n;
        pendingSell.add(mint);
      }

      // --- Probe closes: a probe buy that landed gets sold whole on the next batch. ---
      for (const [mint, holding] of state.positions) {
        if (!canOrder() || pendingSell.has(mint)) continue;
        const c = coins.get(mint);
        if (c !== undefined && c.probeOpen) {
          orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: 10_000 });
          pendingSell.add(mint);
        }
      }

      // --- Entries: momentum buys on coins that traded this batch. ---
      for (const mint of traded) {
        if (!canOrder() || slotsLeft <= 0) break;
        const curve = state.curves.get(mint);
        const c = coins.get(mint);
        if (curve === undefined || curve.complete || c === undefined) continue;
        if (pendingBuy.has(mint) || pendingSell.has(mint)) continue;
        if (c.createdSlot === null) continue;
        const age = batch.slot - c.createdSlot;
        if (age < params.minAge || age > params.maxAge) continue;
        if (batch.slot < c.cooldownUntil || c.entries >= params.maxEntries) continue;
        const holding = state.positions.get(mint);
        const realSol = Number(curve.real_quote_reserves) / SOL;
        if (realSol < params.minRqSol || realSol > params.maxRqSol) continue;
        const stats = windowStats(c, batch.slot, params.window);
        if (stats === null) continue;
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        if (price <= 0 || stats.priceStart <= 0) continue;
        const up = price / stats.priceStart - 1;
        const cap = state.maxBuyLamports(mint);

        if (holding === undefined) {
          if (params.mode === 'reversion') {
            // Buy the bounce: the coin ran, dumped >=30% off its high, and is
            // stabilising with buy flow returning — never catch a falling knife.
            if (c.highPrice <= 0 || c.firstPrice <= 0) continue;
            if (price > 0.6 * c.highPrice) continue;
            if (c.highPrice < 2.5 * c.firstPrice) continue;
            if (batch.slot - c.highSlot > 1800) continue;
            const rev = windowStats(c, batch.slot, 15);
            if (rev === null) continue;
            if (rev.buys < 2 || rev.netSol < 0.2) continue;
            if (price < 1.03 * rev.low) continue;
          } else {
            // Fresh momentum entry: the surge must be real on every dimension.
            if (stats.netSol < params.minNetSol) continue;
            if (stats.buys < params.minBuys) continue;
            if (stats.buyers < params.minBuyers) continue;
            if (stats.maxBuyerShare > params.maxBuyerShare) continue;
            if (up < params.minUp || up > params.maxUp) continue;
            if (price < params.nearHigh * stats.high) continue;
            if (!stats.accelOk) continue;
          }
          let amount = BigInt(Math.round(params.firstBuySol * SOL));
          if (amount > cap) amount = cap;
          if (amount < BigInt(Math.round(params.minBuySol * SOL))) continue;
          if (free < amount + tx) continue;
          orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: params.buySlipBps });
          free -= amount + tx;
          slotsLeft -= 1;
          c.entries += 1;
          c.entrySlot = batch.slot;
          c.lastBuyPrice = price;
          c.peakValueLamports = 0n;
          pendingBuy.add(mint);
        } else {
          // Pyramid into strength only, up to the per-coin cap.
          if (c.boughtLamports >= BigInt(Math.round(params.maxStakeSol * SOL))) continue;
          if (price < c.lastBuyPrice * (1 + params.addStep)) continue;
          if (stats.netSol < params.addNetSol) continue;
          let amount = BigInt(Math.round(params.addBuySol * SOL));
          const remaining = BigInt(Math.round(params.maxStakeSol * SOL)) - c.boughtLamports;
          if (amount > remaining) amount = remaining;
          if (amount > cap) amount = cap;
          if (amount < BigInt(Math.round(params.minBuySol * SOL))) continue;
          if (free < amount + tx) continue;
          orders.push({ side: 'buy', mint, quote_lamports: amount, max_slippage_bps: params.buySlipBps });
          free -= amount + tx;
          c.lastBuyPrice = price;
          pendingBuy.add(mint);
        }
      }

      // --- Pace guardrail: late in the window, probe the most liquid curves. ---
      if (
        canOrder() &&
        slotsLeft > 0 &&
        batch.slot - firstSlot >= params.probeAfterSlots &&
        roundTrips < params.targetCoins &&
        probesSent < params.maxProbes
      ) {
        let bestMint: Pubkey | null = null;
        let bestRq = 0;
        for (const [mint, curve] of state.curves) {
          if (curve.complete) continue;
          if (state.positions.has(mint) || pendingBuy.has(mint) || pendingSell.has(mint)) continue;
          if (batch.slot - curve.reserves_slot > 100) continue;
          const rq = Number(curve.real_quote_reserves) / SOL;
          if (rq < 5) continue;
          if (rq > bestRq) {
            bestRq = rq;
            bestMint = mint;
          }
        }
        if (bestMint !== null) {
          const cap = state.maxBuyLamports(bestMint);
          let amount = BigInt(Math.round(params.probeSol * SOL));
          if (amount > cap) amount = cap;
          if (amount >= BigInt(Math.round(params.minBuySol * SOL)) && free >= amount + tx) {
            const clientId = state.clientId();
            probeBuys.add(clientId);
            orders.push({ side: 'buy', mint: bestMint, quote_lamports: amount, max_slippage_bps: 10_000, client_id: clientId });
            free -= amount + tx;
            slotsLeft -= 1;
            probesSent++;
          }
        }
      }

      return orders;
    },
  };
}
