const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const queueDir = path.join(process.env.GITHUB_WORKSPACE, 'court-search', 'artifact-queue');
const readyPath = path.join(queueDir, 'READY');
const errorPath = path.join(queueDir, 'START_ERROR');
fs.mkdirSync(queueDir, { recursive: true });
for (const marker of [readyPath, errorPath, path.join(queueDir, 'STOP')]) {
  fs.rmSync(marker, { force: true });
}

const child = spawn(process.execPath, [path.join(__dirname, 'watcher.mjs'), queueDir], {
  cwd: process.env.GITHUB_WORKSPACE,
  detached: true,
  stdio: 'ignore',
  env: { ...process.env, RUNNER_TRACKING_ID: '' },
});
child.unref();

async function waitUntilReady() {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (fs.existsSync(readyPath)) {
      console.log(`중간 결과 업로드 큐 준비 완료 (PID ${child.pid})`);
      return;
    }
    if (fs.existsSync(errorPath)) {
      throw new Error(fs.readFileSync(errorPath, 'utf8'));
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error('중간 결과 업로드 큐 시작 시간 초과');
}

waitUntilReady().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
