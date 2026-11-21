import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

/**
 * Where the personal config is read from.
 *
 * The user layer moved from `~/.claude/pi/config.json` — a directory pia shared
 * with Claude Code — to `$XDG_CONFIG_HOME/pia/config.json`. Two files answering
 * the same question is the failure mode this pins down: which one is read has to
 * be decided by presence alone, never by merging them, or a half-migrated
 * machine silently runs a blend of both and no report can say which file won.
 *
 * Every test builds its own HOME and XDG directory; nothing here touches the
 * developer's real config.
 */

const MODULE = "../plugins/pi/scripts/lib/config.mjs";

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-config-path-"));
  const home = path.join(root, "home");
  const xdg = path.join(root, "xdg");
  const workspace = path.join(root, "ws");
  for (const dir of [home, xdg, workspace]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const saved = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME };
  process.env.HOME = home;
  process.env.XDG_CONFIG_HOME = xdg;
  t.after(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });
  return {
    root,
    home,
    xdg,
    workspace,
    canonical: path.join(xdg, "pia", "config.json"),
    legacy: path.join(home, ".claude", "pi", "config.json")
  };
}

function writeConfig(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body));
}

test("the canonical path is $XDG_CONFIG_HOME/pia/config.json", async (t) => {
  const dirs = sandbox(t);
  const { canonicalUserConfigPath, legacyUserConfigPath, userConfigPath } = await import(MODULE);

  assert.equal(canonicalUserConfigPath(), dirs.canonical);
  assert.equal(legacyUserConfigPath(), dirs.legacy);
  // Nothing exists: the path to create is the canonical one, so a message that
  // tells the owner where to add presets cannot send them to the old directory.
  assert.equal(userConfigPath(), dirs.canonical);
});

test("an unset XDG_CONFIG_HOME falls back to ~/.config, a relative one is ignored", async (t) => {
  const dirs = sandbox(t);
  const { canonicalUserConfigPath } = await import(MODULE);

  delete process.env.XDG_CONFIG_HOME;
  assert.equal(canonicalUserConfigPath(), path.join(dirs.home, ".config", "pia", "config.json"));

  // XDG says a relative value is ignored; honouring it would write beside the
  // current directory instead of into the home.
  process.env.XDG_CONFIG_HOME = "relative/xdg";
  assert.equal(canonicalUserConfigPath(), path.join(dirs.home, ".config", "pia", "config.json"));
});

test("the canonical file wins and the legacy one is not merged into it", async (t) => {
  const dirs = sandbox(t);
  const { loadConfig } = await import(MODULE);

  writeConfig(dirs.canonical, { presets: { canonical: { model: "m" } } });
  writeConfig(dirs.legacy, { presets: { legacy: { model: "m" } } });

  const { config, sources, errors } = loadConfig(dirs.workspace);
  assert.deepEqual(sources, [dirs.canonical], "only the canonical file is a source");
  assert.deepEqual(errors, []);
  assert.deepEqual(Object.keys(config.presets), ["canonical"], "the legacy preset did not leak in");
});

test("the legacy file is read, whole, only while the canonical one is absent", async (t) => {
  const dirs = sandbox(t);
  const { loadConfig, userConfigPath } = await import(MODULE);

  writeConfig(dirs.legacy, { presets: { legacy: { model: "m" } } });

  assert.equal(userConfigPath(), dirs.legacy);
  const { config, sources } = loadConfig(dirs.workspace);
  assert.deepEqual(sources, [dirs.legacy]);
  assert.deepEqual(Object.keys(config.presets), ["legacy"]);

  // The moment the canonical file appears, the legacy one stops counting — no
  // state carries over and no field is taken from it.
  writeConfig(dirs.canonical, { presets: { canonical: { model: "m" } } });
  const after = loadConfig(dirs.workspace);
  assert.deepEqual(after.sources, [dirs.canonical]);
  assert.deepEqual(Object.keys(after.config.presets), ["canonical"]);
});

test("a dangling canonical symlink does not fall back to the legacy config", async (t) => {
  const dirs = sandbox(t);
  const { loadConfig, userConfigPath } = await import(MODULE);

  writeConfig(dirs.legacy, { presets: { legacy: { model: "m" } } });
  fs.mkdirSync(path.dirname(dirs.canonical), { recursive: true });
  // What `make install-pia-example` refuses to create, but a moved file leaves
  // behind: the path is present, its target is not.
  fs.symlinkSync(path.join(dirs.root, "gone.json"), dirs.canonical);

  assert.equal(userConfigPath(), dirs.canonical, "the path itself is present");
  const { config, sources, errors } = loadConfig(dirs.workspace);
  assert.deepEqual(sources, [], "a broken canonical config read nothing");
  assert.deepEqual(Object.keys(config.presets), [], "and silently used the legacy file instead");
  assert.equal(errors.length, 1, "the breakage is reported rather than hidden");
  assert.match(errors[0], /gone\.json|ENOENT/);
});
