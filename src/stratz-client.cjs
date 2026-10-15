'use strict';

// No website scraping and no bundled credentials. Every data field and argument
// below is checked against the authenticated API's current introspection schema.
const ENDPOINT = 'https://api.stratz.com/graphql';
const API_PAGE = 'https://stratz.com/api';
const MAX_RESPONSE_BYTES = 12 * 1024 * 1024;
const TYPE_REF = 'kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name ofType { kind name } } } } }';
const INTROSPECTION_QUERY = `query CarryCoachSchema { __schema { queryType { name } types { kind name description fields(includeDeprecated:true) { name description args { name defaultValue type { ${TYPE_REF} } } type { ${TYPE_REF} } } inputFields { name defaultValue type { ${TYPE_REF} } } enumValues(includeDeprecated:true) { name } } } }`;

class StratzError extends Error {
  constructor(code, message, status = null) { super(message); this.name = 'StratzError'; this.code = code; this.status = status; }
}
const schemaError = detail => new StratzError('SCHEMA_UNSUPPORTED', `STRATZ: несовместимая схема API (${detail}); сохранён предыдущий кеш.`);
function tokenValue(value) {
  if (typeof value !== 'string' || !value.trim()) throw new StratzError('TOKEN_REQUIRED', 'Для STRATZ нужен личный API-токен с stratz.com/api.');
  const token = value.trim().replace(/^Bearer\s+/i, '');
  if (token.length < 8 || token.length > 8192 || /[\s\x00-\x1f\x7f]/.test(token)) throw new StratzError('TOKEN_INVALID', 'Некорректный формат токена STRATZ.');
  return token;
}
function createClient(options = {}) {
  const token = tokenValue(options.token);
  const request = options.fetch || fetch;
  let calls = 0;
  const maximum = Math.min(12, Math.max(1, options.maxCalls || 8));
  const graphql = async (query, variables = {}) => {
    if (++calls > maximum) throw new StratzError('REQUEST_LIMIT', 'STRATZ: достигнут лимит запросов обновления; сохранён предыдущий кеш.');
    let response;
    try {
      response = await request(ENDPOINT, {
        method: 'POST', signal: options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(Math.min(30000, options.timeoutMs || 20000))]) : AbortSignal.timeout(Math.min(30000, options.timeoutMs || 20000)),
        headers: { 'Content-Type': 'application/json', 'User-Agent': 'STRATZ_API', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ query, variables }), redirect: 'error',
      });
    } catch {
      // Fetch exceptions may contain request headers. Do not forward them.
      throw new StratzError('NETWORK', 'STRATZ: запрос не завершён; проверь соединение. Предыдущий кеш сохранён.');
    }
    if (!response.ok) {
      const status = Number(response.status);
      const code = [401, 403].includes(status) ? 'AUTH_FAILED' : status === 429 ? 'RATE_LIMIT' : 'HTTP_ERROR';
      const reason = code === 'AUTH_FAILED' ? 'доступ отклонён; проверь токен и доступ API' : code === 'RATE_LIMIT' ? 'лимит API; повтори обновление позже' : 'ошибка HTTP';
      throw new StratzError(code, `STRATZ: ${reason} (${status}); предыдущий кеш сохранён.`, status);
    }
    const length = Number(response.headers?.get?.('content-length'));
    if (length > MAX_RESPONSE_BYTES) throw new StratzError('RESPONSE_TOO_LARGE', 'STRATZ: слишком большой ответ API.');
    let payload;
    try {
      if (typeof response.text === 'function') {
        const raw = await response.text();
        if (Buffer.byteLength(raw) > MAX_RESPONSE_BYTES) throw new Error('size');
        payload = JSON.parse(raw);
      } else { payload = await response.json(); }
    } catch { throw new StratzError('INVALID_RESPONSE', 'STRATZ: некорректный ответ API; предыдущий кеш сохранён.'); }
    if (Array.isArray(payload?.errors) && payload.errors.length) throw new StratzError('GRAPHQL_ERROR', 'STRATZ отклонил запрос GraphQL; схема или доступ API изменились. Предыдущий кеш сохранён.');
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) || !payload.data || typeof payload.data !== 'object') throw new StratzError('INVALID_RESPONSE', 'STRATZ: в ответе API нет данных; предыдущий кеш сохранён.');
    return payload.data;
  };
  return { graphql, introspect: async () => schemaContract((await graphql(INTROSPECTION_QUERY)).__schema), get calls() { return calls; } };
}

