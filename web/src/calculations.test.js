import test from 'node:test';
import assert from 'node:assert/strict';
import { daysInMonth, distanceOf, fuelDetailsFor, fuelFor, fuelSummary, periodSummary, shiftDay, shiftHours, summarize } from './calculations.js';

test('distance uses a valid odometer pair before manual kilometres', () => {
  assert.equal(distanceOf({ odo_start: 100, odo_end: 160, manual_km: 90 }), 60);
  assert.equal(distanceOf({ odo_start: 100, odo_end: 90, manual_km: 12 }), 12);
  assert.equal(distanceOf({ odo_start: '', odo_end: '', manual_km: 12 }), 12);
});

test('financial totals exclude personal costs from net profit and include them in savings', () => {
  const rows = [{ work_date: '2026-10-01', earnings: 120, tips: 10, hours: 5, maintenance: 4, other_cost: 6, personal_expense: 20, fuel_override: 10 }];
  const summary = summarize(rows, rows, [], {});
  assert.equal(summary.income, 130);
  assert.equal(summary.workCost, 20);
  assert.equal(summary.profit, 110);
  assert.equal(summary.expenses, 40);
  assert.equal(summary.savings, 90);
});

test('fill-up split allocates one closed-period purchase proportionally across work kilometres', () => {
  const fills = [
    { id: 1, fill_date: '2026-01-01', odometer: 1000, litres: 10, total_paid: 50 },
    { id: 2, fill_date: '2026-01-03', odometer: 1100, litres: 10, total_paid: 55 }
  ];
  const rows = [
    { work_date: '2026-01-01', manual_km: 40 },
    { work_date: '2026-01-02', manual_km: 60 }
  ];
  assert.equal(fuelFor(rows[0], rows, fills, { fuel_method: 'split' }), 20);
  assert.equal(fuelFor(rows[1], rows, fills, { fuel_method: 'split' }), 30);
  assert.equal(summarize(rows, rows, fills, { fuel_method: 'split' }).fuel, 50);
  assert.deepEqual(fuelDetailsFor(rows[0], fills, rows), { fillDate: '2026-01-01', ratePerKm: 0.5, pricePerLitre: 5 });
});

test('fuel override replaces computed cost and average requires reliable full-tank readings', () => {
  const rows = [{ work_date: '2026-02-02', manual_km: 100, fuel_override: 7 }];
  assert.equal(fuelFor(rows[0], rows, [], { manual_cost_per_km: 0.2 }), 7);
  const fullTanks = [
    { fill_date: '2026-02-01', odometer: 1000, litres: 0, total_paid: 0, full_tank: true },
    { fill_date: '2026-02-05', odometer: 1100, litres: 10, total_paid: 20, full_tank: true }
  ];
  assert.equal(fuelSummary(fullTanks).calculatedAverage, 10);
  assert.equal(fuelSummary([{ ...fullTanks[0] }, { ...fullTanks[1], full_tank: false }]).calculatedAverage, 0);
  assert.equal(fuelFor({ work_date: '2026-02-02', manual_km: 100 }, [], [], { avg_consumption: 8, manual_cost_per_km: 0.18 }), 18);
});

test('custom overnight and split shifts calculate expected and logged values by start date', () => {
  const settings = {
    shift_types: [
      { name: 'Late', start: '18:00', end: '02:00', rate: 12 },
      { name: 'Early', start: '06:00', end: '10:00', rate: null }
    ]
  };
  const entry = { work_date: '2026-12-01', shift1: 'Late', shift2: 'Early', hours1: '', hours2: 3 };
  assert.equal(shiftHours(entry, '1', settings), 8);
  const result = shiftDay(entry, settings, [{ work_date: '2026-12-01', hours: 9, earnings: 90, tips: 10 }], '2026-10-19', 10);
  assert.equal(result.plannedHours, 11);
  assert.equal(result.expectedIncome, 126);
  assert.equal(result.loggedHours, 9);
  assert.equal(result.loggedIncome, 100);
  assert.equal(result.status, 'Worked');
});

test('monthly boundaries include leap days and annual periods use exact calendar months', () => {
  assert.equal(daysInMonth(2024, 2), 29);
  const rows = [
    { work_date: '2024-02-29', earnings: 25, tips: 5, hours: 2 },
    { work_date: '2024-03-01', earnings: 100, hours: 4 }
  ];
  const february = periodSummary(rows, rows, [], 2024, 2);
  assert.equal(february.income, 30);
  assert.equal(february.hours, 2);
});
