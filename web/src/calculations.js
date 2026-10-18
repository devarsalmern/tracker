export const number = value => {
  const result = Number(value);
  return Number.isFinite(result) ? result : 0;
};
export const dateKey = value => String(value || '').slice(0, 10);
export const monthLabel = month => new Date(2020, month - 1, 1).toLocaleString('en', { month: 'long' });
export const daysInMonth = (year, month) => new Date(year, month, 0).getDate();
export const distanceOf = row => {
  const start = row.odo_start === '' || row.odo_start == null ? null : number(row.odo_start);
  const end = row.odo_end === '' || row.odo_end == null ? null : number(row.odo_end);
  return start != null && end != null && end >= start ? end - start : number(row.manual_km);
};

export function fuelSummary(fills = [], logs = []) {
  const ordered = [...fills].sort((a, b) => dateKey(a.fill_date).localeCompare(dateKey(b.fill_date)) || number(a.id) - number(b.id));
  const periods = ordered.map((fill, index) => {
    const next = ordered[index + 1] || null;
    const inPeriod = logs.filter(log => dateKey(log.work_date) >= dateKey(fill.fill_date) && (!next || dateKey(log.work_date) < dateKey(next.fill_date)));
    const km = inPeriod.reduce((sum, log) => sum + distanceOf(log), 0);
    const workDays = inPeriod.filter(log => distanceOf(log) > 0).length;
    return {
      fill, next, workDays, km,
      costPerKm: next && km > 0 ? number(fill.total_paid) / km : null,
      costPerWorkDay: next && workDays > 0 ? number(fill.total_paid) / workDays : null,
      kmSincePrevious: index > 0 && number(fill.odometer) > number(ordered[index - 1].odometer)
        ? number(fill.odometer) - number(ordered[index - 1].odometer) : null,
      tankConsumption: index > 0 && number(fill.odometer) > number(ordered[index - 1].odometer)
        ? number(fill.litres) / (number(fill.odometer) - number(ordered[index - 1].odometer)) * 100 : null
    };
  });
  const kmBetweenFirstAndLast = ordered.length > 1 ? number(ordered.at(-1).odometer) - number(ordered[0].odometer) : 0;
  const measuredLitres = ordered.slice(1).reduce((sum, fill) => sum + number(fill.litres), 0);
  const calculatedAverage = kmBetweenFirstAndLast > 0 ? measuredLitres / kmBetweenFirstAndLast * 100 : 0;
  const latest = ordered.at(-1) || null;
  return {
    ordered, periods, totalPaid: ordered.reduce((sum, x) => sum + number(x.total_paid), 0),
    totalLitres: ordered.reduce((sum, x) => sum + number(x.litres), 0),
    calculatedAverage, latestPrice: latest && number(latest.litres) > 0 ? number(latest.total_paid) / number(latest.litres) : 0,
    estimatedCostPerKm: number(calculatedAverage) / 100 * (latest && number(latest.litres) > 0 ? number(latest.total_paid) / number(latest.litres) : 0)
  };
}

export function fuelFor(log, logs = [], fills = [], settings = {}) {
  if (log.fuel_override !== '' && log.fuel_override != null && Number.isFinite(Number(log.fuel_override))) return number(log.fuel_override);
  const km = distanceOf(log);
  if (km <= 0) return 0;
  const summary = fuelSummary(fills, logs);
  if (settings.fuel_method === 'split') {
    const period = summary.periods.find(item => dateKey(log.work_date) >= dateKey(item.fill.fill_date) && item.next && dateKey(log.work_date) < dateKey(item.next.fill_date));
    if (period?.costPerKm != null) return km * period.costPerKm;
  }
  const latestBeforeLog = summary.ordered.filter(fill => dateKey(fill.fill_date) <= dateKey(log.work_date)).at(-1);
  const price = latestBeforeLog && number(latestBeforeLog.litres) > 0 ? number(latestBeforeLog.total_paid) / number(latestBeforeLog.litres) : 0;
  const average = number(settings.avg_consumption) || summary.calculatedAverage;
  return km * average / 100 * price;
}

