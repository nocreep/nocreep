# nocreep

nocreep is an opencode tool plugin that allows the model to strip or prune the last tool call output(s) right after they return, which doesn’t save tokens directly but decreases token creep without any negative performance impact, since the same frontier model decides which outputs to strip and never retroactively removes any outputs later.

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
