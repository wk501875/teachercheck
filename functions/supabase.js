const SUPABASE_URL = 'https://vmvalgkbdfyrdiayaxyz.supabase.co/rest/v1';
const SUPABASE_KEY = 'sb_publishable_GkszbBMYO7SQYedNBw0-7Q_Jv90-DUH';

// 내년(2027)용 사이트 전용 저장 공간. 올해 운영 데이터(junior/senior)와 분리됨
const ROW_SUFFIX = '_2027';

// 지난 회기(2026): junior/senior 원본 행. 읽기(GET)만 허용, 쓰기는 서버에서 거부
const PAST_SEASON = '2026';

// 2027 회기 선생님별 기록: 선생님 한 명 = teacher_records 한 행
// (checklist_data의 2027 행에는 명단·PIN·마감 설정만 저장)
const CUR_SEASON = '2027';
const RECORDS_TABLE = 'teacher_records';

const headers = {
  'Content-Type': 'application/json',
  'apikey': SUPABASE_KEY,
  'Authorization': `Bearer ${SUPABASE_KEY}`,
};

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

async function sb(path, opt = {}) {
  const res = await fetch(`${SUPABASE_URL}/${path}`, { ...opt, headers: { ...headers, ...(opt.headers || {}) } });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
  return { ok: res.ok, status: res.status, data, text };
}

// teacher_records 테이블이 아직 없을 때 (SQL 실행 전)
function isMissingTable(r) {
  return r.status === 404 || (r.data && (r.data.code === 'PGRST205' || r.data.code === '42P01'));
}
function recordsMissingError() {
  return new HttpError(503, '서버에 선생님 기록 저장 공간(teacher_records)이 아직 없습니다. 관리자가 SQL을 실행해야 합니다.', { code: 'records_table_missing' });
}

// 예전 명단(id 없음)은 순서대로 t_1, t_2 ... 를 부여 (화면 코드와 같은 규칙)
function ensureIds(teachers) {
  return (Array.isArray(teachers) ? teachers : []).map((t, i) => (t && t.id ? t : { ...t, id: `t_${i + 1}` }));
}

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

async function getRoster(dept) {
  const r = await sb(`checklist_data?id=eq.${dept}${ROW_SUFFIX}&select=org_name,admin_pw,teachers,locked_months,updated_at,state`);
  if (!r.ok) throw new HttpError(502, `Supabase GET failed: ${r.status}`);
  return (r.data && r.data[0]) || null;
}

function rosterPublic(row) {
  return {
    org_name: row.org_name,
    admin_pw: row.admin_pw,
    teachers: ensureIds(row.teachers),
    locked_months: row.locked_months,
    roster_version: row.updated_at || null,
  };
}

