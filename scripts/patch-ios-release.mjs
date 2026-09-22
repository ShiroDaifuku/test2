import fs from "node:fs";

const projectPath = process.argv[2];
if (!projectPath) {
  console.error("usage: node scripts/patch-ios-release.mjs <project.pbxproj>");
  process.exit(1);
}

const release = JSON.parse(fs.readFileSync("release.json", "utf8"));
let project = fs.readFileSync(projectPath, "utf8");

const marketingLine = `MARKETING_VERSION = ${release.iosMarketingVersion};`;
const buildLine = `CURRENT_PROJECT_VERSION = ${release.iosBuildNumber};`;
const hasMarketing = /MARKETING_VERSION = [^;]+;/.test(project);
const hasBuild = /CURRENT_PROJECT_VERSION = [^;]+;/.test(project);

if (hasMarketing) {
  project = project.replace(/MARKETING_VERSION = [^;]+;/g, marketingLine);
}
if (hasBuild) {
  project = project.replace(/CURRENT_PROJECT_VERSION = [^;]+;/g, buildLine);
}

// Tauri/XcodeGen 的部分版本不生成这两个 build setting。此时向每个
// buildSettings 块写入相同值，覆盖 project/target 的 Debug 与 Release 配置。
if (!hasMarketing || !hasBuild) {
  project = project.replace(/(buildSettings = \{\r?\n)/g, (opening) => {
    const missing = [
      !hasBuild ? `\t\t\t\t${buildLine}\n` : "",
      !hasMarketing ? `\t\t\t\t${marketingLine}\n` : "",
    ].join("");
    return opening + missing;
  });
}

if (!project.includes(marketingLine) || !project.includes(buildLine)) {
  console.error("[ios-release] failed to write MARKETING_VERSION/CURRENT_PROJECT_VERSION");
  process.exit(1);
}

fs.writeFileSync(projectPath, project);
console.log(
  `[ios-release] patched ${projectPath}: ${release.iosMarketingVersion} (${release.iosBuildNumber})`
);