export function summarize(logs = [], allLogs = logs, fills = [], settings = {}) {
  return logs.reduce((sum, row) => {
    const km = distanceOf(row);
    const fuel = fuelFor(row, allLogs, fills, settings);
    const income = number(row.earnings) + number(row.tips);
    const workCost = fuel + number(row.maintenance) + number(row.other_cost);
    const personal = number(row.personal_expense);
    sum.entries += 1;
    sum.hours += number(row.hours);
    sum.orders += number(row.orders_count);
    sum.km += km;
    sum.earnings += number(row.earnings);
    sum.tips += number(row.tips);
    sum.income += income;
    sum.fuel += fuel;
    sum.maintenance += number(row.maintenance);
    sum.other += number(row.other_cost);
    sum.workCost += workCost;
    sum.profit += income - workCost;
    sum.personal += personal;
    sum.expenses += workCost + personal;
    sum.savings += income - workCost - personal;
    return sum;
  }, { entries: 0, hours: 0, orders: 0, km: 0, earnings: 0, tips: 0, income: 0, fuel: 0, maintenance: 0, other: 0, workCost: 0, profit: 0, personal: 0, expenses: 0, savings: 0 });
}

function shiftHoursFor(shift, override, settings) {
  if (!shift || shift === 'Off') return 0;
  if (override !== '' && override != null && Number.isFinite(Number(override))) return number(override);
  const from = shift === 'Morning' ? settings.morning_start : settings.night_start;
  const to = shift === 'Morning' ? settings.morning_end : settings.night_end;
  if (!from || !to) return 0;
  const [fh, fm] = from.split(':').map(Number), [th, tm] = to.split(':').map(Number);
  return ((th * 60 + tm - (fh * 60 + fm) + 1440) % 1440) / 60;
}
export const shiftHours = (entry, index, settings) => shiftHoursFor(entry[`shift${index}`], entry[`hours${index}`], settings);
export const timeDuration = (from, to) => shiftHoursFor('Morning', '', { morning_start: from, morning_end: to });

export function shiftDay(entry, settings, loggedRows = [], today = new Date().toISOString().slice(0, 10), averageRate = 0) {
  const date = dateKey(entry.work_date);
  const types = ['Morning', 'Night', 'Off'];
  const unknown = [entry.shift1, entry.shift2].some(x => x && !types.includes(x));
  const hours = shiftHours(entry, '1', settings) + shiftHours(entry, '2', settings);
  const logged = loggedRows.filter(row => dateKey(row.work_date) === date);
  const loggedHours = logged.reduce((sum, row) => sum + number(row.hours), 0);
  const loggedIncome = logged.reduce((sum, row) => sum + number(row.earnings) + number(row.tips), 0);
  const rate1 = entry.shift1 === 'Morning' && number(settings.morning_rate) > 0 ? number(settings.morning_rate) : averageRate;
  const rate2 = entry.shift2 === 'Morning' && number(settings.morning_rate) > 0 ? number(settings.morning_rate) : averageRate;
  const rate3 = entry.shift1 === 'Night' && number(settings.night_rate) > 0 ? number(settings.night_rate) : averageRate;
  const rate4 = entry.shift2 === 'Night' && number(settings.night_rate) > 0 ? number(settings.night_rate) : averageRate;
  const expected = shiftHours(entry, '1', settings) * (entry.shift1 === 'Night' ? rate3 : rate1) + shiftHours(entry, '2', settings) * (entry.shift2 === 'Night' ? rate4 : rate2);
  let status = '';
  if (unknown) status = 'Unknown shift';
  else if (!entry.shift1 && entry.shift2) status = 'Pick Shift 1 first';
  else if (loggedHours > 0) status = hours > 0 ? 'Worked' : 'Worked (unplanned)';
  else if (!entry.shift1) status = '';
  else if (hours === 0) status = 'Off';
  else if (date < today) status = 'Not logged';
  else status = 'Planned';
  return { ...entry, plannedHours: hours, expectedIncome: expected, loggedHours, loggedIncome, status };
}

export function periodSummary(logs, fills, settings, year, month) {
  const subset = logs.filter(row => dateKey(row.work_date).startsWith(`${year}-${String(month).padStart(2, '0')}`));
  return summarize(subset, logs, fills, settings);
}

export function yearlyMonths(logs, fills, settings, year) {
  return Array.from({ length: 12 }, (_, index) => {
    const month = index + 1;
    return { month, ...periodSummary(logs, fills, settings, year, month) };
  });
}
