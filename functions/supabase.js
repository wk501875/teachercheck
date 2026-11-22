const SUPABASE_URL = 'https://vmvalgkbdfyrdiayaxyz.supabase.co/rest/v1';
// 공개 키: 비밀 키를 설정하기 전까지만 임시로 사용 (Supabase에서 잠그면 이 키로는 2026 원본 행만 보임)
const SUPABASE_PUBLIC_KEY = 'sb_publishable_GkszbBMYO7SQYedNBw0-7Q_Jv90-DUH';
// 비밀 키는 코드에 적지 않고 Cloudflare Pages 설정(환경 변수 SUPABASE_SECRET_KEY)에 넣음 → 저장소가 공개여도 안전
let SB_KEY = SUPABASE_PUBLIC_KEY;
function useKeyFrom(env) {
  SB_KEY = (env && env.SUPABASE_SECRET_KEY) || SUPABASE_PUBLIC_KEY;
}

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
// 중고등부 학생 특이사항(인수인계): 학생 한 명 = student_notes 한 행. 중고등부만 사용, 삭제 없음(숨김만)
const NOTES_TABLE = 'student_notes';
const NOTE_FIELDS = ['name', 'teacher', 'salvation', 'family', 'sunday', 'saturday', 'attitude', 'personality', 'memo'];

function currentSeason() {
  const kst = new Date(Date.now() + 9 * 3600 * 1000); // 한국 시간
  const y = kst.getUTCFullYear(), m = kst.getUTCMonth() + 1;
  return Math.max(FIRST_SEASON, m === 12 ? y + 1 : y);
}
function rosterRowId(dept, season) {
  return `${dept}_${season}`;
}

function sbHeaders() {
  return { 'Content-Type': 'application/json', 'apikey': SB_KEY, 'Authorization': `Bearer ${SB_KEY}` };
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'Content-Type': 'application/json' } });
}

class HttpError extends Error {
  constructor(status, message, extra = {}) { super(message); this.status = status; this.extra = extra; }
}

