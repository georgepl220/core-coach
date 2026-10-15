'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createClient, schemaContract, buildGuideQuery, buildMatchQuery, testConnection, ENDPOINT } = require('../src/stratz-client.cjs');
const { refreshStratz, extractStratzCarry, aggregateStratz, currentVersion } = require('../scripts/update-stratz.cjs');
const { defaultAbilityCatalog } = require('../src/build-import.cjs');
const { writeAtomic } = require('../scripts/update-d2pt.cjs');
const catalog = require('../data/wraith-king.json').items;
const abilityCatalog = defaultAbilityCatalog();
const NOW = '2026-10-12T12:00:00.000Z';
const patch = { id: 100, name: '7.41f', asOfDateTime: Date.parse('2026-10-10T00:00:00Z') / 1000 };
const TOKEN = 'mock-personal-token-only-for-tests';
const scalar = name => ({ kind: 'SCALAR', name });
const object = name => ({ kind: 'OBJECT', name });
const enumRef = name => ({ kind: 'ENUM', name });
const list = type => ({ kind: 'LIST', ofType: type });
const required = type => ({ kind: 'NON_NULL', ofType: type });
const f = (name, type, args = [], description = null) => ({ name, type, args, description });
const arg = (name, type) => ({ name, type, defaultValue: null });
const t = (name, fields) => ({ name, kind: 'OBJECT', fields });

// A documented-shape mock, not an authenticated live schema snapshot. The
// production adapter must introspect and validate these paths at runtime.
function schemaFixture(options = {}) {
  const int = scalar('Int'), long = scalar('Long'), string = scalar('String'), bool = scalar('Boolean');
  const pos = enumRef('MatchPlayerPositionType');
  return { queryType: { name: 'DotaQuery' }, types: [
    t('DotaQuery', [f('constants', object('ConstantQuery')), f('heroStats', object('HeroStatsQuery')), f('match', object('MatchType'), [arg('id', required(long))]), ...(options.noPlural ? [] : [f('matches', list(object('MatchType')), [arg('ids', required(list(required(long))))])])]),
    t('ConstantQuery', [f('gameVersions', list(object('GameVersionType')))]),
    t('GameVersionType', [f('id', int), f('name', string), f('asOfDateTime', long)]),
    t('HeroStatsQuery', [f('guide', list(object('HeroGuideListType')), [arg('heroId', long), arg('positionId', pos), arg('take', int)])]),
    t('HeroGuideListType', [f('guides', list(object('HeroGuideType')), [arg('take', int)])]),
    t('HeroGuideType', [f('matchId', long)]),
    t('MatchType', [f('id', long), f('startDateTime', long), f('durationSeconds', int), f('gameVersionId', int), f('didRadiantWin', bool), f('players', list(object('MatchPlayerType')))]),
    t('MatchPlayerType', [f('heroId', int), f('position', pos), f('variant', int), f('isVictory', bool), f('isRadiant', bool), f('stats', object('MatchPlayerStatsType')), f('playbackData', object('PlaybackType'))]),
    t('MatchPlayerStatsType', [f('itemPurchases', list(object('ItemPurchaseType')))]),
    t('ItemPurchaseType', [f('time', int), f('itemId', int)]),
    t('PlaybackType', [f('abilityLearnEvents', list(object('AbilityLearnEventsType')))]),
    t('AbilityLearnEventsType', [f('abilityId', int), f('time', int), f('levelObtained', int, [], options.levelDescription || null)]),
    { name: 'MatchPlayerPositionType', kind: 'ENUM', enumValues: ['POSITION_1', 'POSITION_2', 'POSITION_3'].map(name => ({ name })) },
  ] };
}
function matchFixture(options = {}) {
  return {
    id: options.id || 100001, startDateTime: options.startDateTime || Date.parse('2026-10-11T12:00:00Z') / 1000,
    durationSeconds: 2400, gameVersionId: options.patchId || 100, didRadiantWin: true,
    players: [{ heroId: 42, position: options.position || 'POSITION_1', variant: options.facetId ?? 1, isRadiant: true, isVictory: true,
      stats: { purchases: [
        { itemId: catalog.tango.id, time: -30 }, { itemId: catalog.phase_boots.id, time: 300 },
        { itemId: catalog.radiance.id, time: 1000 }, { itemId: catalog.blink.id, time: 1250 },
        { itemId: catalog.radiance.id, time: 1600 }, { itemId: 999999, time: 500 },
      ] },
      playbackData: { learns: [5086, 5087, 5087, 5088, 5087, 5089, 5087, 5088, 5088].map((abilityId, index) => ({ abilityId, time: index * 80, levelObtained: index + 1 })) },
    }],
  };
}
const response = data => ({ ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ data }) });
function apiFixture(options = {}) {
  const requests = [];
  const records = options.records || [matchFixture()];
  const fetch = async (url, request) => {
    assert.equal(url, ENDPOINT);
    const body = JSON.parse(request.body);
    requests.push({ query: body.query, variables: body.variables });
    assert.equal(request.headers.Authorization, `Bearer ${TOKEN}`);
    if (body.query.includes('CarryCoachSchema')) return response({ __schema: options.schema || schemaFixture() });
    if (body.query.includes('CarryCoachVersions')) return response({ constants: { versions: options.versions || [patch, { id: 99, name: '7.41e', asOfDateTime: patch.asOfDateTime - 86400 }] } });
    if (body.query.includes('CarryCoachGuides')) return response({ heroStats: { candidates: [{ guides: records.map(record => ({ matchId: record.id })) }] } });
    if (body.query.includes('CarryCoachMatches')) return response({ records });
    assert.fail('Unexpected GraphQL query');
  };
  return { fetch, requests };
}
const extractOptions = { now: NOW, patchId: patch.id, abilityCatalog };

