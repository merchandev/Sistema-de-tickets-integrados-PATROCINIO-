// Whether the stored BCV rate can still be used to sell tickets.

// Caracas calendar date (YYYY-MM-DD).
const caracasDate = (now = new Date()) => new Intl.DateTimeFormat('en-CA', {timeZone:'America/Caracas', year:'numeric', month:'2-digit', day:'2-digit'}).format(now);

// An official rate can be used if it was confirmed in the last 24 hours, or if its BCV value date
// ("Fecha Valor") is still today or later (BCV publishes the next business day's rate in advance).
function officialRateCurrent(config, now = new Date()) {
  if (!config.bcv_is_official) return false;
  if (now.getTime() - Date.parse(config.bcv_last_updated) <= 24 * 60 * 60 * 1000) return true;
  return /^\d{4}-\d{2}-\d{2}$/.test(config.bcv_value_date || '') && config.bcv_value_date >= caracasDate(now);
}

module.exports = {caracasDate, officialRateCurrent};
