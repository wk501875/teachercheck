const SUPABASE_URL = 'https://vmvalgkbdfyrdiayaxyz.supabase.co/rest/v1';
const SUPABASE_KEY = 'sb_publishable_GkszbBMYO7SQYedNBw0-7Q_Jv90-DUH';

/* ══════ 회기 규칙 ══════
 * 회기 N = (N-1)년 12월 ~ N년 12월 (13개월).
 * 매년 12월 1일(한국 시간)부터 다음 회기가 현재 회기가 됨. 현재 회기는 서버 시간으로 정함.
 * 조회 가능: 현재 회기 + 직전 회기. 쓰기 가능: 현재 회기만.
 *
 * 저장 위치
 *  · 2026 회기(LEGACY_SEASON): checklist_data의 junior / senior 행 (예전 구조, 읽기 전용 — 절대 수정 금지)
 *  · 2027 회기부터: 명단·PIN·마감 = checklist_data의 `${dept}_${회기}` 행
 *                   선생님별 기록 = teacher_records (season = 회기)
 */
const LEGACY_SEASON = 2026;
const FIRST_SEASON = 2027; // 이 사이트의 첫 회기 (2026년 12월 전에도 2027 회기를 준비할 수 있게)
const RECORDS_TABLE = 'teacher_records';

function currentSeason() {
  const kst = new Date(Date.now() + 9 * 3600 * 1000); // 한국 시간
  const y = kst.getUTCFullYear(), m = kst.getUTCMonth() + 1;
  return Math.max(FIRST_SEASON, m === 12 ? y + 1 : y);
}
function rosterRowId(dept, season) {
  return `${dept}_${season}`;
}

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
function rowMissingError(dept, season) {
  return new HttpError(404, `서버에 ${rosterRowId(dept, season)} 행이 없습니다.`, { code: 'roster_row_missing' });
}

// 예전 명단(id 없음)은 순서대로 t_1, t_2 ... 를 부여 (화면 코드와 같은 규칙)
function ensureIds(teachers) {
  return (Array.isArray(teachers) ? teachers : []).map((t, i) => (t && t.id ? t : { ...t, id: `t_${i + 1}` }));
}
function legacyIndex(id) {
  const m = /^t_(\d+)$/.exec(id);
  return m ? +m[1] - 1 : -1;
}

const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

async function getRoster(dept, season) {
  const r = await sb(`checklist_data?id=eq.${rosterRowId(dept, season)}&select=org_name,admin_pw,teachers,locked_months,updated_at,state`);
  if (!r.ok) throw new HttpError(502, `Supabase GET failed: ${r.status}`);
  return (r.data && r.data[0]) || null;
}
// 2026 회기 원본 행 (읽기 전용)
async function getLegacyRow(dept) {
  const r = await sb(`checklist_data?id=eq.${dept}&select=org_name,admin_pw,teachers,state`);
  if (!r.ok) throw new HttpError(502, `Supabase GET failed: ${r.status}`);
  return (r.data && r.data[0]) || null;
}

