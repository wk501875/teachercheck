/* 생명선앱스 회원검색 API 중계 (연습용)
 * 주소: /jbch-member  (POST { hash, q })
 * 발급 키(tokenId)는 저장소가 공개라서 코드에 넣지 않고
 * Cloudflare Pages 환경 변수 JBCH_TOKEN 에서 읽음.
 */
const API_URL = 'https://api.jbch.org/in/load_member_search.php';
const DEV_NAME = 'teach_bible';

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function onRequestPost({ request, env }) {
  if (!env.JBCH_TOKEN) {
    return json({ status: 'error', result: '서버에 JBCH_TOKEN 이 설정되지 않았습니다. Cloudflare 설정에서 추가해 주세요.' });
  }

  let body;
  try { body = await request.json(); } catch (e) { body = {}; }
  const hash = String(body.hash || '').trim();
  const q = String(body.q || '').trim();
  if (!hash) return json({ status: 'error', result: 'hash 를 먼저 입력해 주세요.' });
  if (!q) return json({ status: 'error', result: '검색어를 입력해 주세요.' });
  if (hash.length > 100 || q.length > 50) return json({ status: 'error', result: '입력값이 너무 깁니다.' });

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dev_name: DEV_NAME, tokenId: env.JBCH_TOKEN, hash, q }),
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch (e) {
      return json({ status: 'error', result: `API 응답을 읽지 못했습니다 (HTTP ${res.status})` });
    }
    // API는 인증 실패 때 HTTP 500을 주므로, 화면에는 항상 200으로 넘기고 status 값으로 판단
    return json(data);
  } catch (e) {
    return json({ status: 'error', result: 'API 서버에 연결하지 못했습니다.' });
  }
}