function unwrapped(ref) { while (ref?.ofType) ref = ref.ofType; return ref; }
function typeText(ref) {
  if (!ref) throw schemaError('нет типа аргумента');
  if (ref.kind === 'NON_NULL') return `${typeText(ref.ofType)}!`;
  if (ref.kind === 'LIST') return `[${typeText(ref.ofType)}]`;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ref.name || '')) throw schemaError('некорректное имя типа');
  return ref.name;
}
function schemaContract(schema) {
  if (!schema?.queryType?.name || !Array.isArray(schema.types)) throw schemaError('introspection недоступна');
  const types = new Map(schema.types.map(type => [type.name, type]));
  const field = (type, names, required = true) => {
    const owner = typeof type === 'string' ? types.get(type) : type;
    const result = (owner?.fields || []).find(value => names.includes(value.name));
    if (!result && required) throw schemaError(`${owner?.name || type}.${names[0]}`);
    return result;
  };
  const child = entry => types.get(unwrapped(entry?.type)?.name);
  const scalar = (type, names, required = true) => {
    const entry = field(type, names, required);
    if (entry && !['SCALAR', 'ENUM'].includes(unwrapped(entry.type)?.kind)) throw schemaError(`ожидалось скалярное поле ${entry.name}`);
    return entry;
  };
  const arg = (entry, name, required = true) => {
    const result = entry?.args?.find(value => value.name === name);
    if (!result && required) throw schemaError(`${entry?.name}(${name})`);
    return result;
  };
  const root = types.get(schema.queryType.name);
  const constants = field(root, ['constants']);
  const versions = field(child(constants), ['gameVersions']);
  const versionType = child(versions);
  const versionFields = ['id', 'name', 'asOfDateTime'].map(name => scalar(versionType, [name]));
  const stats = field(root, ['heroStats']);
  const guide = field(child(stats), ['guide']);
  const heroArg = arg(guide, 'heroId'), positionArg = arg(guide, 'positionId');
  const enumType = types.get(unwrapped(positionArg.type)?.name);
  if (enumType?.kind !== 'ENUM' || !enumType.enumValues?.some(value => value.name === 'POSITION_1')) throw schemaError('позиция POSITION_1 не подтверждена');
  const guideList = child(guide);
  const guides = field(guideList, ['guides'], false);
  const candidateType = guides ? child(guides) : guideList;
  const candidateId = scalar(candidateType, ['matchId']);
  const match = field(root, ['match']);
  const matchIdArg = arg(match, 'id');
  const matchType = child(match);
  const matchFields = Object.fromEntries(['id', 'startDateTime', 'durationSeconds', 'gameVersionId'].map(name => [name, scalar(matchType, [name])]));
  const winner = scalar(matchType, ['didRadiantWin'], false);
  const players = field(matchType, ['players']);
  const playerType = child(players);
  const playerFields = Object.fromEntries(['heroId', 'position', 'variant'].map(name => [name, scalar(playerType, [name])]));
  const playerPositionType = types.get(unwrapped(playerFields.position.type)?.name);
  if (!playerPositionType?.enumValues?.some(value => value.name === 'POSITION_1')) throw schemaError('позиция игрока не подтверждена');
  for (const name of ['isRadiant', 'isVictory']) { const entry = scalar(playerType, [name], false); if (entry) playerFields[name] = entry; }
  const playerStats = field(playerType, ['stats']);
  const purchases = field(child(playerStats), ['itemPurchases']);
  const purchaseFields = ['time', 'itemId'].map(name => scalar(child(purchases), [name]));
  const playback = field(playerType, ['playbackData'], false);
  const learns = playback ? field(child(playback), ['abilityLearnEvents'], false) : null;
  const learnFields = learns ? ['time', 'abilityId'].map(name => scalar(child(learns), [name])) : [];
  const obtained = learns ? scalar(child(learns), ['levelObtained'], false) : null;
  // API schemas do not consistently document whether "level" is hero level or
  // skill rank. Only an explicit description permits the recorded-level claim.
  const heroLevelField = obtained && /(?:hero|player)[\s\S]{0,50}level|level[\s\S]{0,50}(?:hero|player)/i.test(obtained.description || '') ? obtained : null;
  if (heroLevelField) learnFields.push(heroLevelField);
  const plural = field(root, ['matches'], false);
  const pluralIds = plural ? arg(plural, 'ids', false) : null;
  return { types, root, field, arg, constants, versions, versionFields, stats, guide, guides, candidateId, heroArg, positionArg, match, matchIdArg, plural, pluralIds, matchFields, winner, players, playerFields, playerStats, purchases, purchaseFields, playback, learns, learnFields, heroLevelField };
}

