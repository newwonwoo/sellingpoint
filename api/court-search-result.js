/**
 * GET /api/court-search-result
 * 지정한 GitHub Actions 실행의 artifact에서 output.xlsx를 꺼내 base64로 반환
 */

import JSZip from 'jszip';

export default async function handler(req, res) {
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const REPO = process.env.GITHUB_REPO || 'newwonwoo/sellingpoint';

  if (!GITHUB_TOKEN) {
    return res.status(500).json({ error: 'GITHUB_TOKEN 없음' });
  }

  try {
    const runId = String(req.query?.runId || '').trim();
    const artifactId = String(req.query?.artifactId || '').trim();
    if (!/^\d+$/.test(runId)) {
      return res.status(400).json({ error: '결과를 받을 runId가 필요합니다.' });
    }
    if (artifactId && !/^\d+$/.test(artifactId)) {
      return res.status(400).json({ error: '올바른 artifactId가 필요합니다.' });
    }

    const listRes = await fetch(
      `https://api.github.com/repos/${REPO}/actions/runs/${runId}/artifacts?per_page=100`,
      {
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
          Accept: 'application/vnd.github.v3+json',
        },
      }
    );

    if (!listRes.ok) {
      return res.status(502).json({ error: `Actions artifact 목록 조회 실패 (${listRes.status})` });
    }

    const artifacts = (await listRes.json()).artifacts || [];
    const artifact = artifactId
      ? artifacts.find((item) => String(item.id) === artifactId
          && item.name.startsWith('court-search-partial-') && !item.expired)
      : artifacts.find((item) => item.name === 'court-search-result' && !item.expired);
    if (!artifact) {
      return res.status(404).json({ error: artifactId
        ? '이 실행에서 해당 중간 결과 파일을 찾을 수 없습니다.'
        : '이 실행의 전체 결과 artifact가 아직 없습니다.' });
    }

    // artifact API는 zip을 반환한다. 결과 파일과 진단 파일이 함께 있을 수 있다.
    const fileRes = await fetch(artifact.archive_download_url, {
      headers: {
        Authorization: `token ${GITHUB_TOKEN}`,
        Accept: 'application/vnd.github+json',
      },
    });
    if (!fileRes.ok) {
      return res.status(502).json({ error: `artifact 다운로드 실패 (${fileRes.status})` });
    }

    const zip = await JSZip.loadAsync(await fileRes.arrayBuffer());
    const outputName = Object.keys(zip.files).find((name) => !zip.files[name].dir && (
      artifactId ? name.toLowerCase().endsWith('.xlsx') : (name === 'output.xlsx' || name.endsWith('/output.xlsx'))
    ));
    if (!outputName) {
      return res.status(404).json({ error: 'artifact 안에 결과 엑셀 파일이 없습니다.' });
    }
    const base64 = await zip.files[outputName].async('base64');
    const output = Buffer.from(base64, 'base64');
    const range = artifact.name.match(/^court-search-partial-(\d+)-(\d+)$/);
    const filename = range
      ? `court-search-${String(Number(range[1])).padStart(4, '0')}-${String(Number(range[2])).padStart(4, '0')}.xlsx`
      : `court-search-${runId}.xlsx`;

    if (String(req.query?.download || '') === '1') {
      res.setHeader('Cache-Control', 'no-store');
      res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', String(output.length));
      return res.status(200).send(output);
    }

    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({
      filename,
      content: base64,
      size: output.length,
      runId,
      artifactId: artifactId || null,
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
