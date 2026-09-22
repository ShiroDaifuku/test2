import fs from "node:fs";

const readJson = (path) => JSON.parse(fs.readFileSync(path, "utf8"));
const release = readJson("release.json");
const packageJson = readJson("package.json");
const tauri = readJson("src-tauri/tauri.conf.json");
const cargoToml = fs.readFileSync("src-tauri/Cargo.toml", "utf8");
const cargoLock = fs.readFileSync("src-tauri/Cargo.lock", "utf8");

const cargoVersion = /^version = "([^"]+)"/m.exec(cargoToml)?.[1];
const lockPackage =
  /\[\[package\]\]\s+name = "ling_chat"\s+version = "([^"]+)"/m.exec(
    cargoLock,
  )?.[1];
const expected = release.version;
const versions = {
  "package.json": packageJson.version,
  "src-tauri/tauri.conf.json": tauri.version,
  "src-tauri/Cargo.toml": cargoVersion,
  "src-tauri/Cargo.lock (ling_chat)": lockPackage,
};

const mismatches = Object.entries(versions).filter(
  ([, value]) => value !== expected,
);
if (mismatches.length) {
  for (const [file, value] of mismatches) {
    console.error(
      `[version-check] ${file}: ${value ?? "<missing>"}; expected ${expected}`,
    );
  }
  process.exit(1);
}

if (!/^\d+\.\d+\.\d+$/.test(release.iosMarketingVersion)) {
  console.error(
    "[version-check] iosMarketingVersion must use the numeric x.y.z form",
  );
  process.exit(1);
}
if (!/^\d+$/.test(release.iosBuildNumber)) {
  console.error("[version-check] iosBuildNumber must be an integer string");
  process.exit(1);
}

console.log(
  `[version-check] ${release.product} ${expected}; iOS ${release.iosMarketingVersion} (${release.iosBuildNumber})`,
);
