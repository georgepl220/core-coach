'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { selectRosterRow, validRect, repairLegacyPortraitCalibration } = require('../src/calibration-selection.js');
const { defaultCalibration, draftCalibration } = require('../src/hud-calibration.js');
const size = { width: 1280, height: 720 };
const row = { x: .29, y: .005, width: .16, height: .035 };

test('calibrating one team before the first analysis always saves ten valid rectangles', () => {
  const rects = selectRosterRow({ size, team: 'radiant', row });
  assert.equal(rects.length, 10); assert.ok(rects.every(validRect));
  assert.equal(rects[0].x, row.x); assert.equal(rects[4].x, row.x + 4 * row.width / 5);
  assert.deepEqual(rects.slice(5), defaultCalibration(size.width, size.height).rosterRects.slice(5));
});

test('calibration preserves saved opposite team, and can fill missing detections', () => {
  const saved = defaultCalibration(size.width, size.height).rosterRects;
  saved[0] = { x: .2, y: .003, width: .032, height: .034, team: 'radiant' };
  const slots = [{ rect: { x: 310, y: 3, width: 39, height: 25 } }];
  const rects = selectRosterRow({ size, team: 'dire', row: { ...row, x: .56 }, saved, slots });
  assert.deepEqual(rects.slice(0, 5), saved.slice(0, 5));
  assert.ok(rects.every(validRect)); assert.equal(rects[5].x, .56);
  const observed = selectRosterRow({ size, team: 'dire', row: { ...row, x: .56 }, slots });
  assert.equal(observed[0].x, 310 / 1280); assert.ok(observed.every(validRect));
});

test('invalid size, row and team never produce an apparently saved calibration', () => {
  for (const value of [{ size: null, team: 'radiant', row }, { size, team: 'other', row }, { size, team: 'dire', row: { ...row, x: .99 } }]) assert.equal(selectRosterRow(value), null);
});
test('draft calibration preserves the opposite draft row while game geometry stays independent',()=>{
  const selected=selectRosterRow({size,team:'radiant',row:{x:.11,y:.004,width:.31,height:.064},capturePhase:'draft'});
  assert.deepEqual(selected.slice(5),draftCalibration(size.width,size.height).rosterRects.slice(5));
  assert.notDeepEqual(selected.slice(5),defaultCalibration(size.width,size.height).rosterRects.slice(5));
});

test('legacy broken HUD bounds are repaired once without changing minimap and other settings', () => {
  const settings = { rosterRects: Array.from({length:10}, () => ({x:.29,y:.008385744234800839,width:.031132075471698117,height:.031446540880503145})), minimapRect: row, performanceMode:'economy', authToken:'private-fixture' };
  assert.equal(repairLegacyPortraitCalibration(settings), true);
  assert.equal(settings.rosterRects, null); assert.equal(settings.minimapRect, row);
  assert.equal(settings.performanceMode, 'economy'); assert.equal(settings.authToken, 'private-fixture');
  settings.rosterRects = [{x:.29,y:.01,width:.03,height:.04}];
  assert.equal(repairLegacyPortraitCalibration(settings), false);
  assert.ok(settings.rosterRects);
  const correct = { rosterRects: defaultCalibration(1280,720).rosterRects };
  assert.equal(repairLegacyPortraitCalibration(correct), false); assert.ok(correct.rosterRects);
});
