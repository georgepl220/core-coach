'use strict';

// Optional offline preparation. The desktop service supplies its existing
// protected STRATZ credential in memory; this script never saves credentials.
const path = require('node:path');
const fs = require('node:fs');
const { refreshOpenDotaDraft, refreshOpenDotaPositionDraft, atomicWrite } = require('../src/draft-sources.cjs');
const { refreshStratzDraft } = require('../src/stratz-draft.cjs');
async function refreshDraft(options = {}) {
  const catalogFile = path.resolve(__dirname, '..', 'data', 'wraith-king.json');
  const heroIds = options.heroIds || Object.values(JSON.parse(fs.readFileSync(catalogFile, 'utf8')).heroes).map(hero => hero.id);
  const request = { ...options, heroIds };
  const value = options.token ? await refreshStratzDraft(request) : await refreshOpenDotaDraft(request);
  if (!options.token && options.positions !== false) {
    const positions = await refreshOpenDotaPositionDraft(request);
    Object.defineProperty(value, 'positionDatasets', { value: positions, enumerable: false });
  }
  if (options.destination) {
    atomicWrite(options.destination, value);
    for (const row of value.positionDatasets || []) atomicWrite(path.join(path.dirname(options.destination), `draft-statistics-${row.providerId}-position-${row.scope.role.slice(-1)}.json`), row);
  }
  return value;
}
if (require.main === module) {
  refreshDraft({ destination: path.resolve(__dirname, '..', 'data', 'draft-statistics.json') })
    .then(value => process.stdout.write(JSON.stringify({ ok: true, providerId: value.providerId, updatedAt: value.updatedAt, heroes: value.heroes.map(hero => ({ heroId: hero.heroId, games: hero.games, matchups: hero.matchups.length, baselineAvailable: hero.baselineAvailable })) }) + '\n'))
    .catch(error => { process.stderr.write(['DraftSourceError', 'StratzError'].includes(error?.name) ? error.message + '\n' : 'Draft statistics update failed; previous cache preserved.\n'); process.exitCode = 1; });
}
module.exports = { refreshDraft };