test('schema-generated queries use authenticated field/argument types and POSITION_1', () => {
  const contract = schemaContract(schemaFixture());
  const guide = buildGuideQuery(contract, 500);
  assert.match(guide.query, /\$hero:Long/);
  assert.match(guide.query, /\$position:MatchPlayerPositionType/);
  assert.deepEqual(guide.variables, { hero: 42, position: 'POSITION_1', take: 60, nestedTake: 60 });
  const matches = buildMatchQuery(contract, [100001, 100002]);
  assert.match(matches.query, /\$ids:\[Long!\]!/);
  assert.match(matches.query, /itemPurchases/);
  assert.match(matches.query, /abilityLearnEvents/);
  assert.doesNotMatch(matches.query, /networthPerMinute|levelObtained/);
});

test('STRATZ refresh queries the selected carry and cannot ingest another hero', async () => {
  const juggernautCatalog = defaultAbilityCatalog({ heroId: 8 });
  const record = matchFixture();
  record.players[0].heroId = 8;
  record.players[0].stats.purchases = [
    { itemId: catalog.power_treads.id, time: 300 },
    { itemId: catalog.mjollnir.id, time: 1100 },
    { itemId: catalog.manta.id, time: 1450 },
  ];
  record.players[0].playbackData.learns = [5028, 5027, 5028, 5029, 5028, 5030, 5028, 5027].map((abilityId, index) => ({ abilityId, time: index * 80 }));
  assert.equal(extractStratzCarry(record, catalog, extractOptions), null);
  const observed = extractStratzCarry(record, catalog, { ...extractOptions, heroId: 8, abilityCatalog: juggernautCatalog });
  assert.equal(observed.heroId, 8);
  assert.equal(observed.roleEvidence.heroId, 8);
  assert.ok(observed.sequence.some(item => item.key === 'mjollnir'));
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), 'core-stratz-carry-'));
  try {
    const api = apiFixture({ records: [record] });
    const value = await refreshStratz({ token: TOKEN, now: NOW, fetch: api.fetch, heroId: 8, catalog, abilityCatalog: juggernautCatalog, destination: path.join(folder, 'juggernaut.json') });
    assert.equal(api.requests.find(request => request.query.includes('CarryCoachGuides')).variables.hero, 8);
    assert.equal(value.heroId, 8);
    assert.equal(value.externalUrl, 'https://stratz.com/heroes/8?positionIds=POSITION_1');
    assert.equal(value.currentAbilityCatalog.juggernaut_omni_slash.kind, 'ultimate');
    assert.equal(value.builds[0].skills[0].abilityKey, 'juggernaut_blade_fury');
    assert.ok(value.provenance.roleFilter.includes('heroId:8'));
    assert.throws(() => aggregateStratz([observed], { heroId: 42, patch, now: NOW }), { code: 'NO_SAMPLE' });
  } finally { await fs.rm(folder, { recursive: true, force: true }); }
});

