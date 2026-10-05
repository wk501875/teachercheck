const SUPABASE_URL = 'https://vmvalgkbdfyrdiayaxyz.supabase.co/rest/v1';
const SUPABASE_KEY = 'sb_publishable_GkszbBMYO7SQYedNBw0-7Q_Jv90-DUH';

// 내년(2027)용 사이트 전용 저장 공간. 올해 운영 데이터(junior/senior)와 분리됨
const ROW_SUFFIX = '_2027';

// 지난 회기(2026): junior/senior 원본 행. 읽기(GET)만 허용, 쓰기는 서버에서 거부
const PAST_SEASON = '2026';

export async function onRequestPost(context) {
  let body;
  try {
    body = await context.request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }

  const { dept, method, body: payload, season } = body;

  if (!dept || !['junior', 'senior'].includes(dept)) {
    return new Response(JSON.stringify({ error: 'Invalid dept' }), { status: 400 });
  }

  const isPast = season !== undefined && season !== null && String(season) === PAST_SEASON;
  if (season !== undefined && season !== null && !isPast) {
    return new Response(JSON.stringify({ error: 'Invalid season' }), { status: 400 });
  }
  if (isPast && method !== 'GET') {
    return new Response(JSON.stringify({ error: '지난 회기는 조회만 가능합니다' }), { status: 403 });
  }
  const rowId = isPast ? dept : `${dept}${ROW_SUFFIX}`;

  const headers = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
  };

  try {
    if (method === 'GET') {
      const res = await fetch(`${SUPABASE_URL}/checklist_data?id=eq.${rowId}&select=*`, { headers });
      if (!res.ok) throw new Error(`Supabase GET failed: ${res.status}`);
      const data = await res.json();
      let row = data[0] || {};
      if (isPast) {
        // 조회에 필요한 이름·기록만 전달 (비밀번호·PIN 제외)
        row = {
          teachers: (row.teachers || []).map(t => ({ name: t.name })),
          state: row.state || [],
        };
      }
      return new Response(JSON.stringify(row), { status: 200, headers: { 'Content-Type': 'application/json' } });

    } else if (method === 'PUT' && !isPast) {
      const res = await fetch(`${SUPABASE_URL}/checklist_data?id=eq.${dept}${ROW_SUFFIX}`, {
        method: 'PATCH',
        headers: { ...headers, 'Prefer': 'return=minimal' },
        body: JSON.stringify({
          org_name: payload.org_name,
          admin_pw: payload.admin_pw,
          teachers: payload.teachers,
          state: payload.state,
          locked_months: payload.locked_months,
          _ts: payload._ts,
          updated_at: new Date().toISOString(),
        }),
      });
      if (!res.ok) {
        const errText = await res.text();
        throw new Error(`Supabase PATCH failed: ${res.status} ${errText}`);
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });

    } else {
      return new Response(JSON.stringify({ error: 'Invalid method' }), { status: 400 });
    }
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 500 });
  }
}

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    },
  });
}
export async function onRequestGet(context) {
  return onRequestPost(context);
}
