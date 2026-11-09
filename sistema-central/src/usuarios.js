// Dashboard users from the server console (inside the central container):
//   node --no-warnings src/usuarios.js lista
//   node --no-warnings src/usuarios.js crear <correo> <superadmin|admin>
//   node --no-warnings src/usuarios.js contrasena <correo>
//   node --no-warnings src/usuarios.js eliminar <correo>
// Passwords are never taken from arguments: they come from standard input, either piped or typed
// at a prompt that does not show them. The superadmin cannot be deleted.
const auth = require('./adminAuth');
const { db } = require('./db');

function readPipe() {
  return new Promise((resolve, reject) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
    process.stdin.on('end', () => resolve(data.replace(/\r?\n$/, '')));
    process.stdin.on('error', reject);
  });
}
function promptHidden(label) {
  return new Promise(resolve => {
    const input = process.stdin;
    let value = '';
    process.stderr.write(label);
    input.setRawMode(true);
    input.setEncoding('utf8');
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\u0003') { input.setRawMode(false); process.stderr.write('\n'); process.exit(130); }
        if (ch === '\r' || ch === '\n') {
          input.setRawMode(false);
          input.off('data', onData);
          input.pause();
          process.stderr.write('\n');
          return resolve(value);
        }
        value = ch === '\u007f' || ch === '\b' ? value.slice(0, -1) : value + ch;
      }
    };
    input.on('data', onData);
    input.resume();
  });
}
async function readPassword(email) {
  if (!process.stdin.isTTY) return readPipe();
  const first = await promptHidden(`Contraseña para ${email}: `);
  const second = await promptHidden('Repítela: ');
  if (first !== second) throw new Error('Las contraseñas no coinciden.');
  return first;
}

const findUser = (email) => db.prepare('SELECT id, email, role FROM admin_users WHERE email = ?').get(auth.normalizeEmail(email));
const USAGE = 'Uso: usuarios.js lista | crear <correo> <superadmin|admin> | contrasena <correo> | eliminar <correo>';

async function main([command, email, role]) {
  switch (command) {
    case 'lista': {
      const users = auth.listAllUsers();
      if (!users.length) return 'Todavía no hay usuarios: el panel acepta la cuenta inicial.';
      return users.map(u => `${u.email}  ·  ${auth.ROLES[u.role]}  ·  último acceso: ${u.last_login_at || 'nunca'}`).join('\n');
    }
    case 'crear': {
      if (!email || !role) throw new Error(USAGE);
      const first = !auth.hasUsers();
      const result = auth.createUser({ email, password: await readPassword(email), role, createdBy: 'consola' });
      if (!result.ok) throw new Error(result.message);
      return `Creado: ${result.user.email} (${auth.ROLES[result.user.role]}).` +
        (first ? '\nDesde ahora el panel solo acepta los usuarios creados; la cuenta inicial dejó de funcionar en el login.' : '');
    }
    case 'contrasena':
    case 'contraseña': {
      const user = email && findUser(email);
      if (!user) throw new Error(email ? `No existe el usuario ${email}.` : USAGE);
      const result = auth.setUserPassword(user.id, await readPassword(user.email));
      if (!result.ok) throw new Error(result.message);
      return `Contraseña actualizada para ${user.email}. Sus sesiones abiertas se cerraron.`;
    }
    case 'eliminar': {
      const user = email && findUser(email);
      if (!user) throw new Error(email ? `No existe el usuario ${email}.` : USAGE);
      if (user.role === 'superadmin') throw new Error('El superadministrador no se puede eliminar.');
      auth.deleteUser(user.id);
      return `Eliminado: ${user.email}.`;
    }
    default:
      throw new Error(USAGE);
  }
}

main(process.argv.slice(2)).then(
  message => { console.log(message); process.exit(0); },
  err => { console.error(`Error: ${err.message}`); process.exit(1); }
);