test('a missing/renamed required field fails closed instead of issuing a guessed query', () => {
  const fixture = schemaFixture();
  fixture.types.find(value => value.name === 'MatchPlayerStatsType').fields[0].name = 'inventedPurchases';
  assert.throws(() => schemaContract(fixture), { code: 'SCHEMA_UNSUPPORTED' });
});

test('new required resolver arguments fail before an incomplete query is sent', () => {
  const fixture = schemaFixture();
  fixture.types.find(value => value.name === 'HeroStatsQuery').fields[0].args.push(arg('newRequiredFilter', required(scalar('Int'))));
  assert.throws(() => buildGuideQuery(schemaContract(fixture)), { code: 'SCHEMA_UNSUPPORTED' });
});

test('carry enum and facet need schema evidence; arbitrary scalar positions are refused', () => {
  const fixture = schemaFixture();
  fixture.types.find(value => value.name === 'MatchPlayerType').fields.find(value => value.name === 'position').type = scalar('Int');
  assert.throws(() => schemaContract(fixture), { code: 'SCHEMA_UNSUPPORTED' });
});

test('single-match resolver fallback uses typed aliases with bounded IDs', () => {
  const query = buildMatchQuery(schemaContract(schemaFixture({ noPlural: true })), [100001, 100002]);
  assert.match(query.query, /m0:match\(id:\$id0\)/);
  assert.deepEqual(query.variables, { id0: 100001, id1: 100002 });
  assert.throws(() => buildMatchQuery(schemaContract(schemaFixture()), Array(21).fill(1)), { code: 'INVALID_IDS' });
});

test('currentVersion ignores future releases and accepts exact released letter patch names', () => {
  assert.deepEqual(currentVersion([patch, { id: 101, name: '7.42', asOfDateTime: Date.parse(NOW) / 1000 + 600 }], NOW), patch);
  assert.throws(() => currentVersion([{ id: 1, name: 'unknown', asOfDateTime: 1 }], NOW), { code: 'INVALID_VERSION' });
});

test('ingestion checks carry position, fresh exact patch, known facet, event validity and item IDs', () => {
  const observed = extractStratzCarry(matchFixture(), catalog, extractOptions);
  assert.equal(observed.roleEvidence.position, 'POSITION_1');
  assert.deepEqual(observed.sequence.map(value => value.key), ['tango', 'phase_boots', 'radiance', 'blink']);
  assert.equal(observed.skillObservation.skills.length, 9);
  assert.equal(observed.skillObservation.levelVerified, false);
  assert.equal(observed.skillObservation.skills[5].heroLevel, 6);
  assert.equal(extractStratzCarry(matchFixture({ position: 'POSITION_3' }), catalog, extractOptions), null);
  assert.equal(extractStratzCarry(matchFixture({ patchId: 99 }), catalog, extractOptions), null);
  assert.equal(extractStratzCarry(matchFixture({ startDateTime: Date.parse(NOW) / 1000 - 8 * 86400 }), catalog, extractOptions), null);
  assert.equal(extractStratzCarry(matchFixture({ facetId: 0 }), catalog, extractOptions), null);
  assert.equal(extractStratzCarry(matchFixture({ facetId: 2 }), catalog, { ...extractOptions, facetId: 1 }), null);
});

