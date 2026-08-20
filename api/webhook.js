// POST /api/webhook
// Mercado Libre pega acá cada vez que cambia algo en un pedido o envío
// (tópicos Orderfs_v2 / Shipments que tildaste en el DevCenter).
// Por ahora solo disparamos un sync general; después se puede optimizar
// para sincronizar puntualmente el order_id que vino en la notificación.
//
// IMPORTANTE: hay que responder rápido con 200, si no ML reintenta y
// puede terminar bloqueando temporalmente las notificaciones.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(200).send('ok'); // ML a veces pinga con GET para validar, respondemos 200 igual
  }

  try {
    const { resource, topic, user_id, application_id, attempts, sent, received } = req.body || {};
    console.log('Notificación de ML recibida:', { topic, resource, user_id });

    // Respondemos 200 YA, sin esperar el sync completo (ML tiene timeout corto)
    res.status(200).send('ok');

    // Disparamos el sync en segundo plano (no bloqueante).
    // Nota: en Vercel serverless esto puede cortarse si la función ya respondió;
    // si ves que no llega a correr, lo pasamos a un cron en vez de reaccionar al webhook.
    fetch(`https://${req.headers.host}/api/sync`).catch((e) =>
      console.error('Error disparando sync desde webhook:', e)
    );
  } catch (err) {
    console.error('Error procesando webhook:', err);
    res.status(200).send('ok'); // igual respondemos 200 para que ML no reintente en loop
  }
}
