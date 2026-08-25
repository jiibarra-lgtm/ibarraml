// GET /api/revisar-facturas?offset=0&limit=30
// Revisa SOLO los pedidos que todavía no tienen factura del vendedor
// guardada, y les vuelve a preguntar a ML si ya la subieron. No toca
// fotos, categorías, envíos ni nada más — por eso es mucho más rápido
// que la sincronización completa.

import { createClient } from '@supabase/supabase-js';

async function refreshTokenIfNeeded(supabase, auth) {
  const expiresAt = new Date(auth.expires_at).getTime();
  if (Date.now() < expiresAt - 60_000) return auth.access_token;
  const resp = await fetch('https://api.mercadolibre.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: process.env.ML_CLIENT_ID,
      client_secret: process.env.ML_CLIENT_SECRET,
      refresh_token: auth.refresh_token,
    }),
  });
  const data = await resp.json();
  if (!resp.ok) throw new Error('No se pudo refrescar el token');
  await supabase.from('ml_auth').update({
    access_token: data.access_token, refresh_token: data.refresh_token,
    expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(), updated_at: new Date().toISOString(),
  }).eq('user_id', auth.user_id);
  return data.access_token;
}

async function getFacturaVendedor(packId, accessToken) {
  if (!packId) return null;
  try {
    const resp = await fetch(`https://api.mercadolibre.com/packs/${packId}/fiscal_documents`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!resp.ok) return null; // 404 = todavía no tiene, es normal
    const data = await resp.json();
    const doc = (data.fiscal_documents || [])[0];
    if (!doc) return null;
    return { id: doc.id, filename: doc.filename, fecha: doc.date };
  } catch { return null; }
}

export default async function handler(req, res) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: authRow } = await supabase.from('ml_auth').select('*').order('updated_at', { ascending: false }).limit(1).single();
  if (!authRow) return res.status(400).json({ error: 'No hay cuenta de ML conectada' });

  const offset = Number(req.query?.offset) || 0;
  const limit = Math.min(Number(req.query?.limit) || 30, 40);

  try {
    const accessToken = await refreshTokenIfNeeded(supabase, authRow);

    const { data: pendientes, count } = await supabase.from('pedidos')
      .select('order_id, pack_id', { count: 'exact' })
      .is('factura_ml_id', null)
      .order('fecha_creacion', { ascending: false })
      .range(offset, offset + limit - 1);

    let encontradas = 0;
    for (const p of pendientes || []) {
      const factura = await getFacturaVendedor(p.pack_id || p.order_id, accessToken);
      if (factura) {
        await supabase.from('pedidos').update({
          factura_ml_id: factura.id,
          factura_ml_filename: factura.filename,
          factura_ml_fecha: factura.fecha,
        }).eq('order_id', p.order_id);
        encontradas++;
      }
    }

    const total = count || 0;
    const done = offset + limit >= total;
    res.status(200).json({ ok: true, procesados: pendientes?.length || 0, encontradas, total, next_offset: offset + limit, done });
  } catch (err) {
    res.status(500).json({ error: 'Error inesperado', detail: String(err) });
  }
}