test('hero-level claims require explicit live-schema semantics and legal event log', () => {
  assert.equal(schemaContract(schemaFixture()).heroLevelField, null);
  assert.equal(schemaContract(schemaFixture({ levelDescription: 'Hero level when the ability was learned.' })).heroLevelField.name, 'levelObtained');
  const observed = extractStratzCarry(matchFixture(), catalog, { ...extractOptions, recordedHeroLevels: true });
  assert.equal(observed.skillObservation.levelVerified, true);
  const invalid = matchFixture();
  invalid.players[0].playbackData.learns[5].levelObtained = 5;
  assert.equal(extractStratzCarry(invalid, catalog, { ...extractOptions, recordedHeroLevels: true }).skillObservation.levelVerified, false);
});

test('aggregate never combines different facets and labels curated sampling honestly', () => {
  const observations = [1, 1, 2].map((facetId, index) => extractStratzCarry(matchFixture({ id: 100001 + index, facetId }), catalog, extractOptions));
  const result = aggregateStratz(observations, { now: NOW, patch, abilityCatalog });
  assert.equal(result.providerId, 'stratz');
  assert.equal(result.sampleCount, 2);
  assert.equal(result.facet.id, 1);
  assert.equal(result.patch.minorPatchVerified, true);
  assert.match(result.provenance.population, /curated/);
  assert.doesNotMatch(JSON.stringify(result), /OpenDota|Dota2ProTracker/);
  assert.equal(result.builds[0].skills.length, 9);
  assert.deepEqual(result.benchmarks, { lastHits: [], netWorth: [] });
  assert.equal(aggregateStratz(observations, { now: NOW, patch, facetId: 2, abilityCatalog }).sampleCount, 1);
});

test('refresh stores a fully validated provider atomically and makes only four API calls for one batch', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'carry-stratz-'));
  const destination = path.join(temp, 'cache.json');
  try {
    const api = apiFixture();
    const result = await refreshStratz({ token: TOKEN, fetch: api.fetch, destination, now: NOW, catalog, abilityCatalog });
    assert.equal(api.requests.length, 4);
    assert.equal(result.validation.schemaVerified, true);
    assert.equal(result.validation.retainedFacetCarries, 1);
    assert.equal(JSON.parse(await fs.readFile(destination, 'utf8')).source, 'STRATZ recent parsed carry guides');
    assert.doesNotMatch(await fs.readFile(destination, 'utf8'), new RegExp(TOKEN));
  } finally { await fs.rm(destination, { force: true }); await fs.rmdir(temp); }
});

test('auth, no sample, incompatible schema and missing token preserve existing cache exactly', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'carry-stratz-'));
  const destination = path.join(temp, 'cache.json');
  const sentinel = 'existing verified cache\n';
  try {
    await fs.writeFile(destination, sentinel);
    const cases = [
      { token: '', fetch: () => assert.fail('no token must not call the network') },
      { token: TOKEN, fetch: async () => ({ ok: false, status: 403 }) },
      { token: TOKEN, fetch: apiFixture({ records: [matchFixture({ patchId: 99 })] }).fetch },
      { token: TOKEN, fetch: apiFixture({ schema: { queryType: { name: 'Missing' }, types: [] } }).fetch },
    ];
    for (const options of cases) {
      await assert.rejects(refreshStratz({ ...options, destination, now: NOW, catalog, abilityCatalog }));
      assert.equal(await fs.readFile(destination, 'utf8'), sentinel);
    }
  } finally { await fs.rm(destination, { force: true }); await fs.rmdir(temp); }
});

