# Deploying SADataCopilot

Three ways to run the extension, from fastest feedback loop to public release.

| Mode | When to use | Audience |
|---|---|---|
| Live Extension Development Host (F5) | Iterating on code | You |
| `code --install-extension *.vsix` | Sanity-checking the packaged build, sharing a `.vsix` with a teammate | You + a few testers |
| `vsce publish` | Public release | Marketplace users |

All commands assume `cwd = vscode/`.

## Prerequisites

```bash
cd ~/Desktop/claude/vscode
npm install
```

For the Copilot backend, users (including you, when testing) need the Copilot CLI on disk:

```bash
npm install -g @github/copilot
```

The extension lazy-loads the bundled SDK from this global install — it is **not** packaged into the `.vsix`.

## 1. Live Extension Development Host (F5)

Fastest loop: edit, recompile, reload.

```bash
npm run watch    # leave this running; rebuilds on save
```

Then in VS Code:

1. Open the `vscode/` folder.
2. Press **F5** (or **Run → Start Debugging**) — a new window labelled **"[Extension Development Host]"** opens.
3. Open or create an `.ipynb` in that window.
4. Click **+ Prompt** in the toolbar, type a question, run the cell.

After editing extension code:

- If `npm run watch` is running → just reload the dev host window (**Cmd+Shift+P → "Developer: Reload Window"**).
- If not → run `npm run compile` first, then reload.

The Extension Development Host loads `out/extension.js`, **not** `src/`. Source edits without a rebuild won't take effect.

Logs from the extension host go to **Help → Toggle Developer Tools → Console**. `console.log` from your extension code shows up there.

## 2. Local install via `code --install-extension`

Use this to validate the packaged `.vsix` end-to-end before publishing — it exercises `.vscodeignore`, `package.json` activation events, and the actual lazy-load path the marketplace user will hit.

```bash
npm run compile
npx @vscode/vsce package        # produces sadatacopilot-<version>.vsix
code --install-extension sadatacopilot-0.2.0.vsix --force
```

Then **reload any open VS Code window** (Cmd+Shift+P → "Developer: Reload Window") so the new build picks up.

To uninstall:

```bash
code --uninstall-extension SoftAdvice.sadatacopilot
```

If `code` is not on your `PATH`: open VS Code → **Cmd+Shift+P → "Shell Command: Install 'code' command in PATH"**.

The `--force` flag overwrites the previously installed version without prompting — useful when iterating on the same version number.

## 3. Publish to the Marketplace

### One-time setup

1. Create the publisher at <https://marketplace.visualstudio.com/manage> (publisher id is **`SoftAdvice`** — case-sensitive).
2. Create a Personal Access Token in Azure DevOps with **Marketplace → Manage** scope (organization: **All accessible organizations**).
3. Login from the CLI (you only do this once per machine):

   ```bash
   npx @vscode/vsce login SoftAdvice
   # paste the PAT when prompted
   ```

   If you previously logged in under the wrong publisher id, log out first:

   ```bash
   npx @vscode/vsce logout <wrong-publisher-id>
   ```

### Releasing a new version

```bash
# 1. Bump version in package.json (e.g., 0.2.0 → 0.2.1)
#    Or use vsce's built-in bump:
npx @vscode/vsce package patch    # bumps patch + packages
# (use `minor` or `major` instead of `patch` as appropriate)

# 2. Sanity-check the .vsix locally first
code --install-extension sadatacopilot-<new-version>.vsix --force
# reload, run a prompt cell, verify it works

# 3. Publish
npx @vscode/vsce publish
```

`vsce publish` re-packages and uploads in one step. The new version appears on the Marketplace within ~1–2 minutes.

### Verifying the publish

- Search for "SADataCopilot" in the VS Code Extensions sidebar — it should show the new version.
- Marketplace page: <https://marketplace.visualstudio.com/items?itemName=SoftAdvice.sadatacopilot>

### Unpublishing

```bash
npx @vscode/vsce unpublish SoftAdvice.sadatacopilot
```

This is rarely the right move — prefer publishing a fix. Unpublishing breaks installs for existing users.

## Troubleshooting

**`code` command not found** — install the shell command from inside VS Code (see end of section 2).

**Marketplace rejects the PAT** — the PAT must be created against the Azure DevOps organization that owns the publisher (or with "All accessible organizations" scope). Re-create it under the right org.

**`.vsix` is huge (>50 MB)** — check `.vscodeignore`. The Copilot CLI must **not** be bundled; the extension lazy-loads it from the user's global `npm` install. Current `.vsix` size is ~210 KB.

**"Cannot find module '@github/copilot-sdk'"** at runtime — user hasn't installed the Copilot CLI. The extension surfaces a hint pointing at `npm install -g @github/copilot`.

**Pre-publish 833-files warning** — VS Code recommends bundling. We webpack-bundle our own code (one `out/extension.js`) and exclude all `node_modules`. The warning fires if it sees many JS files; `--allow-missing-repository` and similar flags are unrelated. Just proceed past it.
