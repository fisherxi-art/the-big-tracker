/**
 * Free default dev ports (Windows: uses netstat + taskkill).
 * Usage: node scripts/kill-dev-ports.mjs [ports...]
 * Default: 3000 5173 5174
 */
import { execSync } from "child_process";

const ports = process.argv.slice(2).map(Number).filter((n) => n > 0);
const targetPorts = ports.length ? ports : [3000, 5173, 5174];

function killOnWindows(port) {
  let out;
  try {
    out = execSync("netstat -ano", { encoding: "utf8" });
  } catch {
    return;
  }
  const pids = new Set();
  for (const line of out.split("\n")) {
    if (!/LISTENING/.test(line)) continue;
    if (!line.includes(`:${port}`)) continue;
    const parts = line.trim().split(/\s+/);
    const pid = parts[parts.length - 1];
    if (/^\d+$/.test(pid)) pids.add(pid);
  }
  for (const pid of pids) {
    try {
      execSync(`taskkill /PID ${pid} /F`, { stdio: "inherit" });
      console.log(`Killed PID ${pid} (port ${port})`);
    } catch {
      console.error(`Could not kill PID ${pid}`);
    }
  }
  if (pids.size === 0) {
    console.log(`No listener on port ${port}`);
  }
}

for (const p of targetPorts) {
  killOnWindows(p);
}
