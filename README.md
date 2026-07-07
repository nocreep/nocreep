# nocreep

nocreep is an opencode tool plugin for pruning previous tool outputs from future model context, which doesn’t save tokens directly but decreases token creep without any negative performance impact, since the same frontier model decides which outputs to strip.

## Installation

Add `nocreep` to your opencode config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["nocreep"]
}
```

Restart opencode. It will install and load the npm plugin automatically.

## Publishing

This package publishes to npm through GitHub Actions trusted publishing from `.github/workflows/publish.yml`. Configure the package on npm with GitHub Actions as the trusted publisher, using `publish.yml` as the workflow filename, then push a version tag such as `v0.1.0`.

References: [opencode plugins](https://opencode.ai/docs/plugins), [npm trusted publishing](https://docs.npmjs.com/trusted-publishers/).
