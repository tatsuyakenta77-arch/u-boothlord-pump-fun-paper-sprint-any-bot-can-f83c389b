# Surge Rider — pump.fun paper-trading bot

[![make.fun · u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b?utm_source=github&utm_medium=readme&utm_campaign=u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

A deterministic momentum bot for make.fun's "Pump.fun Paper Sprint: Any Bot Can Win" bounty ($2 in USDC). It paper-trades pump.fun bonding curves on a replay of real chain data — no real money, no wallet, no network calls.

## Strategy

**Surge Rider** rides short-lived buying surges on fresh pump.fun coins and gets out fast:

- **Entry** — a coin qualifies when it is old enough to have shaken out bundled-launch dumps (min age in slots) but still young, and its recent tape shows a real surge: strong net SOL inflow from buys, several distinct buyers, price up versus the window start and sitting near the window high, with inflow accelerating in the newer half of the window. The coin must also be liquid enough (real SOL reserves in bounds) that a meaningful order fits under the 1%-of-real-reserve size cap.
- **Pyramiding** — the first buy is small. The bot adds the same small size while the price holds above the last buy and inflow stays positive, up to a per-coin cap, so false starts cost little and runners get size.
- **Exits** — sell the whole position on the first of: a stop-loss against cost, a trailing stop once the position is well in profit, net flow turning negative, a single very large sell trade, or a maximum hold time.
- **Pace guardrail** — the competition ranks entries below the bar unless they complete round trips of at least 0.01 SOL on 20+ coins. If the bot's own round-trip count lags late in the window, it opens tiny probe round trips on the most liquid curves and closes them as soon as the buy lands.

Everything is deterministic: no clock, no randomness, no network — iteration only over insertion-ordered maps fed by the batch stream, so two runs on the same data produce identical action logs.

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