test('cancelling after the last API response keeps the existing STRATZ cache', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'carry-stratz-'));
  const destination = path.join(temp, 'cache.json');
  const controller = new AbortController(), api = apiFixture();
  try {
    await fs.writeFile(destination, 'existing cache');
    const fetch = async (url, request) => {
      const reply = await api.fetch(url, request);
      if (JSON.parse(request.body).query.includes('CarryCoachMatches')) {
        const originalText = reply.text;
        reply.text = async () => { const value = await originalText(); controller.abort(); return value; };
      }
      return reply;
    };
    await assert.rejects(refreshStratz({ token: TOKEN, fetch, destination, now: NOW, catalog, abilityCatalog, signal: controller.signal }), { name: 'AbortError' });
    assert.equal(await fs.readFile(destination, 'utf8'), 'existing cache');
    assert.deepEqual(await fs.readdir(temp), ['cache.json']);
  } finally { await fs.rm(destination, { force: true }); await fs.rmdir(temp); }
});

test('cancelling during the temporary disk write prevents atomic rename and cleans the temporary file', async () => {
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), 'carry-stratz-'));
  const destination = path.join(temp, 'cache.json');
  const controller = new AbortController();
  const originalWrite = fs.writeFile;
  try {
    await originalWrite(destination, 'existing cache');
    fs.writeFile = async (...args) => {
      await originalWrite(...args);
      if (typeof args[0] === 'string' && args[0].startsWith(`${destination}.`) && args[0].endsWith('.tmp')) controller.abort();
    };
    await assert.rejects(writeAtomic(destination, { new: 'data' }, { signal: controller.signal }), { name: 'AbortError' });
    assert.equal(await fs.readFile(destination, 'utf8'), 'existing cache');
    assert.deepEqual(await fs.readdir(temp), ['cache.json']);
  } finally { fs.writeFile = originalWrite; await fs.rm(destination, { force: true }); await fs.rmdir(temp); }
});

test('secrets and arbitrary API error messages cannot leak through public errors', async () => {
  const network = createClient({ token: TOKEN, fetch: async () => { throw new Error(`Authorization Bearer ${TOKEN}`); } });
  await assert.rejects(network.graphql('{ __typename }'), error => error.code === 'NETWORK' && !error.message.includes(TOKEN));
  const graphql = createClient({ token: TOKEN, fetch: async () => ({ ok: true, text: async () => JSON.stringify({ errors: [{ message: TOKEN }] }) }) });
  await assert.rejects(graphql.graphql('{ __typename }'), error => error.code === 'GRAPHQL_ERROR' && !error.message.includes(TOKEN));
  const malformed = createClient({ token: TOKEN, fetch: async () => ({ ok: true, text: async () => 'null' }) });
  await assert.rejects(malformed.graphql('{ __typename }'), { code: 'INVALID_RESPONSE' });
});

test('API rate limits and refresh call limit fail without automatic retries', async () => {
  let calls = 0;
  const rate = createClient({ token: TOKEN, fetch: async () => { calls++; return { ok: false, status: 429 }; } });
  await assert.rejects(rate.graphql('{ __typename }'), { code: 'RATE_LIMIT' });
  assert.equal(calls, 1);
  const bounded = createClient({ token: TOKEN, maxCalls: 1, fetch: async () => response({ __typename: 'DotaQuery' }) });
  await bounded.graphql('{ __typename }');
  await assert.rejects(bounded.graphql('{ __typename }'), { code: 'REQUEST_LIMIT' });
});

test('testConnection verifies introspection and versions without saving data or returning a token', async () => {
  const api = apiFixture();
  const result = await testConnection({ token: TOKEN, fetch: api.fetch });
  assert.equal(result.connected, true);
  assert.equal(result.providerId, 'stratz');
  assert.equal(result.calls, 2);
  assert.equal(result.skillEventsAvailable, true);
  assert.doesNotMatch(JSON.stringify(result), new RegExp(TOKEN));
});