async function sb(path, opt = {}) {
  const res = await fetch(`${SUPABASE_URL}/${path}`, { ...opt, headers: { ...sbHeaders(), ...(opt.headers || {}) } });
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

// 누구에게나 보내는 명단: 이름·ID만 (PIN·관리자 비밀번호는 절대 보내지 않음)
function rosterPublic(row) {
  return {
    org_name: row.org_name,
    teachers: ensureIds(row.teachers).map(t => ({ id: t.id, name: t.name })),
    locked_months: row.locked_months,
    roster_version: row.updated_at || null,
  };
}
// 관리자 비밀번호를 확인한 경우에만: PIN·관리자 비밀번호 포함 (관리 창에서 보고 고칠 수 있게)
function rosterAdmin(row) {
  return {
    ...rosterPublic(row),
    admin_pw: row.admin_pw,
    teachers: ensureIds(row.teachers).map(t => ({ id: t.id, name: t.name, pin: t.pin })),
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
async function handleGet(dept, season, p) {
  let row = await getRoster(dept, season);
  if (!row) row = await createSeasonRoster(dept, season);
  if (!row) return json({ roster_row_missing: true, teachers: [], records: [] });
  const admin = p && String(p.actor_id || '') === 'admin' && await isAdmin(season, p);
  const out = { ...(admin ? rosterAdmin(row) : rosterPublic(row)), legacy_state: row.state || [], records: [] };
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
  await requireAdmin(season, p);
  const cur = await getRoster(dept, season);
  if (!cur) throw rowMissingError(dept, season);
  const oldPin = {};
  ensureIds(cur.teachers).forEach(t => { oldPin[t.id] = t.pin; });
  const ids = new Set();
  const teachers = p.teachers.map(t => {
    if (!t || !ID_RE.test(String(t.id)) || ids.has(t.id)) throw new HttpError(400, 'Invalid teacher id');
    ids.add(t.id);
    // PIN을 비워 보내면 원래 PIN 유지
    const pin = String(t.pin || '').slice(0, 20) || String(oldPin[t.id] || '');
    return { id: String(t.id), name: String(t.name || '').slice(0, 30), pin };
  });
  const saved = await patchRosterIfVersion(dept, season, p.roster_version, {
    org_name: String(p.org_name || '').slice(0, 30),
    admin_pw: String(p.admin_pw || '').slice(0, 20) || String(cur.admin_pw || ''), // 비우면 원래 비밀번호 유지
    teachers,
    locked_months: p.locked_months || {},
  });
  if (saved) return json({ ok: true, roster_version: saved.updated_at });
  const row = await getRoster(dept, season);
  if (!row) throw rowMissingError(dept, season);
  return json({ conflict: true, roster: rosterAdmin(row) }, 409);
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
    if (!samePin(p.old_pin, teachers[idx].pin)) { await failPause(); throw new HttpError(403, '현재 PIN이 올바르지 않습니다.', { code: 'wrong_pin' }); }
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
  // 본인 확인: 그 선생님 본인(PIN) 또는 관리자만 저장 가능
  if (String(p.actor_id || '') === 'admin') await requireAdmin(season, p);
  else {
    const me = ensureIds(row.teachers).find(t => t.id === String(p.actor_id || ''));
    if (!me || String(p.actor_id) !== String(p.teacher_id) || !samePin(p.actor_secret, me.pin)) throw notAuthorized();
  }

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

/* ── 중고등부 학생 특이사항 ── */
function notesMissingError() {
  return new HttpError(503, '서버에 학생 특이사항 저장 공간(student_notes)이 아직 없습니다. 관리자가 SQL을 실행해야 합니다.', { code: 'notes_table_missing' });
}
async function getNote(season, studentId) {
  const r = await sb(`${NOTES_TABLE}?season=eq.${season}&dept=eq.senior&student_id=eq.${studentId}&select=*`);
  if (isMissingTable(r)) throw notesMissingError();
  if (!r.ok) throw new HttpError(502, `Supabase GET failed: ${r.status}`);
  return (r.data && r.data[0]) || null;
}
async function handleGetNotes(season) {
  const r = await sb(`${NOTES_TABLE}?season=eq.${season}&dept=eq.senior&select=student_id,class_name,data,archived,version,updated_at,updated_by&order=updated_at.asc`);
  if (isMissingTable(r)) throw notesMissingError();
  if (!r.ok) throw new HttpError(502, `Supabase GET failed: ${r.status}`);
  return json({ notes: r.data || [] });
}
/* ── 관리자: 선생님을 다른 부서로 옮기기 (이름·PIN·올해 기록을 함께, 원래 부서의 기록은 지우지 않음) ── */
function samePin(input, stored) {
  return !!stored && String(input || '') === String(stored);
}
function notAuthorized() {
  return new HttpError(403, '로그인 정보가 맞지 않습니다. 로그아웃 후 다시 로그인해주세요.', { code: 'not_authorized' });
}
async function isAdmin(season, p) {
  if (String(p.actor_id || '') !== 'admin') return false;
  for (const dept of ['senior', 'junior']) {
    const row = await getRoster(dept, season);
    if (row && samePin(p.actor_secret, row.admin_pw)) return true;
  }
  return false;
}
async function requireAdmin(season, p) {
  if (!(p && await isAdmin(season, p))) throw new HttpError(403, '관리자 비밀번호가 맞지 않습니다. 다시 로그인해주세요.', { code: 'not_authorized' });
}
const failPause = () => new Promise(r => setTimeout(r, 600)); // 틀린 PIN을 빠르게 계속 넣어보는 것을 늦춤

/* ── 로그인: PIN·관리자 비밀번호는 서버에서만 확인 ── */
async function handleLogin(dept, season, p) {
  p = p || {};
  if (String(p.actor_id || '') === 'admin') {
    if (await isAdmin(season, p)) return json({ ok: true, role: 'admin' });
    await failPause();
    return json({ error: '관리자 비밀번호가 맞지 않습니다.', code: 'wrong_password' }, 403);
  }
  let row = await getRoster(dept, season);
  if (!row) row = await createSeasonRoster(dept, season);
  if (!row) throw rowMissingError(dept, season);
  const t = ensureIds(row.teachers).find(x => x.id === String(p.actor_id || ''));
  if (t && samePin(p.actor_secret, t.pin)) return json({ ok: true, role: 'teacher', id: t.id, name: t.name });
  await failPause();
  return json({ error: 'PIN이 맞지 않습니다.', code: 'wrong_pin' }, 403);
}
async function handleMoveTeacher(from, season, p) {
  if (!p || !ID_RE.test(String(p.teacher_id))) throw new HttpError(400, 'Invalid teacher id');
  await requireAdmin(season, p);
  const to = from === 'junior' ? 'senior' : 'junior';
  const tid = String(p.teacher_id);
  let copiedId = null; // 기록을 이미 복사한 새 ID (다시 시도할 때 같은 ID를 씀)
  for (let attempt = 0; attempt < 3; attempt++) {
    const src = await getRoster(from, season), dst = await getRoster(to, season);
    if (!src) throw rowMissingError(from, season);
    if (!dst) throw rowMissingError(to, season);
    const srcT = ensureIds(src.teachers), dstT = ensureIds(dst.teachers);
    const t = srcT.find(x => x.id === tid);
    if (!t) throw new HttpError(404, '명단에 없는 선생님입니다. 화면을 새로고침해주세요.', { code: 'unknown_teacher' });

    // 새 부서에서 쓸 ID: 그 부서 명단에도, 기록에도 없는 ID (원래 ID가 비어 있으면 그대로)
    let newId = copiedId;
    if (!newId) {
      const { missing, records } = await getRecords(to, season);
      if (missing) throw recordsMissingError();
      const used = new Set([...dstT.map(x => x.id), ...records.map(x => x.teacher_id)]);
      newId = tid;
      while (used.has(newId)) newId = 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
    }
    if (dstT.some(x => x.id === newId)) { copiedId = null; continue; }

    // 1) 기록 복사 (선생님별 기록이 없으면 예전 통째 저장분에서)
    if (!copiedId) {
      const rec = await getRecord(from, season, tid);
      let state = rec ? rec.state : null;
      if (!state) {
        const li = legacyIndex(tid);
        if (li >= 0 && Array.isArray(src.state) && src.state[li]) state = src.state[li];
      }
      if (state) {
        const w = await sb(RECORDS_TABLE, {
          method: 'POST',
          headers: { 'Prefer': 'return=minimal' },
          body: JSON.stringify({ season: String(season), dept: to, teacher_id: newId, state, version: 1, updated_at: new Date().toISOString() }),
        });
        if (isMissingTable(w)) throw recordsMissingError();
        if (w.status === 409) continue; // 그사이 같은 ID가 생김 → 다른 ID로 다시
        if (!w.ok) throw new HttpError(502, `Supabase POST failed: ${w.status} ${w.text}`);
      }
      copiedId = newId;
    }

    // 2) 새 부서 명단에 추가 (마지막으로 본 버전일 때만)
    const added = await patchRosterIfVersion(to, season, dst.updated_at, {
      teachers: [...dstT.map(x => ({ id: x.id, name: x.name, pin: x.pin })), { id: newId, name: t.name, pin: t.pin }],
    });
    if (!added) continue;

    // 3) 원래 부서 명단에서 빼기 (그사이 바뀌었으면 다시 읽어서)
    let removed = false;
    for (let k = 0; k < 3 && !removed; k++) {
      const cur = k === 0 ? src : await getRoster(from, season);
      const left = ensureIds(cur.teachers).filter(x => x.id !== tid).map(x => ({ id: x.id, name: x.name, pin: x.pin }));
      removed = !!(await patchRosterIfVersion(from, season, cur.updated_at, { teachers: left }));
    }
    if (!removed) throw new HttpError(409, `새 부서에는 추가됐지만 원래 부서 명단에서 빼지 못했습니다. 관리 화면에서 ${t.name} 선생님을 한 번 더 확인해주세요.`);
    return json({ ok: true, to, new_id: newId, name: t.name });
  }
  throw new HttpError(409, '다른 저장과 겹쳤습니다. 잠시 후 다시 시도해주세요.');
}

// 저장하는 사람 확인: 선생님은 PIN, 관리자는 관리자 비밀번호 (현재 회기 중고등부 명단 기준)
async function noteActor(season, p) {
  const row = await getRoster('senior', season);
  if (!row) throw rowMissingError('senior', season);
  const id = String(p.actor_id || ''), secret = String(p.actor_secret || '');
  if (id === 'admin') {
    if (samePin(secret, row.admin_pw)) return { id: 'admin', name: '관리자', admin: true };
  } else {
    const t = ensureIds(row.teachers).find(x => x.id === id);
    if (t && samePin(secret, t.pin)) return { id: t.id, name: String(t.name || ''), admin: false };
  }
  throw notAuthorized();
}
// 작성한 선생님 본인과 관리자만 수정 가능 (작성자 정보가 없는 예전 기록은 마지막으로 저장한 선생님을 작성자로 봄)
function canEditNote(note, actor) {
  if (actor.admin) return true;
  const d = (note && note.data) || {};
  if (d.owner_id) return d.owner_id === actor.id;
  return !!note && note.updated_by === actor.name;
}

async function handleSaveNote(season, p) {
  if (!p || !ID_RE.test(String(p.student_id))) throw new HttpError(400, 'Invalid student id');
  const version = Number(p.version);
  if (!Number.isInteger(version) || version < 0) throw new HttpError(400, 'Invalid version');
  const actor = await noteActor(season, p);
  const src = p.data && typeof p.data === 'object' ? p.data : {};
  const data = {};
  NOTE_FIELDS.forEach(k => { data[k] = String(src[k] ?? '').slice(0, k === 'memo' ? 4000 : 60); });
  if (!data.name.trim()) throw new HttpError(400, '학생 이름을 입력해주세요.');
  if (version === 0) {
    // 새로 작성: 저장하는 사람이 작성자
    data.owner_id = actor.id; data.owner_name = actor.name;
  } else {
    const existing = await getNote(season, p.student_id);
    if (existing) {
      if (!canEditNote(existing, actor)) {
        throw new HttpError(403, '다른 선생님이 작성한 특이사항은 수정할 수 없습니다.', { code: 'not_owner' });
      }
      const ed = existing.data || {};
      data.owner_id = ed.owner_id || (actor.admin ? '' : actor.id);
      data.owner_name = ed.owner_name || (actor.admin ? '' : actor.name);
    }
  }
  const fields = {
    class_name: String(p.class_name || '').slice(0, 30),
    data,
    archived: !!p.archived,
    updated_by: actor.name,
    updated_at: new Date().toISOString(),
  };
  const okBody = v => json({ ok: true, version: v, updated_at: fields.updated_at, updated_by: actor.name, owner_id: data.owner_id || '', owner_name: data.owner_name || '' });
  if (version === 0) {
    const r = await sb(NOTES_TABLE, {
      method: 'POST',
      headers: { 'Prefer': 'return=minimal' },
      body: JSON.stringify({ season: String(season), dept: 'senior', student_id: p.student_id, ...fields, version: 1 }),
    });
    if (isMissingTable(r)) throw notesMissingError();
    if (r.ok) return okBody(1);
    if (r.status !== 409) throw new HttpError(502, `Supabase POST failed: ${r.status} ${r.text}`);
  } else {
    const r = await sb(`${NOTES_TABLE}?season=eq.${season}&dept=eq.senior&student_id=eq.${p.student_id}&version=eq.${version}`, {
      method: 'PATCH',
      headers: { 'Prefer': 'return=representation' },
      body: JSON.stringify({ ...fields, version: version + 1 }),
    });
    if (isMissingTable(r)) throw notesMissingError();
    if (!r.ok) throw new HttpError(502, `Supabase PATCH failed: ${r.status} ${r.text}`);
    if (r.data && r.data.length) return okBody(version + 1);
  }
  // 다른 선생님이 먼저 저장함 → 최신 내용을 돌려주고 화면에서 바뀐 칸만 합쳐 다시 저장
  return json({ conflict: true, note: await getNote(season, p.student_id) }, 409);
}

export async function onRequestPost(context) {
  useKeyFrom(context.env);
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
      return await withSeason(reqSeason === cur ? handleGet(dept, cur, payload) : handlePastGet(dept, reqSeason));
    }
    if (method === 'LOGIN') {
      if (reqSeason !== cur) return json({ error: '로그인은 올해 명단으로만 할 수 있습니다', code: 'season_closed', current_season: cur }, 403);
      return await withSeason(handleLogin(dept, cur, payload));
    }
    if (method === 'GET_NOTES') {
      if (dept !== 'senior') return json({ error: '학생 특이사항은 중고등부만 사용합니다', current_season: cur }, 400);
      await noteActor(cur, payload || {}); // 민감한 정보라서 중고등부 선생님·관리자만 (올해 명단 기준)
      return await withSeason(handleGetNotes(reqSeason));
    }
    if (method === 'PUT') {
      // 예전 화면의 "부서 전체 통째로 저장"은 더 이상 받지 않음
      return json({ error: '사이트가 업데이트되었습니다. 페이지를 새로고침 해주세요.', code: 'outdated_client', current_season: cur }, 410);
    }
    if (!['SAVE_ROSTER', 'SET_PIN', 'SAVE_RECORD', 'SAVE_NOTE', 'MOVE_TEACHER'].includes(method)) {
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
    if (method === 'MOVE_TEACHER') return await withSeason(handleMoveTeacher(dept, cur, payload));
    if (method === 'SAVE_NOTE') {
      if (dept !== 'senior') return json({ error: '학생 특이사항은 중고등부만 사용합니다', current_season: cur }, 400);
      return await withSeason(handleSaveNote(cur, payload));
    }
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
// 주소창에서 /supabase 를 열면: 비밀 키가 설정됐는지만 알려줌 (데이터는 보여주지 않음)
export async function onRequestGet(context) {
  const secure = !!(context.env && context.env.SUPABASE_SECRET_KEY);
  return json({ ok: true, secret_key: secure, message: secure ? '비밀 키 연결됨' : '비밀 키가 아직 설정되지 않았습니다 (공개 키 사용 중)' });
}
