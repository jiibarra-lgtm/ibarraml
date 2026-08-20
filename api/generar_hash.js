// Corré esto UNA VEZ en tu compu (con Node instalado) para generar el hash
// de tu contraseña. El resultado es lo que va en la variable de entorno
// APP_PASSWORD_HASH de Vercel — la contraseña real nunca queda guardada
// en ningún ladof, solo este hash irreversible.
//
// Uso:
//   npm install bcryptjs
//   node generar_hash.js "tuContraseñaSecreta"

const bcrypt = require('bcryptjs');
const password = process.argv[2];

if (!password) {
  console.log('Uso: node generar_hash.js "tuContraseña"');
  process.exit(1);
}

const hash = bcrypt.hashSync(password, 10);
console.log('\nTu hash (esto va en APP_PASSWORD_HASH en Vercel):\n');
console.log(hash);
console.log('\nGuardalo y no lo compartas junto con la contraseña en texto plano.\n');
