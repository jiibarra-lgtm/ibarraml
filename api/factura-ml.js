// GET /api/factura-ml?pack_id=X&doc_id=Y
// Descarga el archivo fiscal (factura) que el VENDEDOR subió del lado de
// Mercado Libre para ese pack, usando el recurso oficial:
// GET /packs/{pack_id}/fiscal_documents/{fiscal_document_id}
// Pasa por el backend porque requiere el access_token, que nunca debe
// quedar expuesto en el navegador.

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

export default async function handler(req, res) {
  const { pack_id, doc_id } = req.query;
  if (!pack_id || !doc_id) return res.status(400).json({ error: 'Faltan pack_id y doc_id' });

  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: authRow } = await supabase.from('ml_auth').select('*').order('updated_at', { ascending: false }).limit(1).single();
  if (!authRow) return res.status(400).json({ error: 'No hay cuenta de ML conectada' });

  try {
    const accessToken = await refreshTokenIfNeeded(supabase, authRow);
    const resp = await fetch(`https://api.mercadolibre.com/packs/${pack_id}/fiscal_documents/${doc_id}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!resp.ok) {
      const err = await resp.json().catch(() => ({}));
      return res.status(resp.status).json({ error: 'No se pudo obtener la factura', detail: err });
    }
    const contentType = resp.headers.get('content-type') || 'application/pdf';
    const buffer = Buffer.from(await resp.arrayBuffer());
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Disposition', `inline; filename="factura_${pack_id}.pdf"`);
    res.status(200).send(buffer);
  } catch (err) {
    res.status(500).json({ error: 'Error inesperado', detail: String(err) });
  }
}
