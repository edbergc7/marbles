# Contributing to Marbles

Marbles is an Electron app: Svelte 5 for the window, TypeScript throughout, built with `electron-vite` and packaged with `electron-builder`. [Where things are](#where-things-are) shows how the parts fit together.

You need Node 24 or later and [pnpm](https://pnpm.io).

## Run from source

```bash
pnpm install
pnpm dev
```

`pnpm dev` opens the app window. Edits to the window's code hot-reload. Edits under `src/main` or `src/preload` restart the app. Don't add `--host`, because electron-vite rejects it.

The window needs Electron's preload script, so opening the dev server's address in a plain browser only shows loading spinners.

To try things without touching your real library, point a dev build at a throwaway data folder:

```bash
MARBLES_USER_DATA=/tmp/marbles-test pnpm dev
```

`pnpm dev:gl` turns on software WebGL for machines with no GPU, such as containers and virtual machines.

## Checks

Run these before sending a change:

```bash
pnpm typecheck   # tsc and svelte-check
pnpm lint        # eslint
pnpm test        # the node test scripts in scripts/test-*.mjs
pnpm format      # prettier, rewrites files
```

## Build

```bash
pnpm build                # typecheck and compile to out/
pnpm start                # run the compiled build from out/
pnpm build:linux          # AppImage → dist/linux/marbles-<version>.AppImage
pnpm build:win            # installer and zip → dist/win/ (on Windows, or Linux with Wine)
pnpm build:win:zip        # zip only → dist/win/marbles-<version>-win-x64.zip (works on Linux)
pnpm build:mac            # dmg for Apple silicon and Intel → dist/mac/ (on a Mac only)
pnpm build:unpack         # unpacked app only, faster, for testing a packaged build
```

Each system builds into its own folder under `dist`. The version in the file name comes from `version` in `package.json`.

Releases are built by GitHub Actions (`.github/workflows/release.yml`) on Windows, macOS and Linux. Pushing a tag like `v1.2.0` that matches `version` in `package.json` builds all three and attaches them to a draft release, which a maintainer checks and publishes. You can also run the workflow by hand from the Actions tab to get the builds without a release.

Builds are not code-signed, on purpose, so Windows and macOS show a warning on first launch. The README explains how to get past it.

pnpm only runs the install scripts listed under `allowBuilds` in `pnpm-workspace.yaml`. Say so in your pull request if a change needs a new one.

## Sample data

```bash
pnpm seed                       # add sample apps to the configured library
pnpm seed -- --dir <path>       # seed a specific library folder
```

Apps that already exist by name are skipped.

## Where things are

| Path                 | What                                                                   |
| -------------------- | ---------------------------------------------------------------------- |
| `src/main`           | Main process: library, generation, AI providers, sandbox protocol, IPC |
| `src/main/prompts`   | The prompts sent to the model                                          |
| `src/preload`        | The bridge between the main process and the window                     |
| `src/renderer`       | The window (Svelte)                                                    |
| `src/shared`         | Types used on both sides                                               |
| `design/design.css`  | The stylesheet shared by the window and every generated app            |
| `scripts/test-*.mjs` | Tests                                                                  |
| `scripts/bench-*`    | Model benchmarks. `bench-gen.mjs` spends real OpenRouter credit        |

Model-written code is untrusted. Generated apps run in a sandboxed frame with no network access of their own, and reach storage, the network and the AI provider only through the bridge in `src/main/services/bridge.ts`. Changes that widen what a generated app can do need a clear reason.

## Licence

Marbles is licensed under the [GPL v3 or later](LICENSE). By contributing you agree that your contribution is under the same licence.
