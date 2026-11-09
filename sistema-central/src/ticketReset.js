const fs = require('node:fs');
const path = require('node:path');

function resetTickets(db, storageDir) {
  const backupRoot = path.join(storageDir, 'ticket-reset-backups');
  fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  const backupDir = fs.mkdtempSync(path.join(backupRoot, 'reinicio-'));
  db.prepare('VACUUM INTO ?').run(path.join(backupDir, 'entradas.sqlite'));

  const archived = [];
  db.exec('BEGIN IMMEDIATE');
  try {
    const { changes } = db.prepare(`
      UPDATE tickets SET status = 'AVAILABLE', locked_by_session = NULL, locked_by_source = NULL,
        locked_at = NULL, locked_until = NULL, current_order_id = NULL, quoted_usd = NULL,
        quoted_rate = NULL, quoted_ves = NULL, updated_at = datetime('now')
    `).run();
    if (changes !== 250) throw new Error('El inventario no contiene las 250 entradas esperadas.');
    db.exec('DELETE FROM email_logs; DELETE FROM notification_campaigns; DELETE FROM orders;');

    for (const directory of ['uploads', 'tickets']) {
      const live = path.join(storageDir, directory);
      const backup = path.join(backupDir, directory);
      fs.renameSync(live, backup);
      archived.push({ live, backup });
      fs.mkdirSync(live);
    }

    db.exec('COMMIT');
    return { available: changes, backup: path.basename(backupDir) };
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } finally {
      for (const { live, backup } of archived.reverse()) {
        if (fs.existsSync(live)) fs.rmdirSync(live);
        fs.renameSync(backup, live);
      }
    }
    throw err;
  }
}

module.exports = { resetTickets };
