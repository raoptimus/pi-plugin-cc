import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

/**
 * `make install-pia-example`.
 *
 * It writes a personal config, which is the one file in this repository that a
 * mistake can destroy: the example is a start, and a second run over a tuned
 * fleet would undo it while printing success. So the target is tested by what it
 * refuses as much as by what it writes — and always into a temporary HOME and
 * XDG directory, never the developer's.
 */

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const EXAMPLE = path.join(ROOT, "plugins", "pi", "config.example.json");

function sandbox(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-install-example-"));
  const home = path.join(root, "home");
  const xdg = path.join(root, "xdg");
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(xdg, { recursive: true });
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return {
    root,
    home,
    xdg,
    canonical: path.join(xdg, "pia", "config.json"),
    legacy: path.join(home, ".claude", "pi", "config.json")
  };
}

function install(dirs) {
  const result = spawnSync("make", ["-C", ROOT, "install-pia-example"], {
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, HOME: dirs.home, XDG_CONFIG_HOME: dirs.xdg }
  });
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`
  };
}

test("a clean install writes the example at 0600 and links the old path to it", (t) => {
  const dirs = sandbox(t);
  const result = install(dirs);
  assert.equal(result.status, 0, result.output);

  assert.equal(fs.readFileSync(dirs.canonical, "utf8"), fs.readFileSync(EXAMPLE, "utf8"), "byte for byte");
  assert.equal(fs.statSync(dirs.canonical).mode & 0o777, 0o600, "a config may hold a token command");

  // The old path is not a second copy: a copy would drift, and the two files
  // would then disagree about which one the owner meant.
  assert.ok(fs.lstatSync(dirs.legacy).isSymbolicLink(), "the legacy path is a symlink");
  assert.equal(fs.realpathSync(dirs.legacy), fs.realpathSync(dirs.canonical));
  assert.equal(fs.readFileSync(dirs.legacy, "utf8"), fs.readFileSync(EXAMPLE, "utf8"));
});

test("parallel installs have one winner and leave its config and link intact", async (t) => {
  const dirs = sandbox(t);
  const run = () => promisify(execFile)("make", ["-C", ROOT, "install-pia-example"], {
    env: { ...process.env, HOME: dirs.home, XDG_CONFIG_HOME: dirs.xdg }
  });
  const results = await Promise.allSettled([run(), run(), run(), run()]);
  assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(fs.realpathSync(dirs.legacy), fs.realpathSync(dirs.canonical));
  assert.deepEqual(fs.readFileSync(dirs.canonical), fs.readFileSync(EXAMPLE));
});

test("a second run refuses and leaves the installed config untouched", async (t) => {
  const dirs = sandbox(t);
  assert.equal(install(dirs).status, 0);

  const before = fs.readFileSync(dirs.canonical, "utf8");
  const linkBefore = fs.readlinkSync(dirs.legacy);
  const second = install(dirs);

  assert.notEqual(second.status, 0, "a repeat is a refusal, not a reinstall");
  assert.match(second.output, /already exists/);
  assert.equal(fs.readFileSync(dirs.canonical, "utf8"), before);
  assert.equal(fs.readlinkSync(dirs.legacy), linkBefore);

  // Removing the file a link points at leaves the link dangling; `-e` alone
  // calls that absent and would write the example over the owner's intent.
  fs.rmSync(dirs.canonical);
  const third = install(dirs);
  assert.notEqual(third.status, 0, "a dangling canonical path is still a collision");
  assert.equal(fs.readlinkSync(dirs.legacy), linkBefore, "the dangling link was not replaced");
});

test("an existing legacy config is not overwritten and nothing is written beside it", (t) => {
  const dirs = sandbox(t);
  const mine = JSON.stringify({ presets: { mine: { model: "m" } } });
  fs.mkdirSync(path.dirname(dirs.legacy), { recursive: true });
  fs.writeFileSync(dirs.legacy, mine);

  const result = install(dirs);
  assert.notEqual(result.status, 0, result.output);
  assert.match(result.output, /already exists/);
  assert.equal(fs.readFileSync(dirs.legacy, "utf8"), mine, "the owner's config is intact");
  assert.equal(fs.existsSync(dirs.canonical), false, "no canonical file was created behind a shadowing link");
});

test("an existing canonical config is not overwritten and gets no link", (t) => {
  const dirs = sandbox(t);
  const mine = JSON.stringify({ presets: { mine: { model: "m" } } });
  fs.mkdirSync(path.dirname(dirs.canonical), { recursive: true });
  fs.writeFileSync(dirs.canonical, mine);

  const result = install(dirs);
  assert.notEqual(result.status, 0, result.output);
  assert.equal(fs.readFileSync(dirs.canonical, "utf8"), mine);
  assert.equal(fs.existsSync(dirs.legacy), false, "the old path was left alone");
});

test("a relative XDG_CONFIG_HOME is ignored, as the reader ignores it", (t) => {
  const dirs = sandbox(t);
  const result = spawnSync("make", ["-C", ROOT, "install-pia-example"], {
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, HOME: dirs.home, XDG_CONFIG_HOME: "relative/xdg" }
  });
  assert.equal(result.status, 0, `${result.stdout ?? ""}${
    result.stderr ?? ""
  }`);
  // Writer and reader must agree, or the installed file is one `pia` never
  // reads while the legacy link points into a directory nobody looked at.
  const installed = path.join(dirs.home, ".config", "pia", "config.json");
  assert.ok(fs.existsSync(installed), "written under ~/.config");
  assert.equal(fs.realpathSync(dirs.legacy), fs.realpathSync(installed));
});
