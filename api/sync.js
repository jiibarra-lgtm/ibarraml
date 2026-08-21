// GET /api/sync?offset=0&limit=40
// Procesa UN LOTE de pedidos por llamada (no todos de una), para no
// pasarse del tiempo máximo de ejecución de Vercel. El frontend llama
// este endpoint repetidas veces, avanzando el offset, hasta terminar.
//
// Si un pedido YA tiene foto/categoría guardada de una sync anterior,
// no vuelve a pedirla a la API de ML (ahorra llamadas y tiempo) —
// solo refresca los datos que sí pueden cambiar (estado, tracking).

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
  if (!resp.ok) throw new Error('No se pudo refrescar el token: ' + JSON.stringify(data));

  await supabase.from('ml_auth').update({
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    expires_at: new Date(Date.now() + data.expires_in * 1000).toISOString(),
    updated_at: new Date().toISOString(),
  }).eq('user_id', auth.user_id);

  return data.access_token;
}

async function getCategoriaNombre(categoryId, accessToken) {
  if (!categoryId) return null;
  try {
    const resp = await fetch(`https://api.mercadolibre.com/categories/${categoryId}`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.name;
  } catch { return null; }
}

async function getInfoProducto(itemId, accessToken) {
  if (!itemId) return { foto: null, sku: null, link: null };
  try {
    const resp = await fetch(`https://api.mercadolibre.com/items/${itemId}?attributes=thumbnail,secure_thumbnail,seller_custom_field,permalink`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!resp.ok) return { foto: null, sku: null, link: null };
    const data = await resp.json();
    return { foto: data.secure_thumbnail || data.thumbnail || null, sku: data.seller_custom_field || null, link: data.permalink || null };
  } catch { return { foto: null, sku: null, link: null }; }
}

async function getFacturaVendedor(packId, accessToken) {
  if (!packId) return null;
  try {
    const resp = await fetch(`https://api.mercadolibre.com/packs/${packId}/fiscal_documents`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!resp.ok) return null; // 404 = no tiene factura cargada, es normal
    const data = await resp.json();
    const doc = (data.fiscal_documents || [])[0];
    if (!doc) return null;
    return { id: doc.id, filename: doc.filename, fecha: doc.date };
  } catch { return null; }
}

async function getDescuentos(orderId, accessToken) {
  try {
    const resp = await fetch(`https://api.mercadolibre.com/orders/${orderId}/discounts`, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!resp.ok) return { descuento: 0, cupon: 0 };
    const data = await resp.json();
    let descuento = 0, cupon = 0;
    for (const d of data.details || []) {
      const monto = (d.items || []).reduce((a, it) => a + (it.amounts?.total || 0), 0);
      if (d.type === 'coupon') cupon += monto; else descuento += monto;
    }
    return { descuento, cupon };
  } catch { return { descuento: 0, cupon: 0 }; }
}

export default async function handler(req, res) {
  const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

  const { data: authRow, error: authErr } = await supabase
    .from('ml_auth').select('*').order('updated_at', { ascending: false }).limit(1).single();

  if (authErr || !authRow) {
    return res.status(400).json({ error: 'Todavía no conectaste tu cuenta de Mercado Libre. Andá a /api/login primero.' });
  }

  const offset = Number(req.query?.offset) || 0;
  const limit = Math.min(Number(req.query?.limit) || 40, 50);

  let procesados = 0, guardados = 0, nuevos = 0, cambiosEstado = 0;

  try {
    const accessToken = await refreshTokenIfNeeded(supabase, authRow);

    const ordersResp = await fetch(
      `https://api.mercadolibre.com/orders/search?buyer=${authRow.user_id}&sort=date_desc&offset=${offset}&limit=${limit}`,
      { headers: { Authorization: `Bearer ${accessToken}` } }
    );
    const ordersData = await ordersResp.json();
    if (!ordersResp.ok) {
      return res.status(400).json({ error: 'Error consultando pedidos', detail: ordersData });
    }
    const total = ordersData.paging?.total ?? (ordersData.results?.length || 0);

    for (const order of ordersData.results || []) {
      procesados++;

      const { data: existente } = await supabase.from('pedidos')
        .select('status_envio, imagen_url, categoria_nombre, sku, link_publicacion, factura_ml_id, fecha_estimada')
        .eq('order_id', order.id).single();
      const esNuevo = !existente;

      let shipping = null;
      if (order.shipping?.id) {
        try {
          const shipResp = await fetch(`https://api.mercadolibre.com/orders/${order.id}/shipments`, { headers: { Authorization: `Bearer ${accessToken}`, 'X-New-Domain': 'true' } });
          if (shipResp.ok) shipping = await shipResp.json();
        } catch (e) { console.error('shipment error', order.id, e); }
      }
      const shipInfo = Array.isArray(shipping) ? shipping.find(s => s.type === 'forward') : shipping;
      if (existente && existente.status_envio !== (shipInfo?.status || null)) cambiosEstado++;

      const primerItem = order.order_items?.[0]?.item;

      // Solo pedimos foto/categoría/sku a la API si TODAVÍA no los tenemos guardados
      let categoriaNombre = existente?.categoria_nombre || null;
      let infoProducto = { foto: existente?.imagen_url || null, sku: existente?.sku || null, link: existente?.link_publicacion || null };
      let descuentoInfo = { descuento: null, cupon: null };

      if (!existente || !existente.imagen_url) {
        infoProducto = await getInfoProducto(primerItem?.id, accessToken);
      }
      if (!existente || !existente.categoria_nombre) {
        categoriaNombre = await getCategoriaNombre(primerItem?.category_id, accessToken);
      }
      if (esNuevo) {
        descuentoInfo = await getDescuentos(order.id, accessToken);
      }

      // Factura del vendedor: solo la consultamos si todavía no la teníamos guardada
      let facturaVendedor = null;
      if (!existente || !existente.factura_ml_id) {
        const packRef = order.pack_id || order.id;
        facturaVendedor = await getFacturaVendedor(packRef, accessToken);
      }

      const metodoPago = order.payments?.[0]?.payment_type || null;
      const cuotas = order.payments?.[0]?.installments || null;
      const fechaPago = order.payments?.[0]?.date_approved || null;
      const precioUnitario = order.order_items?.[0]?.unit_price ?? null;
      const cantidadUnidades = order.order_items?.[0]?.quantity ?? 1;
      const variante = (primerItem?.variation_attributes || []).map(a => a.value_name).join(' / ') || null;

      // Tipo logístico real (self_service = Flex; fulfillment/drop_off/cross_docking = normal)
      const logisticType = shipInfo?.logistic_type || null;

      // Punto de retiro: solo si ML devuelve esos datos en el destino del envío (no todos los pedidos lo tienen)
      const destinoTipo = shipInfo?.destination?.type || null;
      const destinoDireccion = shipInfo?.destination?.shipping_address?.address_line || null;

      // Costo real de envío según el tipo de logística
      const costoEnvio = shipInfo?.shipping_option?.cost ?? null;

      // Detección de cambio de fecha estimada respecto a la última sync
      const fechaEstimadaNueva = shipInfo?.shipping_option?.estimated_delivery_time?.date || null;
      const fechaEstimadaCambio = !!(existente?.fecha_estimada && fechaEstimadaNueva && existente.fecha_estimada !== fechaEstimadaNueva);

      const payload = {
        order_id: order.id,
        pack_id: order.pack_id || null,
        numero_operacion: String(order.pack_id || order.id),
        seller_id: order.seller?.id || null,
        titulo: primerItem?.title || null,
        variante,
        sku: infoProducto.sku,
        link_publicacion: infoProducto.link,
        cantidad_items: order.order_items?.length || 1,
        cantidad_unidades: cantidadUnidades,
        precio_unitario: precioUnitario,
        total: order.total_amount,
        moneda: order.currency_id,
        cuotas,
        fecha_pago: fechaPago,
        vendedor_nickname: order.seller?.nickname || null,
        status_orden: order.status,
        status_envio: shipInfo?.status || null,
        substatus_envio: shipInfo?.substatus || null,
        tipo_envio: shipInfo?.type || null,
        logistic_type: logisticType,
        destino_tipo: destinoTipo,
        destino_direccion: destinoDireccion,
        costo_envio: costoEnvio,
        fecha_estimada: fechaEstimadaNueva,
        fecha_estimada_cambio: fechaEstimadaCambio,
        tracking_number: shipInfo?.tracking_number || null,
        categoria_id: primerItem?.category_id || null,
        categoria_nombre: categoriaNombre,
        metodo_pago: metodoPago,
        imagen_url: infoProducto.foto,
        fecha_creacion: order.date_created,
        fecha_despachado: shipInfo?.status_history?.date_shipped || null,
        fecha_entrega: shipInfo?.status_history?.date_delivered || null,
        entregado_confirmado: shipInfo?.status === 'delivered',
        ultima_sync: new Date().toISOString(),
        raw_order: order,
        raw_shipping: shipInfo,
        updated_at: new Date().toISOString(),
      };
      if (descuentoInfo.descuento !== null) payload.descuento_monto = descuentoInfo.descuento;
      if (descuentoInfo.cupon !== null) payload.cupon_monto = descuentoInfo.cupon;
      if (facturaVendedor) {
        payload.factura_ml_id = facturaVendedor.id;
        payload.factura_ml_filename = facturaVendedor.filename;
        payload.factura_ml_fecha = facturaVendedor.fecha;
      }

      const { error: upsertErr } = await supabase.from('pedidos').upsert(payload, { onConflict: 'order_id' });

      if (!upsertErr) {
        guardados++;
        if (esNuevo) nuevos++;
        if (order.seller?.id) {
          const { data: sellerActual } = await supabase.from('sellers').select('*').eq('seller_id', order.seller.id).single();
          await supabase.from('sellers').upsert({
            seller_id: order.seller.id,
            nickname: order.seller.nickname || sellerActual?.nickname || null,
            cantidad_compras: (sellerActual?.cantidad_compras || 0) + (esNuevo ? 1 : 0),
            total_gastado: (sellerActual?.total_gastado || 0) + (esNuevo ? (order.total_amount || 0) : 0),
            ultima_compra: order.date_created,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'seller_id' });
        }
      } else {
        console.error('upsert error', order.id, upsertErr);
      }
    }

    const done = offset + limit >= total;
    if (done) {
      await supabase.from('sync_logs').insert({ ok: true, procesados, guardados, nuevos, cambios_estado: cambiosEstado });
    }

    res.status(200).json({ ok: true, total_ml: total, procesados, guardados, nuevos, cambios_estado: cambiosEstado, offset, limit, next_offset: offset + limit, done });
  } catch (err) {
    console.error(err);
    await supabase.from('sync_logs').insert({ ok: false, procesados, guardados, nuevos, cambios_estado: cambiosEstado, error: String(err) });
    res.status(500).json({ error: 'Error inesperado', detail: String(err) });
  }
}
