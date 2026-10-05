const SUPABASE_URL = 'https://vmvalgkbdfyrdiayaxyz.supabase.co/rest/v1';
const SUPABASE_KEY = 'sb_publishable_GkszbBMYO7SQYedNBw0-7Q_Jv90-DUH';

// 내년(2027)용 사이트 전용 저장 공간. 올해 운영 데이터(junior/senior)와 분리됨
const ROW_SUFFIX = '_2027';

export async function onRequestPost(context) {
  let body;
  try {
    body = await context.request.json();
  } catch (e) {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400 });
  }

  const { dept, method, body: payload } = body;

  if (!dept || !['junior', 'senior'].includes(dept)) {
    return new Response(JSON.stringify({ error: 'Invalid dept' }), { status: 400 });
  }

  const headers = {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_KEY,
    'Authorization': `Bearer ${SUPABASE_KEY}`,
