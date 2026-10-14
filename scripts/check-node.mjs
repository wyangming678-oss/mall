// Match the supported engine before copying, installing or building.
export function checkNode(version = process.versions.node) {
  const [major, minor] = version.split('.').map(Number);
  if (major < 22 || (major === 22 && minor < 12)) {
    throw new Error(`ChicCart 需要 Node 22.12 或更高版本；当前为 ${version}。请切换后重试（install / dev / build 保持同一 PATH）。`);
  }
}
checkNode();