function queryParts() {
  const defs = [], variables = {};
  return {
    variable(name, argument, value) { defs.push(`$${name}:${typeText(argument.type)}`); variables[name] = value; return `$${name}`; },
    finish(name, selection) { return { query: `query ${name}${defs.length ? `(${defs.join(',')})` : ''} { ${selection} }`, variables }; },
  };
}
function argsText(entry, provided) {
  for (const argument of entry?.args || []) {
    if (argument.type?.kind === 'NON_NULL' && argument.defaultValue == null && !Object.hasOwn(provided, argument.name)) throw schemaError(`обязательный ${entry.name}(${argument.name})`);
  }
  const values = Object.entries(provided).map(([name, value]) => `${name}:${value}`);
  return values.length ? `(${values.join(',')})` : '';
}
function buildVersionQuery(contract) {
  return { query: `query CarryCoachVersions { ${contract.constants.name}${argsText(contract.constants, {})} { versions:${contract.versions.name}${argsText(contract.versions, {})} { ${contract.versionFields.map(value => value.name).join(' ')} } } }`, variables: {} };
}
function buildGuideQuery(contract, take = 60, options = {}) {
  take = Math.min(60, Math.max(1, Math.floor(take)));
  const query = queryParts();
  const hero = require('./provider-hero.cjs').providerHero(options);
  const args = { heroId: query.variable('hero', contract.heroArg, hero.id), positionId: query.variable('position', contract.positionArg, 'POSITION_1') };
  const takeArg = contract.arg(contract.guide, 'take', false);
  if (takeArg) args.take = query.variable('take', takeArg, take);
  let selection = contract.candidateId.name;
  if (contract.guides) {
    const inner = {};
    const innerTake = contract.arg(contract.guides, 'take', false);
    if (innerTake) inner.take = query.variable('nestedTake', innerTake, take);
    selection = `guides:${contract.guides.name}${argsText(contract.guides, inner)} { ${selection} }`;
  }
  return query.finish('CarryCoachGuides', `${contract.stats.name}${argsText(contract.stats, {})} { candidates:${contract.guide.name}${argsText(contract.guide, args)} { ${selection} } }`);
}
function matchSelection(contract) {
  const stats = `${contract.playerStats.name}${argsText(contract.playerStats, {})} { purchases:${contract.purchases.name}${argsText(contract.purchases, {})} { ${contract.purchaseFields.map(value => value.name).join(' ')} } }`;
  const skills = contract.learns ? ` ${contract.playback.name}${argsText(contract.playback, {})} { learns:${contract.learns.name}${argsText(contract.learns, {})} { ${contract.learnFields.map(value => value.name).join(' ')} } }` : '';
  return `${Object.values(contract.matchFields).map(value => value.name).join(' ')}${contract.winner ? ` ${contract.winner.name}` : ''} ${contract.players.name}${argsText(contract.players, {})} { ${Object.values(contract.playerFields).map(value => value.name).join(' ')} ${stats}${skills} }`;
}
function buildMatchQuery(contract, ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 20 || ids.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new StratzError('INVALID_IDS', 'Некорректная партия ID матчей STRATZ.');
  const query = queryParts(), selection = matchSelection(contract);
  if (contract.pluralIds && unwrapped(contract.plural.type)?.name === unwrapped(contract.match.type)?.name) {
    const idsArg = query.variable('ids', contract.pluralIds, ids);
    return query.finish('CarryCoachMatches', `records:${contract.plural.name}${argsText(contract.plural, { ids: idsArg })} { ${selection} }`);
  }
  return query.finish('CarryCoachMatches', ids.map((id, index) => `m${index}:${contract.match.name}${argsText(contract.match, { id: query.variable(`id${index}`, contract.matchIdArg, id) })} { ${selection} }`).join(' '));
}
function candidateIds(payload) {
  const groups = payload?.heroStats?.candidates;
  if (!Array.isArray(groups)) throw new StratzError('INVALID_RESPONSE', 'STRATZ: ожидается список guides.');
  return [...new Set(groups.flatMap(group => Array.isArray(group?.guides) ? group.guides : [group]).map(value => value?.matchId).filter(id => Number.isSafeInteger(id) && id > 0))].slice(0, 60);
}
function matchRecords(payload) { return Array.isArray(payload?.records) ? payload.records : Object.entries(payload || {}).filter(([key]) => /^m\d+$/.test(key)).map(([, value]) => value).filter(Boolean); }
async function testConnection(options = {}) {
  const client = createClient(options), contract = await client.introspect();
  const request = buildVersionQuery(contract), data = await client.graphql(request.query, request.variables);
  const versions = data[contract.constants.name]?.versions;
  if (!Array.isArray(versions) || !versions.some(version => Number.isInteger(version.id) && typeof version.name === 'string')) throw new StratzError('INVALID_RESPONSE', 'STRATZ: не получены версии игры.');
  return { connected: true, providerId: 'stratz', endpoint: ENDPOINT, schemaVerified: true, calls: client.calls, versions: versions.filter(version => Number.isInteger(version.id) && typeof version.name === 'string'), skillEventsAvailable: Boolean(contract.learns), recordedHeroLevelsAvailable: Boolean(contract.heroLevelField) };
}

module.exports = { ENDPOINT, API_PAGE, INTROSPECTION_QUERY, MAX_RESPONSE_BYTES, StratzError, tokenValue, createClient, schemaContract, typeText, buildVersionQuery, buildGuideQuery, buildMatchQuery, candidateIds, matchRecords, testConnection };
