# nocreep

nocreep is an opencode tool plugi for pruning previous tool outputs from future model context, avoiding context creep.

It allows the model to strip or prune the last tool call output(s) right after they return, removing them from the context of future generation.

This doesn’t save tokens directly but decreases token creep without any negative performance impact, since the same frontier model decides which outputs to strip and never retroactively removes any outputs later.

## Installation

Add `nocreep` to your opencode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["nocreep"]
}
```

Restart opencode. It will install and load the npm plugin automatically.

References: [opencode plugins](https://opencode.ai/docs/plugins)

## License

Copyright (c) 2026 Linus Schlumberger

MIT License, see [LICENSE.md](LICENSE.md).
