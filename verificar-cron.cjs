const assert = require('node:assert/strict');
const {dueCampaigns} = require('./sistema-central/src/notificationSchedule');
const cfg = {event_date:'2026-11-15',conference_start:'16:00'};
const cases = [
  ['2026-11-13T16:00:00Z', ['REMINDER_2_DAYS']],
  ['2026-11-14T16:00:00Z', ['REMINDER_1_DAY']],
  ['2026-11-15T03:59:00Z', ['REMINDER_1_DAY']],
  ['2026-11-15T04:00:00Z', ['REMINDER_TODAY']],
  ['2026-11-15T19:59:00Z', ['REMINDER_TODAY']],
  ['2026-11-15T20:00:00Z', ['REMINDER_TODAY','EVENT_STARTED']],
  ['2026-11-16T04:00:00Z', []]
];
for (const [time, expected] of cases) assert.deepEqual(dueCampaigns(cfg,new Date(time)),expected);
console.log('OK: 7 escenarios de notificaciones automaticas, medianoche e inicio a las 16:00 en Caracas.');
