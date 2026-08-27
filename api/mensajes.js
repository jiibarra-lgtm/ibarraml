// GET /api/mensajes?order_id=X          -> trae la conversación de ese pedido
// GET /api/mensajes?modo=test            -> prueba el mensaje automático

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
  const { order_id, modo } = req.query;
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);
  const { data: authRow } = await supabase.from('ml_auth').select('*').order('updated_at', { ascending: false }).limit(1).single();
  if (!authRow) return res.status(400).json({ error: 'No hay cuenta de ML conectada' });

  try {
    const accessToken = await refreshTokenIfNeeded(supabase, authRow);

    if (modo === 'enviar') {
      const { order_id: orderIdEnviar } = req.query;
      if (!orderIdEnviar) return res.status(400).json({ error: 'Falta order_id' });

      const { data: pedido } = await supabase.from('pedidos')
        .select('order_id, pack_id, seller_id, vendedor_nickname, titulo, numero_operacion, fecha_creacion')
        .eq('order_id', orderIdEnviar).single();
      if (!pedido || !pedido.seller_id) return res.status(400).json({ error: 'No se encontró el vendedor de este pedido' });

      const { data: configRow } = await supabase.from('config').select('plantilla_factura').eq('id', 1).single();
      const plantilla = configRow?.plantilla_factura || 'Hola! Te escribo por la compra "{titulo}" (pedido #{numero}) del {fecha}.\n\n¿Me podrías enviar la factura correspondiente a esta compra? La necesito para mi contabilidad. ¡Gracias!';
      const texto = plantilla
        .replaceAll('{titulo}', pedido.titulo || '')
        .replaceAll('{numero}', String(pedido.numero_operacion || pedido.order_id))
        .replaceAll('{fecha}', pedido.fecha_creacion ? new Date(pedido.fecha_creacion).toLocaleDateString('es-AR') : '')
        .slice(0, 350);

      const packId = pedido.pack_id || pedido.order_id;
      const resp = await fetch(`https://api.mercadolibre.com/messages/packs/${packId}/sellers/${pedido.seller_id}?tag=post_sale`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: { user_id: String(authRow.user_id) }, to: { user_id: String(pedido.seller_id) }, text: texto }),
      });
      const data = await resp.json();
      if (!resp.ok) return res.status(200).json({ ok: false, funciona: false, order_id: orderIdEnviar, error: data });
      await supabase.from('pedidos').update({ mensaje_factura_enviado: true }).eq('order_id', orderIdEnviar);
      return res.status(200).json({ ok: true, funciona: true, order_id: orderIdEnviar });
    }

    if (modo === 'sinchat') {
      const offset = Number(req.query?.offset) || 0;
      const limit = Math.min(Number(req.query?.limit) || 20, 30);

      const { data: pendientes, count } = await supabase.from('pedidos')
        .select('order_id, pack_id, seller_id, vendedor_nickname, titulo, total, fecha_creacion', { count: 'exact' })
        .is('factura_ml_id', null)
        .not('seller_id', 'is', null)
        .order('fecha_creacion', { ascending: false })
        .range(offset, offset + limit - 1);

      const sinChat = [];
      for (const p of pendientes || []) {
        const packId = p.pack_id || p.order_id;
        try {
          const resp = await fetch(`https://api.mercadolibre.com/messages/packs/${packId}/sellers/${p.seller_id}?tag=post_sale&mark_as_read=false&limit=1`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (!resp.ok) continue;
          const data = await resp.json();
          if (!(data.messages || []).length) {
            sinChat.push({ order_id: p.order_id, titulo: p.titulo, vendedor: p.vendedor_nickname, total: p.total, fecha: p.fecha_creacion });
          }
        } catch { /* seguimos con el siguiente */ }
      }

      const total = count || 0;
      const done = offset + limit >= total;
      return res.status(200).json({ ok: true, sinChat, total, next_offset: offset + limit, done });
    }

    if (modo === 'vistos') {
      const offset = Number(req.query?.offset) || 0;
      const limit = Math.min(Number(req.query?.limit) || 20, 30);

      const { data: pendientes, count } = await supabase.from('pedidos')
        .select('order_id, pack_id, seller_id, vendedor_nickname, titulo', { count: 'exact' })
        .eq('mensaje_factura_enviado', true)
        .not('seller_id', 'is', null)
        .order('fecha_creacion', { ascending: false })
        .range(offset, offset + limit - 1);

      const vistos = [];
      for (const p of pendientes || []) {
        const packId = p.pack_id || p.order_id;
        try {
          const resp = await fetch(`https://api.mercadolibre.com/messages/packs/${packId}/sellers/${p.seller_id}?tag=post_sale&mark_as_read=false&limit=50`, {
            headers: { Authorization: `Bearer ${accessToken}` },
          });
          if (!resp.ok) continue;
          const data = await resp.json();
          const mensajes = data.messages || [];
          if (!mensajes.length) continue;

          // Buscamos nuestro último mensaje enviado (from = nosotros)
          const misMensajes = mensajes.filter(m => String(m.from?.user_id) === String(authRow.user_id));
          if (!misMensajes.length) continue;
          const ultimoMio = misMensajes[misMensajes.length - 1];
          const fueLeido = !!ultimoMio.message_date?.read;
          if (!fueLeido) continue; // todavía ni lo vio

          // ¿Respondió el vendedor DESPUÉS de leerlo?
          const respondioDespues = mensajes.some(m =>
            String(m.from?.user_id) === String(p.seller_id) &&
            new Date(m.message_date?.received || 0) > new Date(ultimoMio.message_date.read)
          );
          if (!respondioDespues) {
            vistos.push({ order_id: p.order_id, titulo: p.titulo, vendedor: p.vendedor_nickname, fecha_leido: ultimoMio.message_date.read });
          }
        } catch { /* seguimos con el siguiente */ }
      }

      const total = count || 0;
      const done = offset + limit >= total;
      return res.status(200).json({ ok: true, vistos, total, next_offset: offset + limit, done });
    }

    if (modo === 'test') {
      const { data: pedido } = await supabase.from('pedidos')
        .select('order_id, pack_id, seller_id, vendedor_nickname, titulo, numero_operacion, fecha_creacion')
        .is('factura_ml_id', null).not('seller_id', 'is', null)
        .order('fecha_creacion', { ascending: false }).limit(1).single();
      if (!pedido) return res.status(400).json({ error: 'No encontré ningún pedido sin factura para probar. Sincronizá primero.' });

      const { data: configRow } = await supabase.from('config').select('plantilla_factura').eq('id', 1).single();
      const plantilla = configRow?.plantilla_factura || 'Hola! Te escribo por la compra "{titulo}" (pedido #{numero}) del {fecha}.\n\n¿Me podrías enviar la factura correspondiente a esta compra? La necesito para mi contabilidad. ¡Gracias!';
      const texto = plantilla
        .replaceAll('{titulo}', pedido.titulo || '')
        .replaceAll('{numero}', String(pedido.numero_operacion || pedido.order_id))
        .replaceAll('{fecha}', pedido.fecha_creacion ? new Date(pedido.fecha_creacion).toLocaleDateString('es-AR') : '')
        .slice(0, 350);

      const packId = pedido.pack_id || pedido.order_id;
      const resp = await fetch(`https://api.mercadolibre.com/messages/packs/${packId}/sellers/${pedido.seller_id}?tag=post_sale`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: { user_id: String(authRow.user_id) }, to: { user_id: String(pedido.seller_id) }, text: texto }),
      });
      const data = await resp.json();
      if (!resp.ok) return res.status(200).json({ ok: false, funciona: false, pedido: pedido.titulo, error: data });
      await supabase.from('pedidos').update({ mensaje_factura_enviado: true }).eq('order_id', pedido.order_id);
      return res.status(200).json({ ok: true, funciona: true, pedido: pedido.titulo, vendedor: pedido.vendedor_nickname, texto });
    }

    // Modo por default: traer la conversación real de un pedido
    if (!order_id) return res.status(400).json({ error: 'Falta order_id' });
    const { data: pedido } = await supabase.from('pedidos').select('pack_id, order_id, seller_id, vendedor_nickname').eq('order_id', order_id).single();
    if (!pedido || !pedido.seller_id) return res.status(400).json({ error: 'No se encontró el vendedor de este pedido' });

    const packId = pedido.pack_id || pedido.order_id;
    const resp = await fetch(`https://api.mercadolibre.com/messages/packs/${packId}/sellers/${pedido.seller_id}?tag=post_sale&mark_as_read=false&limit=50`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const data = await resp.json();
    if (!resp.ok) return res.status(resp.status).json({ error: 'No se pudieron traer los mensajes', detail: data });

    res.status(200).json({
      ok: true, vendedor: pedido.vendedor_nickname, mi_user_id: String(authRow.user_id),
      conversation_status: data.conversation_status, messages: data.messages || [],
    });
  } catch (err) {
    res.status(500).json({ error: 'Error inesperado', detail: String(err) });
  }
}
