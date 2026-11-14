const test = require('node:test');
const assert = require('node:assert');
const {
  computeBill,
  toUsdCents,
  splitCents,
  splitPaise,
  authorizationCeiling,
  SANDBOX_DEMO_EXCHANGE_RATE_INR_TO_USD
} = require('../src/utils/settlementEngine');
const { legacyComputeTotal } = require('./legacyComputeTotal');

// ============================================================================
// 1. REGRESSION SUITE: Compare against legacyComputeTotal for >= 12 scenarios
// ============================================================================
test('Regression Suite: 14 scenarios assert 100% identical totals vs legacyComputeTotal', () => {
  const scenarios = [
    {
      name: 'Scenario 1: Normal standard booking (base 299)',
      booking: { base_amount: 299 }
    },
    {
      name: 'Scenario 2: Emergency booking with surge (+100)',
      booking: { base_amount: 299, booking_type: 'emergency', emergency_surge: 100 }
    },
    {
      name: 'Scenario 3: Fair-wage distance surcharge (>7km at 10km)',
      booking: { base_amount: 299, distance_km: 10 }
    },
    {
      name: 'Scenario 4: Approved assistant / 2nd worker (+200)',
      booking: {
        base_amount: 299,
        second_worker: true,
        helper_request: { status: 'approved', amount: 200 }
      }
    },
    {
      name: 'Scenario 5: Approved extra work (+150)',
      booking: {
        base_amount: 299,
        extra_work: { approved: true, amount: 150 }
      }
    },
    {
      name: 'Scenario 6: Procured spare parts (+250)',
      booking: {
        base_amount: 299,
        part_order: { part_cost: 250 }
      }
    },
    {
      name: 'Scenario 7: Overtime boundary: active seconds exactly 7200 (overtime = 0)',
      booking: {
        base_amount: 299,
        duration_seconds: 7200,
        paused_seconds: 0,
        overtime_charge: 0
      }
    },
    {
      name: 'Scenario 8: Overtime boundary: active seconds 7201 (overtime = +20)',
      booking: {
        base_amount: 299,
        duration_seconds: 7201,
        paused_seconds: 0,
        overtime_charge: 20
      }
    },
    {
      name: 'Scenario 9: Procurement pause subtraction (7300s - 200s = 7100s <= 7200s, overtime = 0)',
      booking: {
        base_amount: 299,
        duration_seconds: 7300,
        paused_seconds: 200,
        overtime_charge: 0
      }
    },
    {
      name: 'Scenario 10: First-time user discount (-50)',
      booking: {
        base_amount: 299,
        discount_applied: 50
      }
    },
    {
      name: 'Scenario 11: Prior cancellation penalty rollover (+50)',
      booking: {
        base_amount: 299,
        cancellation_penalty_fee: 50
      }
    },
    {
      name: 'Scenario 12: Minimum bill floor (base 50 - 50 discount clamped to 49)',
      booking: {
        base_amount: 50,
        discount_applied: 50
      }
    },
    {
      name: 'Scenario 13: Bulk institutional project (multi-day contract)',
      booking: {
        base_amount: 5000,
        is_bulk_project: true,
        duration_seconds: 15000 // Multi-day project waves overtime
      }
    },
    {
      name: 'Scenario 14: Comprehensive multi-item complex combo',
      booking: {
        base_amount: 299,
        emergency_surge: 100,
        distance_km: 12,
        second_worker: true,
        helper_request: { status: 'approved', amount: 200 },
        extra_work: { approved: true, amount: 150 },
        part_order: { part_cost: 350 },
        overtime_charge: 20,
        cancellation_penalty_fee: 50,
        discount_applied: 50
      }
    }
  ];

  for (const s of scenarios) {
    const expectedLegacyTotal = legacyComputeTotal(s.booking);
    const actualBill = computeBill(s.booking);
    assert.strictEqual(
      actualBill.totalRupees,
      expectedLegacyTotal,
      `${s.name} mismatch: actual=${actualBill.totalRupees}, expectedLegacy=${expectedLegacyTotal}`
    );
  }
});

