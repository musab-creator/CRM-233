# Roof Measure — vendored copy

These files are copied **unmodified** from
https://github.com/musab-creator/roof-measure (commit `3a11299`), published at
https://musab-creator.github.io/roof-measure/.

Do not edit them here. Change the tool in its own repo, then copy the files
over again (`index.html`, `*.js`, `styles.css`).

What the CRM adds around them, without touching them:

- `permits/` is not copied (~42 MB). `next.config.ts` serves
  `/tools/roof-measure/permits/*` from the published site, so a permit-index
  refresh uploaded there shows up here too.
- `/relay/pao` and `/relay/clay` (`src/app/relay/`) are Next.js ports of the
  relays in the tool's `serve.ps1`. The tool only calls them when it runs on
  localhost.
- The Roof Reports page frames `index.html` and reads the traced roof through
  the tool's own `computeTotals()` and `serialize()`
  (`src/lib/roof-measure-bridge.ts`).
