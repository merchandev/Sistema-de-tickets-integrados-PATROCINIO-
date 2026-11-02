// Decide reminder campaigns using the event's Venezuela calendar, independent of host TZ.
function dueCampaigns(config, now = new Date()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(config.event_date || '')) return [];
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Caracas', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
  }).formatToParts(now).map(p => [p.type, p.value]));
  const today = `${parts.year}-${parts.month}-${parts.day}`;
  const days = Math.round((Date.parse(config.event_date + 'T00:00:00Z') - Date.parse(today + 'T00:00:00Z')) / 86400000);
  if (days === 2) return ['REMINDER_2_DAYS'];
  if (days === 1) return ['REMINDER_1_DAY'];
  if (days !== 0) return [];
  return `${parts.hour}:${parts.minute}` >= (config.conference_start || '16:00')
    ? ['REMINDER_TODAY', 'EVENT_STARTED'] : ['REMINDER_TODAY'];
}
module.exports = {dueCampaigns};
