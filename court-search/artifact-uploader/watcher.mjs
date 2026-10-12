import fs from 'node:fs/promises';
import path from 'node:path';
import { DefaultArtifactClient } from '@actions/artifact';

const queueDir = path.resolve(process.argv[2]);
const readyPath = path.join(queueDir, 'READY');
const startErrorPath = path.join(queueDir, 'START_ERROR');
const stopPath = path.join(queueDir, 'STOP');

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function exists(target) {
  try {
    await fs.access(target);
    return true;
  } catch {
    return false;
  }
}

async function writeJson(target, payload) {
  const temporary = `${target}.tmp`;
  await fs.writeFile(temporary, JSON.stringify(payload), 'utf8');
  await fs.rename(temporary, target);
}

async function main() {
  if (!process.env.ACTIONS_RUNTIME_TOKEN || !process.env.ACTIONS_RESULTS_URL) {
    throw new Error('GitHub Actions artifact 인증 환경이 없습니다.');
  }
  const client = new DefaultArtifactClient();
  await fs.writeFile(readyPath, String(process.pid), 'utf8');

  while (true) {
    const names = await fs.readdir(queueDir);
    const requests = names.filter((name) => name.endsWith('.request.json')).sort();
    for (const name of requests) {
      const requestPath = path.join(queueDir, name);
      const processingPath = requestPath.replace(/\.request\.json$/, '.processing.json');
      try {
        await fs.rename(requestPath, processingPath);
      } catch {
        continue;
      }

      let artifactName = name.replace(/\.request\.json$/, '');
      try {
        const payload = JSON.parse(await fs.readFile(processingPath, 'utf8'));
        artifactName = payload.artifact_name;
        const sourcePath = path.resolve(payload.path);
        const result = await client.uploadArtifact(
          artifactName,
          [sourcePath],
          path.dirname(sourcePath),
          { retentionDays: 7, compressionLevel: 6 },
        );
        await writeJson(path.join(queueDir, `${artifactName}.done.json`), {
          id: result.id,
          size: result.size,
        });
      } catch (error) {
        await writeJson(path.join(queueDir, `${artifactName}.error.json`), {
          error: error instanceof Error ? error.message : String(error),
        });
      } finally {
        await fs.rm(processingPath, { force: true });
      }
    }

    const remaining = (await fs.readdir(queueDir)).some(
      (name) => name.endsWith('.request.json') || name.endsWith('.processing.json'),
    );
    if (await exists(stopPath) && !remaining) return;
    await sleep(250);
  }
}

main().catch(async (error) => {
  await fs.mkdir(queueDir, { recursive: true });
  await fs.writeFile(startErrorPath, error instanceof Error ? error.message : String(error), 'utf8');
  process.exitCode = 1;
});
