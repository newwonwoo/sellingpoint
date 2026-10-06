/**
 * GET /api/court-search-result
 * results/ 폴더의 최신 xlsx 파일을 base64로 반환
 */

export default async function handler(req, res) {
  const GITHUB_TOKEN = process.env.GITHUB_TOKEN;
  const REPO = 'newwonwoo/sellingpoint';
  const BRANCH = 'main';

  if (!GITHUB_TOKEN) {
    return res.status(500).json({ error: 'GITHUB_TOKEN 없음' });
  }

  try {
    // results/ 폴더 목록 조회
    const listRes = await fetch(
      `https://api.github.com/repos/${REPO}/contents/court-search/results?ref=${BRANCH}`,
      {
        headers: {
          Authorization: `token ${GITHUB_TOKEN}`,
          Accept: 'application/vnd.github.v3+json',
        },
      }
    );

    if (!listRes.ok) {
      return res.status(404).json({ error: '결과 폴더 없음' });
    }

    const files = await listRes.json();
    // .xlsx 파일만 필터, 최신순 정렬
    const xlsxFiles = files
      .filter(f => f.name.endsWith('.xlsx'))
      .sort((a, b) => b.name.localeCompare(a.name));

    if (xlsxFiles.length === 0) {
      return res.status(404).json({ error: '결과 파일 없음' });
    }

    const latest = xlsxFiles[0];

    // 파일 내용 조회 (base64)
    const fileRes = await fetch(latest.download_url);
    if (!fileRes.ok) {
      return res.status(500).json({ error: '파일 다운로드 실패' });
    }

    const buffer = await fileRes.arrayBuffer();
    const base64 = Buffer.from(buffer).toString('base64');

    return res.status(200).json({
      filename: latest.name,
      content: base64,
      size: latest.size,
    });

  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
}
