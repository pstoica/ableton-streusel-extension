# Releasing

Streusel ships as an Ableton **`.ablx`** extension archive. There's no public
marketplace yet (Live Extensions are beta + Developer Mode), so a "release" is a
GitHub Release with the `.ablx` attached.

> **The build can't run on CI.** The bundle imports the Ableton SDK as runtime
> values, and the SDK is a local-only tarball dependency — so `npm run package`
> must run **locally** where the SDK is installed. CI only runs the test suite
> (which imports the SDK as types only).

## Steps

1. **Clean tree on `main`, tests green:**
   ```bash
   git switch main && git pull
   npm test
   ```

2. **Bump the version in BOTH files (keep them in sync):**
   - `package.json` → `"version"`
   - `manifest.json` → `"version"`

   ```bash
   git commit -am "Release vX.Y.Z"
   ```

3. **Build the archive:**
   ```bash
   npm run package          # → streusel-X.Y.Z.ablx (gitignored)
   ```

4. **Smoke-test the `.ablx`** in Ableton Live 12 Beta with Developer Mode on
   (Settings → Extensions). Confirm a clip name like `0 2 4 | rev @4` evaluates.

5. **Tag and push:**
   ```bash
   git tag -a vX.Y.Z -m "Streusel vX.Y.Z"
   git push origin main --tags
   ```

6. **Create the GitHub Release with the artifact:**
   ```bash
   gh release create vX.Y.Z streusel-X.Y.Z.ablx \
     --title "Streusel vX.Y.Z" \
     --notes "Beta. Requires Ableton Live 12 Beta with Extensions Developer Mode enabled."
   ```

## Install notes (for the release body)

1. Download `streusel-X.Y.Z.ablx`.
2. In Live 12 Beta: **Settings → Extensions → enable Developer Mode**.
3. Install the `.ablx` (drag in, or per Live's extension install flow).
4. Name a MIDI clip with a Streusel pattern (e.g. `0 2 4 5 | rev @4`), right-click →
   **Evaluate + propagate**.

## Versioning

`0.x` while the Ableton Extensions API and this language are still moving. Bump the
minor for new language features, patch for fixes. `manifest.minimumApiVersion`
tracks the SDK API the build targets.
