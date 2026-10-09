import JSZip from 'jszip';

/** GET /api/court-search-single-result — 단건 전용 JSON artifact 반환 */
export default async function handler(req, res) {
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const REPO = process.env.GITHUB_REPO || 'newwonwoo/sellingpoint';
  const runId = String(req.query?.runId || '').trim();
  if (!GITHUB_TOKEN) return res.status(500).json({ error: 'GITHUB_TOKEN 없음' });
  if (!/^\d+$/.test(runId)) return res.status(400).json({ error: '올바른 runId가 필요합니다.' });

  try {
    const listRes = await fetch(
      `https://api.github.com/repos/${REPO}/actions/runs/${runId}/artifacts?per_page=100`,
      { headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github.v3+json' } },
    );
    if (!listRes.ok) return res.status(502).json({ error: '단건 결과 목록 조회 실패' });
    const artifacts = (await listRes.json()).artifacts || [];
    const artifact = artifacts.find((item) => item.name === 'court-search-single-result' && !item.expired);
    if (!artifact) return res.status(404).json({ error: '단건 JSON 결과가 아직 없습니다.' });

    const fileRes = await fetch(artifact.archive_download_url, {
      headers: { Authorization: `token ${GITHUB_TOKEN}`, Accept: 'application/vnd.github+json' },
    });
    if (!fileRes.ok) return res.status(502).json({ error: '단건 JSON 결과 다운로드 실패' });
    const zip = await JSZip.loadAsync(await fileRes.arrayBuffer());
    const resultName = Object.keys(zip.files).find((name) => !zip.files[name].dir && name.endsWith('result.json'));
    if (!resultName) return res.status(404).json({ error: 'artifact에 단건 JSON 결과가 없습니다.' });
    const payload = JSON.parse(await zip.files[resultName].async('string'));
    const row = payload.results?.[0];
    if (!row) return res.status(404).json({ error: '단건 결과 행이 비어 있습니다.' });
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ runId, row });
  } catch (error) {
    return res.status(500).json({ error: error.message });
  }
}
