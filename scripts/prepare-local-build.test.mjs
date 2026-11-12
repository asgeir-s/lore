import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { prepareLocalBuild } from "./prepare-local-build.mjs";

test("repeated installs of the same source get new build numbers without changing release versions", () => {
  const root = mkdtempSync(join(tmpdir(), "lore-build-version-"));
  try {
    mkdirSync(join(root, "src-tauri"));
    const files = {
      "package.json": '{"version":"0.1.1"}',
      "package-lock.json": '{"version":"0.1.1","packages":{"":{"version":"0.1.1"}}}',
      "src-tauri/tauri.conf.json": '{"version":"0.1.1"}',
      "src-tauri/Cargo.toml": '[package]\nname = "lore"\nversion = "0.1.1"\n',
      "src-tauri/Cargo.lock": '[[package]]\nname = "lore"\nversion = "0.1.1"\n',
    };
    for (const [file, text] of Object.entries(files)) writeFileSync(join(root, file), text);
    const absentInstall = join(root, "not-installed.plist");
    const first = prepareLocalBuild(root, absentInstall);
    const second = prepareLocalBuild(root, absentInstall);
    assert.equal(Number(second.build), Number(first.build) + 1);
    assert.equal(second.config.bundle.macOS.bundleVersion, second.build);
    for (const [file, text] of Object.entries(files)) assert.equal(readFileSync(join(root, file), "utf8"), text);
    let last = second;
    if (process.platform === "darwin") {
      // A newer installed copy wins even after cleaning the build directory.
      writeFileSync(absentInstall, '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleVersion</key><string>900</string></dict></plist>');
      assert.equal(prepareLocalBuild(root, absentInstall).build, "901");
      rmSync(join(root, "src-tauri/target"), { recursive: true });
      writeFileSync(absentInstall, '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleVersion</key><string>901</string></dict></plist>');
      last = prepareLocalBuild(root, absentInstall);
      assert.equal(last.build, "902");
    }
    // Version drift must fail before reserving another build number.
    writeFileSync(join(root, "src-tauri/tauri.conf.json"), '{"version":"0.2.0"}');
    assert.throws(() => prepareLocalBuild(root, absentInstall), /Release versions disagree/);
    const saved = JSON.parse(readFileSync(join(root, "src-tauri/target/local-build.config.json"), "utf8"));
    assert.equal(saved.bundle.macOS.bundleVersion, last.build);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
