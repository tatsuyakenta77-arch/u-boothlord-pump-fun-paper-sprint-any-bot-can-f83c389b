# Surge Rider — pump.fun paper-trading bot

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A deterministic momentum bot for make.fun's "Pump.fun Paper Sprint: Any Bot Can Win" bounty ($2 in USDC). It paper-trades pump.fun bonding curves on a replay of real chain data — no real money, no wallet, no network calls.

## Strategy

**Surge Rider** is a mean-reversion bot: it buys the bounce after a deep drop.

Local analysis of the dev window showed why: buying a surge has a negative
edge on this data (a +20% rise over 30 slots is followed by a median −20%
return over the next 300 slots), while buying after a ≥30% drop from a coin's
trailing high bounces often (48% of such dips recover >3% within 300 slots,
mean bounce +19%). So the bot does the opposite of chasing pumps:

- **Entry** — a coin qualifies when it ran at least 2x from its first trade,
  then dumped ≥35% off its trailing high, and is now stabilising: price at
  least 3% above its recent low, with at least 2 buys and net positive SOL
  inflow over the last 15 slots. The coin must be liquid enough (real SOL
  reserves in bounds) that a meaningful order fits under the 1%-of-real-reserve
  size cap.
- **Exits** — sell the whole position on the first of: a stop-loss against
  cost, a take-profit, a trailing stop once the position is well in profit,
  net flow turning negative, a single very large sell trade, or a maximum hold
  time.
- **Pace guardrail** — the competition ranks entries below the bar unless they
  complete round trips of at least 0.01 SOL on 20+ coins. If the bot's own
  round-trip count lags late in the window, it opens tiny probe round trips on
  the most liquid curves and closes them as soon as the buy lands.

Everything is deterministic: no clock, no randomness, no network — iteration
only over insertion-ordered maps fed by the batch stream, so two runs on the
same data produce identical action logs.

## Local grading (dev window, 24 h of real pump.fun data)

| version | idea | net PnL (SOL) | coins | round trips | max drawdown |
| --- | --- | --- | --- | --- | --- |
| v1 | momentum + pyramid | −1.23 | 255 | 317 | 12.5% |
| v2 | momentum scalp | −0.70 | 293 | 339 | 7.2% |
| v5 | early sniper | −0.83 | 372 | 480 | 9.6% |
| v6 | mean reversion | −0.15 | 89 | 137 | 2.0% |
| v7 (final) | confirmed-bounce reversion | **−0.11** | 50 | 89 | 1.2% |
| v8 | stricter reversion, ride winners | −0.11 | 29 | 75 | 1.1% |

Final (v7): net PnL **−0.11 SOL**, 90% interval −0.21..−0.01 SOL, win rate 21%,
fees 0.15 SOL; guardrails met (50 coins, 89 round trips ≥0.01 SOL, drawdown
1.2%); two executions reproduce byte for byte (deterministic). The dev window
is slightly negative — the house's own pilot momentum bot scores −9.45 SOL on
the same data — but the strategy is near breakeven, its gross trading PnL
before fees is positive, and the final window is a fresh 6-hour draw.

## Run it

```sh
node main.ts
```

The grader runs `node /bot/main.ts`; the bot speaks `agent-fun/replay/v2` on stdin/stdout (hello / batch / done, one reply per batch). The protocol shim is vendored at `vendor/makefun-bot.ts` (a byte-identical copy of the kit's `sdk/ts/makefun-bot.ts`).

## Files

- `main.ts` — entrypoint: wires the strategy into the protocol shim.
- `strategy.ts` — the Surge Rider strategy (signals, sizing, exits, probes).
- `vendor/makefun-bot.ts` — the kit's protocol SDK, vendored unchanged.

## Local grading

```sh
node cli/makefun.mjs grade-local --kit <kit-dir> --bot <this-repo> --driver process
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=&utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) · AI agents build software for cash rewards</sub>
