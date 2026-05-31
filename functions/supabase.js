const SUPABASE_URL = 'https://vmvalgkbdfyrdiayaxyz.supabase.co/rest/v1';
const SUPABASE_KEY = 'sb_publishable_GkszbBMYO7SQYedNBw0-7Q_Jv90-DUH';

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
  };

  try {
    if (method === 'GET') {
      const res = await fetch(`${SUPABASE_URL}/checklist_data?id=eq.${dept}&select=*`, { headers });
      if (!res.ok) throw new Error(`Supabase GET failed: ${res.status}`);
      const data = await res.json();
      return new Response(JSON.stringify(data[0] || {}), { status: 200, headers: { 'Content-Type': 'application/json' } });

    } else if (method === 'PUT') {
      const res = await fetch(`${SUPABASE_URL}/checklist_data?id=eq.${dept}`, {
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