// 명단 행을 "내가 마지막으로 본 버전"일 때만 수정 (오래된 화면이 덮어쓰지 못하게)
async function patchRosterIfVersion(dept, version, fields) {
  const verFilter = version ? `eq.${encodeURIComponent(version)}` : 'is.null';
  const r = await sb(`checklist_data?id=eq.${dept}${ROW_SUFFIX}&updated_at=${verFilter}`, {
    method: 'PATCH',
    headers: { 'Prefer': 'return=representation' },
    body: JSON.stringify({ ...fields, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) throw new HttpError(502, `Supabase PATCH failed: ${r.status} ${r.text}`);
  return (r.data && r.data[0]) || null;
}

async function getRecord(dept, teacherId) {
  const r = await sb(`${RECORDS_TABLE}?season=eq.${CUR_SEASON}&dept=eq.${dept}&teacher_id=eq.${teacherId}&select=teacher_id,state,version`);
  if (isMissingTable(r)) throw recordsMissingError();
  if (!r.ok) throw new HttpError(502, `Supabase GET failed: ${r.status}`);
  return (r.data && r.data[0]) || null;
}

/* ── 2027: 명단 + 선생님별 기록 불러오기 ── */
async function handleGet(dept) {
  const row = await getRoster(dept);
  if (!row) return json({ roster_row_missing: true, teachers: [], records: [] });
  const out = { ...rosterPublic(row), legacy_state: row.state || [], records: [] };
  const r = await sb(`${RECORDS_TABLE}?season=eq.${CUR_SEASON}&dept=eq.${dept}&select=teacher_id,state,version`);
  if (isMissingTable(r)) out.records_error = 'records_table_missing';
  else if (!r.ok) throw new HttpError(502, `Supabase GET failed: ${r.status}`);
  else out.records = r.data || [];
  return json(out);
}

/* ── 2027: 관리자 명단·PIN·마감 설정 저장 (기록은 건드리지 않음) ── */
async function handleSaveRoster(dept, p) {
  if (!p || !Array.isArray(p.teachers)) throw new HttpError(400, 'Invalid teachers');
  const ids = new Set();
  const teachers = p.teachers.map(t => {
    if (!t || !ID_RE.test(String(t.id)) || ids.has(t.id)) throw new HttpError(400, 'Invalid teacher id');
    ids.add(t.id);
    return { id: String(t.id), name: String(t.name || '').slice(0, 30), pin: String(t.pin || '').slice(0, 20) };
  });
  const saved = await patchRosterIfVersion(dept, p.roster_version, {
    org_name: String(p.org_name || '').slice(0, 30),
    admin_pw: String(p.admin_pw || '').slice(0, 20),
    teachers,
    locked_months: p.locked_months || {},
  });
  if (saved) return json({ ok: true, roster_version: saved.updated_at });
  const row = await getRoster(dept);
  if (!row) throw new HttpError(404, `서버에 ${dept}${ROW_SUFFIX} 행이 없습니다.`, { code: 'roster_row_missing' });
  return json({ conflict: true, roster: rosterPublic(row) }, 409);
}

/* ── 2027: 선생님 PIN 변경 (본인 PIN만 바꾸고 다른 사람 정보는 그대로) ── */
async function handleSetPin(dept, p) {
  if (!p || !ID_RE.test(String(p.teacher_id))) throw new HttpError(400, 'Invalid teacher id');
  const newPin = String(p.new_pin || '').trim();
  if (!newPin || newPin.length > 20) throw new HttpError(400, 'Invalid PIN');
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await getRoster(dept);
    if (!row) throw new HttpError(404, `서버에 ${dept}${ROW_SUFFIX} 행이 없습니다.`, { code: 'roster_row_missing' });
    const teachers = ensureIds(row.teachers);
    const idx = teachers.findIndex(t => t.id === p.teacher_id);
    if (idx === -1) throw new HttpError(404, '명단에 없는 선생님입니다.');
    if (teachers[idx].pin !== String(p.old_pin || '')) throw new HttpError(403, '현재 PIN이 올바르지 않습니다.', { code: 'wrong_pin' });
    teachers[idx] = { ...teachers[idx], pin: newPin };
    const saved = await patchRosterIfVersion(dept, row.updated_at, { teachers });
    if (saved) return json({ ok: true, roster_version: saved.updated_at });
  }
  throw new HttpError(409, '다른 저장과 겹쳤습니다. 잠시 후 다시 시도해주세요.');
}

/* ── 2027: 선생님 한 명의 기록 저장 (그 선생님 행만 수정) ── */
async function handleSaveRecord(dept, p) {
  if (!p || !ID_RE.test(String(p.teacher_id))) throw new HttpError(400, 'Invalid teacher id');
  if (!Array.isArray(p.state) || p.state.length > 20) throw new HttpError(400, 'Invalid state');
  if (JSON.stringify(p.state).length > 100000) throw new HttpError(400, 'State too large');
  const version = Number(p.version);
  if (!Number.isInteger(version) || version < 0) throw new HttpError(400, 'Invalid version');

  const row = await getRoster(dept);
  if (!row) throw new HttpError(404, `서버에 ${dept}${ROW_SUFFIX} 행이 없습니다.`, { code: 'roster_row_missing' });
  if (!ensureIds(row.teachers).some(t => t.id === p.teacher_id)) throw new HttpError(404, '명단에 없는 선생님입니다.', { code: 'unknown_teacher' });

  const now = new Date().toISOString();
  if (version === 0) {
    // 처음 저장: 새 행 만들기 (이미 있으면 충돌로 처리)
    const r = await sb(RECORDS_TABLE, {
      method: 'POST',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({ season: CUR_SEASON, dept, teacher_id: p.teacher_id, state: p.state, version: 1, updated_at: now }),
    });
    if (isMissingTable(r)) throw recordsMissingError();
    if (r.ok) return json({ ok: true, version: 1 });
    if (r.status !== 409) throw new HttpError(502, `Supabase POST failed: ${r.status} ${r.text}`);
  } else {
    // 내가 마지막으로 본 버전일 때만 수정
    const r = await sb(`${RECORDS_TABLE}?season=eq.${CUR_SEASON}&dept=eq.${dept}&teacher_id=eq.${p.teacher_id}&version=eq.${version}`, {
      method: 'PATCH',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({ state: p.state, version: version + 1, updated_at: now }),
    });
    if (isMissingTable(r)) throw recordsMissingError();
    if (!r.ok) throw new HttpError(502, `Supabase PATCH failed: ${r.status} ${r.text}`);
    if (r.data && r.data.length) return json({ ok: true, version: version + 1 });
  }
  // 다른 곳에서 먼저 저장됨 → 최신 기록을 돌려주고 화면에서 병합 후 다시 저장
  return json({ conflict: true, record: await getRecord(dept, p.teacher_id) }, 409);
}

export async function onRequestPost(context) {
  let body;
  try {
    body = await context.request.json();
  } catch (e) {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const { dept, method, body: payload, season } = body || {};

  if (!dept || !['junior', 'senior'].includes(dept)) {
    return json({ error: 'Invalid dept' }, 400);
  }

  const isPast = season !== undefined && season !== null && String(season) === PAST_SEASON;
  if (season !== undefined && season !== null && !isPast) {
    return json({ error: 'Invalid season' }, 400);
  }
  if (isPast && method !== 'GET') {
    return json({ error: '지난 회기는 조회만 가능합니다' }, 403);
  }

  try {
    if (isPast) {
      // 2026 회기: junior/senior 원본 행 읽기 전용
      const r = await sb(`checklist_data?id=eq.${dept}&select=*`);
      if (!r.ok) throw new HttpError(502, `Supabase GET failed: ${r.status}`);
      const row = (r.data && r.data[0]) || {};
      // 조회에 필요한 이름·기록만 전달 (비밀번호·PIN 제외)
      return json({
        teachers: (row.teachers || []).map(t => ({ name: t.name })),
        state: row.state || [],
      });
    }

    if (method === 'GET') return await handleGet(dept);
    if (method === 'SAVE_ROSTER') return await handleSaveRoster(dept, payload);
    if (method === 'SET_PIN') return await handleSetPin(dept, payload);
    if (method === 'SAVE_RECORD') return await handleSaveRecord(dept, payload);
    if (method === 'PUT') {
      // 예전 화면의 "부서 전체 통째로 저장"은 더 이상 받지 않음
      return json({ error: '사이트가 업데이트되었습니다. 페이지를 새로고침 해주세요.', code: 'outdated_client' }, 410);
    }
    return json({ error: 'Invalid method' }, 400);
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: e.message, ...(e.extra || {}) }, status);
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
