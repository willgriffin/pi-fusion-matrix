# Third-party notices

This repository contains material derived from other projects. Their notices are reproduced here, as
their licences require.

## pi-fusion — `@quarkos/pi-fusion`

- Upstream: <https://github.com/QuarkOS/Pi-Fusion>
- npm: <https://www.npmjs.com/package/@quarkos/pi-fusion>
- Author: Antigravity Pair · Licence: MIT · Copyright (c) 2026 Quark

**What came from it.** The persona prompts in `prompts/*.md` were **transcribed verbatim** from its
`pi-harness.config.json`, so those files — and this notice — travel together. Its pipeline order,
prompt-assembly headers, failure taxonomy (quota / credential / missing model / transient), the
temperature-rejection memory, and the `streamSimple` event sequence were **re-derived** into this
repository's own code: the upstream project is a reference, never a dependency, and no file here
imports it. The vendored, locally-patched copy used as the working reference during implementation
(`@quarkos/pi-fusion-vendored`) was archived out of the pi extensions directory once verification
passed; see `docs/plan.md` §Critical files & anchors.

```
MIT License

Copyright (c) 2026 Quark

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## SemIf

- Upstream: <https://github.com/TheoLeeCJ/SemIf> — formerly OpenJev, by TheoLeeCJ, **MIT**, an
  independent project unaffiliated with TypeSafe.
- Used by `tools/semif-server/`, which wraps it unmodified: the server imports `semif_phase1` from a
  SemIf checkout and reimplements neither the model loading nor the logit readout. SemIf is not
  vendored into this repository.

## TypeSafe

- Hosted decision backend: <https://api.typesafe.ai> · docs: <https://docs.typesafe.ai>
- The default `decide` backend. `extensions/pi-fusion-matrix/decide.js` is an original client for its
  documented `/v1/systemone` request and response shapes; no code is taken from TypeSafe.

## Harnesses

This extension runs inside a harness that owns providers, credentials, transport, and accounting, and
it re-derives both harnesses' extension surfaces rather than depending on their internals.

- **pi** — `@earendil-works/pi-coding-agent`, MIT, © Mario Zechner · <https://github.com/earendil-works/pi> · <https://pi.dev>
- **omp** — `@oh-my-pi/pi-coding-agent`, MIT, © Stencil Labs, Inc. · <https://github.com/can1357/oh-my-pi> · <https://omp.sh>