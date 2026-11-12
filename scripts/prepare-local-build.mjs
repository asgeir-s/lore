import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Keep release versions in source control; reserve a new macOS build number for
// each install attempt without changing those files or the app's bundle ID.
export function prepareLocalBuild(root, installedInfo = "/Applications/Lore.app/Contents/Info.plist") {
  const json = (file) => JSON.parse(readFileSync(join(root, file), "utf8"));
  const version = json("package.json").version;
  const lock = json("package-lock.json");
  const cargo = readFileSync(join(root, "src-tauri/Cargo.toml"), "utf8");
  const cargoLock = readFileSync(join(root, "src-tauri/Cargo.lock"), "utf8");
  const versions = [
    version, lock.version, lock.packages[""].version,
    json("src-tauri/tauri.conf.json").version,
    cargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1],
    cargoLock.match(/name = "lore"\r?\nversion = "([^"]+)"/)?.[1],
  ];
  if (typeof version !== "string" || versions.some((value) => value !== version)) {
    throw new Error("Release versions disagree. Synchronize package.json, package-lock.json, Cargo.toml, Cargo.lock, and tauri.conf.json before installing.");
  }

  const buildNumber = (value) => /^\d+$/.test(String(value)) && Number.isSafeInteger(Number(value)) ? Number(value) : 0;
  let installed = 0;
  if (existsSync(installedInfo)) {
    installed = buildNumber(execFileSync("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleVersion", installedInfo], { encoding: "utf8" }).trim());
  }
  let commits = 0;
  try {
    commits = buildNumber(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim());
  } catch {
    // Source archives may not contain Git history.
  }
  const target = join(root, "src-tauri/target");
  const configPath = join(target, "local-build.config.json");
  const previous = existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")).bundle.macOS.bundleVersion : "0";
  const next = Math.max(installed, commits, buildNumber(previous)) + 1;
  if (!Number.isSafeInteger(next)) throw new Error("Local build number is too large");
  const config = { bundle: { macOS: { bundleVersion: String(next) } } };
  mkdirSync(target, { recursive: true });
  const temporary = `${configPath}.${process.pid}.tmp`;
  writeFileSync(temporary, JSON.stringify(config, null, 2) + "\n");
  renameSync(temporary, configPath);
  return { version, build: String(next), config };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = prepareLocalBuild(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
  console.error(`Building Lore ${result.version} (build ${result.build})`);
  console.log(JSON.stringify(result.config));
}