// ============================================================================
// 2. OVERTIME & PAUSE BOUNDARY TESTS
// ============================================================================
test('Overtime strictly triggers after 7200 active seconds', () => {
  // Exactly 7200s active: overtime is 0
  const at7200 = computeBill({ base_amount: 299, duration_seconds: 7200, paused_seconds: 0 });
  assert.strictEqual(at7200.overtimePaise, 0);
  assert.strictEqual(at7200.totalRupees, 299);

  // 7201s active: overtime is 2000 paise (+₹20)
  const at7201 = computeBill({ base_amount: 299, duration_seconds: 7201, paused_seconds: 0 });
  assert.strictEqual(at7201.overtimePaise, 2000);
  assert.strictEqual(at7201.totalRupees, 319);

  // 7400s elapsed with 300s paused = 7100s active (<= 7200s): overtime is 0
  const pausedUnder = computeBill({ base_amount: 299, duration_seconds: 7400, paused_seconds: 300 });
  assert.strictEqual(pausedUnder.overtimePaise, 0);
  assert.strictEqual(pausedUnder.totalRupees, 299);

  // 7400s elapsed with 150s paused = 7250s active (> 7200s): overtime is +₹20
  const pausedOver = computeBill({ base_amount: 299, duration_seconds: 7400, paused_seconds: 150 });
  assert.strictEqual(pausedOver.overtimePaise, 2000);
  assert.strictEqual(pausedOver.totalRupees, 319);

  // Bulk multi-day project waived from runtime stopwatch overtime
  const bulkLong = computeBill({ base_amount: 5000, is_bulk_project: true, duration_seconds: 25000 });
  assert.strictEqual(bulkLong.overtimePaise, 0);
  assert.strictEqual(bulkLong.totalRupees, 5000);
});

// ============================================================================
// 3. LARGEST REMAINDER 80/10/6/4 SPLIT INVARIANT TESTS
// ============================================================================
test('splitCents: exact sum for specific amounts (499, 349, 1233, 1, 0)', () => {
  // 499
  const s499 = splitCents(499);
  assert.strictEqual(s499.artisan + s499.welfare + s499.reserve + s499.platform, 499);
  assert.deepStrictEqual(s499, { artisan: 399, welfare: 50, reserve: 30, platform: 20 });

  // 349
  const s349 = splitCents(349);
  assert.strictEqual(s349.artisan + s349.welfare + s349.reserve + s349.platform, 349);
  assert.deepStrictEqual(s349, { artisan: 279, welfare: 35, reserve: 21, platform: 14 });

  // 1233
  const s1233 = splitCents(1233);
  assert.strictEqual(s1233.artisan + s1233.welfare + s1233.reserve + s1233.platform, 1233);
  assert.deepStrictEqual(s1233, { artisan: 987, welfare: 123, reserve: 74, platform: 49 });

  // 1
  const s1 = splitCents(1);
  assert.strictEqual(s1.artisan + s1.welfare + s1.reserve + s1.platform, 1);
  assert.deepStrictEqual(s1, { artisan: 1, welfare: 0, reserve: 0, platform: 0 });

  // 0
  const s0 = splitCents(0);
  assert.deepStrictEqual(s0, { artisan: 0, welfare: 0, reserve: 0, platform: 0 });
});

test('splitCents: invariant loop over every total from 1 to 100,000 cents', () => {
  for (let c = 1; c <= 100000; c++) {
    const s = splitCents(c);
    const sum = s.artisan + s.welfare + s.reserve + s.platform;
    if (sum !== c) {
      assert.fail(`Split sum mismatch at total ${c}: got ${sum}`);
    }
  }
});

test('splitPaise: matches splitCents behavior', () => {
  const p = splitPaise(29900);
  assert.strictEqual(p.artisan + p.welfare + p.reserve + p.platform, 29900);
  assert.strictEqual(p.artisan, 23920);
  assert.strictEqual(p.welfare, 2990);
  assert.strictEqual(p.reserve, 1794);
  assert.strictEqual(p.platform, 1196);
});

// ============================================================================
// 4. USD CONVERSION & AUTHORIZATION CEILING
// ============================================================================
test('toUsdCents: converts once with constant demo rate', () => {
  assert.strictEqual(toUsdCents(0), 0);
  // 35000 paise (₹350) / 85 = 411.76 -> 412 cents ($4.12)
  assert.strictEqual(toUsdCents(35000), 412);
  // 29900 paise (₹299) / 85 = 351.76 -> 352 cents ($3.52)
  assert.strictEqual(toUsdCents(29900), 352);
  // 8500 paise (₹85) / 85 = 100 cents ($1.00)
  assert.strictEqual(toUsdCents(8500), 100);
});

test('authorizationCeiling: estimate plus 25% buffer', () => {
  assert.strictEqual(authorizationCeiling(1000), 1250);
  assert.strictEqual(authorizationCeiling(499), 624);
  assert.strictEqual(authorizationCeiling(100), 125);
  assert.strictEqual(authorizationCeiling(0), 0);
});