// 새 회기가 처음 열릴 때: 직전 회기의 명단(고유 ID·이름·PIN)·조직명·관리자 비밀번호를 복사해 명단 행 생성
// (기록과 월 마감은 빈 상태로 시작, 직전 회기 행은 읽기만 함)
async function createSeasonRoster(dept, season) {
  const prev = season - 1 <= LEGACY_SEASON ? await getLegacyRow(dept) : await getRoster(dept, season - 1);
  if (!prev) return null;
  const r = await sb('checklist_data', {
    method: 'POST',
    headers: { 'Prefer': 'return=minimal' },
    body: JSON.stringify({
      id: rosterRowId(dept, season),
      org_name: prev.org_name,
      admin_pw: prev.admin_pw,
      teachers: ensureIds(prev.teachers).map(t => ({ id: t.id, name: t.name, pin: t.pin })),
      locked_months: {},
      updated_at: new Date().toISOString(),
    }),
  });
  // 409 = 다른 화면이 방금 먼저 만듦 (정상)
  if (!r.ok && r.status !== 409) {
    throw new HttpError(502, `${season}년 명단을 만들지 못했습니다 (${r.status}). 관리자가 SQL을 실행했는지 확인해주세요.`, { code: 'roster_create_failed' });
  }
  return getRoster(dept, season);
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
async function patchRosterIfVersion(dept, season, version, fields) {
  const verFilter = version ? `eq.${encodeURIComponent(version)}` : 'is.null';
  const r = await sb(`checklist_data?id=eq.${rosterRowId(dept, season)}&updated_at=${verFilter}`, {
    method: 'PATCH',
    headers: { 'Prefer': 'return=representation' },
    body: JSON.stringify({ ...fields, updated_at: new Date().toISOString() }),
  });
  if (!r.ok) throw new HttpError(502, `Supabase PATCH failed: ${r.status} ${r.text}`);
  return (r.data && r.data[0]) || null;
}

async function getRecords(dept, season) {
  const r = await sb(`${RECORDS_TABLE}?season=eq.${season}&dept=eq.${dept}&select=teacher_id,state,version`);
  if (isMissingTable(r)) return { missing: true, records: [] };
  if (!r.ok) throw new HttpError(502, `Supabase GET failed: ${r.status}`);
  return { missing: false, records: r.data || [] };
}
async function getRecord(dept, season, teacherId) {
  const r = await sb(`${RECORDS_TABLE}?season=eq.${season}&dept=eq.${dept}&teacher_id=eq.${teacherId}&select=teacher_id,state,version`);
  if (isMissingTable(r)) throw recordsMissingError();
  if (!r.ok) throw new HttpError(502, `Supabase GET failed: ${r.status}`);
  return (r.data && r.data[0]) || null;
}

/* ── 현재 회기: 명단 + 선생님별 기록 불러오기 (명단 행이 없으면 직전 회기에서 복사해 생성) ── */
async function handleGet(dept, season) {
  let row = await getRoster(dept, season);
  if (!row) row = await createSeasonRoster(dept, season);
  if (!row) return json({ roster_row_missing: true, teachers: [], records: [] });
  const out = { ...rosterPublic(row), legacy_state: row.state || [], records: [] };
  const rec = await getRecords(dept, season);
  if (rec.missing) out.records_error = 'records_table_missing';
  else out.records = rec.records;
  return json(out);
}

/* ── 지난 회기: 조회 전용 (이름·기록만, 비밀번호·PIN 제외) ── */
async function handlePastGet(dept, season) {
  if (season <= LEGACY_SEASON) {
    const row = (await getLegacyRow(dept)) || {};
    return json({ teachers: (row.teachers || []).map(t => ({ name: t.name })), state: row.state || [] });
  }
  const row = await getRoster(dept, season);
  if (!row) return json({ teachers: [], state: [] });
  const teachers = ensureIds(row.teachers);
  const { records } = await getRecords(dept, season);
  const byId = {};
  records.forEach(r => { byId[r.teacher_id] = r; });
  const legacy = row.state || [];
  return json({
    teachers: teachers.map(t => ({ name: t.name })),
    // 선생님별 기록이 없으면 예전 통째 저장분에서 가져옴 (화면의 2027 회기 규칙과 동일)
    state: teachers.map(t => (byId[t.id] ? byId[t.id].state : (legacy[legacyIndex(t.id)] || null))),
  });
}

/* ── 관리자 명단·PIN·마감 설정 저장 (기록은 건드리지 않음) ── */
async function handleSaveRoster(dept, season, p) {
  if (!p || !Array.isArray(p.teachers)) throw new HttpError(400, 'Invalid teachers');
  const ids = new Set();
  const teachers = p.teachers.map(t => {
    if (!t || !ID_RE.test(String(t.id)) || ids.has(t.id)) throw new HttpError(400, 'Invalid teacher id');
    ids.add(t.id);
    return { id: String(t.id), name: String(t.name || '').slice(0, 30), pin: String(t.pin || '').slice(0, 20) };
  });
  const saved = await patchRosterIfVersion(dept, season, p.roster_version, {
    org_name: String(p.org_name || '').slice(0, 30),
    admin_pw: String(p.admin_pw || '').slice(0, 20),
    teachers,
    locked_months: p.locked_months || {},
  });
  if (saved) return json({ ok: true, roster_version: saved.updated_at });
  const row = await getRoster(dept, season);
  if (!row) throw rowMissingError(dept, season);
  return json({ conflict: true, roster: rosterPublic(row) }, 409);
}

/* ── 선생님 PIN 변경 (본인 PIN만 바꾸고 다른 사람 정보는 그대로) ── */
async function handleSetPin(dept, season, p) {
  if (!p || !ID_RE.test(String(p.teacher_id))) throw new HttpError(400, 'Invalid teacher id');
  const newPin = String(p.new_pin || '').trim();
  if (!newPin || newPin.length > 20) throw new HttpError(400, 'Invalid PIN');
  for (let attempt = 0; attempt < 3; attempt++) {
    const row = await getRoster(dept, season);
    if (!row) throw rowMissingError(dept, season);
    const teachers = ensureIds(row.teachers);
    const idx = teachers.findIndex(t => t.id === p.teacher_id);
    if (idx === -1) throw new HttpError(404, '명단에 없는 선생님입니다.');
    if (teachers[idx].pin !== String(p.old_pin || '')) throw new HttpError(403, '현재 PIN이 올바르지 않습니다.', { code: 'wrong_pin' });
    teachers[idx] = { ...teachers[idx], pin: newPin };
    const saved = await patchRosterIfVersion(dept, season, row.updated_at, { teachers });
    if (saved) return json({ ok: true, roster_version: saved.updated_at });
  }
  throw new HttpError(409, '다른 저장과 겹쳤습니다. 잠시 후 다시 시도해주세요.');
}

/* ── 선생님 한 명의 기록 저장 (그 선생님 행만 수정) ── */
async function handleSaveRecord(dept, season, p) {
  if (!p || !ID_RE.test(String(p.teacher_id))) throw new HttpError(400, 'Invalid teacher id');
  if (!Array.isArray(p.state) || p.state.length > 20) throw new HttpError(400, 'Invalid state');
  if (JSON.stringify(p.state).length > 100000) throw new HttpError(400, 'State too large');
  const version = Number(p.version);
  if (!Number.isInteger(version) || version < 0) throw new HttpError(400, 'Invalid version');

  const row = await getRoster(dept, season);
  if (!row) throw rowMissingError(dept, season);
  if (!ensureIds(row.teachers).some(t => t.id === p.teacher_id)) throw new HttpError(404, '명단에 없는 선생님입니다.', { code: 'unknown_teacher' });

  const now = new Date().toISOString();
  const seasonStr = String(season);
  if (version === 0) {
    // 처음 저장: 새 행 만들기 (이미 있으면 충돌로 처리)
    const r = await sb(RECORDS_TABLE, {
      method: 'POST',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({ season: seasonStr, dept, teacher_id: p.teacher_id, state: p.state, version: 1, updated_at: now }),
    });
    if (isMissingTable(r)) throw recordsMissingError();
    if (r.ok) return json({ ok: true, version: 1 });
    if (r.status !== 409) throw new HttpError(502, `Supabase POST failed: ${r.status} ${r.text}`);
  } else {
    // 내가 마지막으로 본 버전일 때만 수정
    const r = await sb(`${RECORDS_TABLE}?season=eq.${seasonStr}&dept=eq.${dept}&teacher_id=eq.${p.teacher_id}&version=eq.${version}`, {
      method: 'PATCH',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({ state: p.state, version: version + 1, updated_at: now }),
    });
    if (isMissingTable(r)) throw recordsMissingError();
    if (!r.ok) throw new HttpError(502, `Supabase PATCH failed: ${r.status} ${r.text}`);
    if (r.data && r.data.length) return json({ ok: true, version: version + 1 });
  }
  // 다른 곳에서 먼저 저장됨 → 최신 기록을 돌려주고 화면에서 병합 후 다시 저장
  return json({ conflict: true, record: await getRecord(dept, season, p.teacher_id) }, 409);
}

export async function onRequestPost(context) {
  let body;
  try {
    body = await context.request.json();
  } catch (e) {
    return json({ error: 'Invalid JSON' }, 400);
  }

  const cur = currentSeason();
  const { dept, method, body: payload, season } = body || {};

  // 회기 정보만 묻는 요청
  if (method === 'SEASON') return json({ current_season: cur, seasons: [cur - 1, cur] });

  if (!dept || !['junior', 'senior'].includes(dept)) {
    return json({ error: 'Invalid dept', current_season: cur }, 400);
  }

  const hasSeason = season !== undefined && season !== null;
  const reqSeason = hasSeason ? Number(season) : cur;
  // 조회 가능한 회기: 현재 + 직전 회기뿐
  if (!Number.isInteger(reqSeason) || (reqSeason !== cur && reqSeason !== cur - 1)) {
    return json({ error: '조회할 수 없는 연도입니다', code: 'season_not_viewable', current_season: cur }, 403);
  }

  const withSeason = async (resPromise) => {
    const res = await resPromise;
    const data = await res.json();
    return json({ ...data, season: reqSeason, current_season: cur }, res.status);
  };

  try {
    if (method === 'GET') {
      return await withSeason(reqSeason === cur ? handleGet(dept, cur) : handlePastGet(dept, reqSeason));
    }
    if (method === 'PUT') {
      // 예전 화면의 "부서 전체 통째로 저장"은 더 이상 받지 않음
      return json({ error: '사이트가 업데이트되었습니다. 페이지를 새로고침 해주세요.', code: 'outdated_client', current_season: cur }, 410);
    }
    if (!['SAVE_ROSTER', 'SET_PIN', 'SAVE_RECORD'].includes(method)) {
      return json({ error: 'Invalid method', current_season: cur }, 400);
    }
    // 쓰기는 회기를 밝힌 요청 + 현재 회기만 허용 (지난 회기·2026 원본 행은 절대 수정하지 않음)
    if (!hasSeason) {
      return json({ error: '사이트가 업데이트되었습니다. 페이지를 새로고침 해주세요.', code: 'outdated_client', current_season: cur }, 410);
    }
    if (reqSeason !== cur || reqSeason <= LEGACY_SEASON) {
      return json({ error: '지난해 기록은 조회만 가능합니다', code: 'season_closed', current_season: cur }, 403);
    }
    if (method === 'SAVE_ROSTER') return await withSeason(handleSaveRoster(dept, cur, payload));
    if (method === 'SET_PIN') return await withSeason(handleSetPin(dept, cur, payload));
    return await withSeason(handleSaveRecord(dept, cur, payload));
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    return json({ error: e.message, ...(e.extra || {}), current_season: cur }, status);
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
