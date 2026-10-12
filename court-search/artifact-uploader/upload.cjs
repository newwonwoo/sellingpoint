const path = require('node:path');
const { DefaultArtifactClient } = require('@actions/artifact');

async function main() {
  const [artifactName, sourcePath] = process.argv.slice(2);
  if (!artifactName || !sourcePath) {
    throw new Error('사용법: node upload.cjs <artifact-name> <xlsx-path>');
  }
  if (!/^court-search-partial-(?:r\d+-)?\d+-\d+$/.test(artifactName)) {
    throw new Error(`허용되지 않은 중간 결과 이름: ${artifactName}`);
  }
  if (!process.env.ACTIONS_RUNTIME_TOKEN || !process.env.ACTIONS_RESULTS_URL) {
    throw new Error('GitHub Actions artifact 업로드 환경이 아닙니다.');
  }

  const absolutePath = path.resolve(sourcePath);
  const client = new DefaultArtifactClient();
  const result = await client.uploadArtifact(
    artifactName,
    [absolutePath],
    path.dirname(absolutePath),
    { retentionDays: 7, compressionLevel: 6 },
  );
  console.log(`✅ 중간 결과 공개: ${artifactName} (artifact ${result.id}, ${result.size} bytes)`);
}

main().catch((error) => {
  console.error(`❌ 중간 결과 업로드 실패: ${error.message}`);
  process.exitCode = 1;
});
