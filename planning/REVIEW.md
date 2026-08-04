# Review of changes since `HEAD`

## Findings

### P1 — Preserve the enabled Claude plugins when adding the Stop hook

`.claude/settings.json:1-14` replaces the entire existing `enabledPlugins` object with `hooks`. This disables the previously configured `frontend-design`, `context7`, and `playwright` plugins for the project, even though those capabilities are still relevant to the planned frontend and E2E work. Add `hooks` alongside the existing `enabledPlugins` property.

### P1 — Complete or remove the empty plugin configuration files

`.claude-plugin/marketplace.json` and `independent-reviewer/hooks/hooks.json` are both zero-byte files. Consequently, the new marketplace cannot describe or expose `independent-reviewer`, and the plugin itself registers no hook despite its manifest claiming to provide the review behavior. This is especially confusing because `.claude/settings.json` separately installs a project-local Stop hook. Either populate the marketplace and plugin hook descriptors and enable that plugin, or remove the unused plugin scaffold and retain the settings-based implementation.

### P2 — Do not add the stale `x*` backup copies

`xREADME.md` and `planning/xREVIEW.md` are stale copies of documents that now have canonical replacements. `xREADME.md` advertises a working Docker quick start even though `README.md` correctly says no runnable app exists, while `planning/xREVIEW.md` presents already-resolved review findings as current concerns. If committed, these files give readers conflicting project status and instructions. Remove them or archive genuinely useful history under `planning/archive/` with an explicit archival label.

### P2 — Do not instruct users to copy a file that does not exist

`README.md:37` says to copy `.env.example`, but that file is absent from both `HEAD` and the working tree. A reader following the setup instructions immediately receives a file-not-found error. Add the example file with the three documented variables, or defer this instruction until the file is introduced.

### P2 — Phrase keyless behavior as planned rather than currently available

`README.md:41` says the app “runs fully” without `OPENROUTER_API_KEY`, while `README.md:7` says there is no runnable app and that the API, frontend, and chat are not built. The environment table presents a future contract as current behavior. Change it to “When implemented, the app will run without it; chat will be disabled” (or similar) so the status and setup documentation agree.

## Verification

Reviewed tracked and untracked changes from `git status`/`git diff`, checked the new plugin files and manifests, and verified the README’s local links and referenced paths. No application code changed, so application tests were not necessary.
