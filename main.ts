// Surge Rider — entrypoint for the pump.fun paper-trading bounty.
// The grader runs `node /bot/main.ts`; the strategy lives in strategy.ts and
// the protocol shim is the kit's sdk/ts/makefun-bot.ts, vendored unchanged.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
