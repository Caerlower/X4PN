#!/usr/bin/env node
import { execSync } from 'node:child_process';

const port = process.env.PORT || '4021';

try {
  const out = execSync(`lsof -ti :${port}`, { encoding: 'utf8' }).trim();
  const pids = out.split('\n').filter(Boolean);
  for (const pid of pids) {
    console.log(`Stopping process ${pid} on port ${port}`);
    process.kill(Number(pid), 'SIGTERM');
  }
} catch {
  // Nothing listening on this port
}
