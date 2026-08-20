// GET /api/login
// Redirige al usuario af autorizar la app en Mercado Libre.
// Requiere variables de entorno en Vercel:
//   ML_CLIENT_ID, ML_REDIRECT_URI
export default function handler(req, res) {
  const clientId = process.env.ML_CLIENT_ID;
  const redirectUri = process.env.ML_REDIRECT_URI;

  if (!clientId || !redirectUri) {
    return res.status(500).send('Faltan ML_CLIENT_ID / ML_REDIRECT_URI en las variables de entorno.');
  }

  const authUrl = `https://auth.mercadolibre.com.ar/authorization?response_type=code&client_id=${clientId}&redirect_uri=${encodeURIComponent(redirectUri)}`;
  res.writeHead(302, { Location: authUrl });
  res.end();
}
