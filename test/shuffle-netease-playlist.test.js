'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const os = require('node:os');
const path = require('node:path');
const fs = require('node:fs/promises');

const {
  extractPlaylistId,
  parseArgs,
  shuffleInPlace,
  updatePlaylistOrder,
  run,
} = require('../shuffle-netease-playlist');

test('extractPlaylistId supports numeric id and music.163.com playlist url', () => {
  assert.equal(extractPlaylistId('123456789'), '123456789');
  assert.equal(
    extractPlaylistId('https://music.163.com/playlist?id=123456789&userid=42'),
    '123456789',
  );
  assert.equal(extractPlaylistId('https://music.163.com/#/playlist?id=987654321'), '987654321');
  assert.equal(extractPlaylistId('https://music.163.com/'), null);
});

test('parseArgs reads supported options', () => {
  assert.deepEqual(parseArgs(['-p', '123', '--dry-run', '--limit', '10']), {
    playlist: '123',
    dryRun: true,
    forceLogin: false,
    limit: 10,
  });
});

test('shuffleInPlace preserves elements', () => {
  const items = [1, 2, 3, 4, 5];
  const shuffled = shuffleInPlace([...items], () => 0);
  assert.deepEqual([...shuffled].sort(), items);
  assert.equal(shuffled.length, items.length);
});

test('updatePlaylistOrder submits JSON stringified numeric ids', async () => {
  let payload;
  const api = {
    playlist_order_update: async (query) => {
      payload = query;
      return { body: { code: 200 } };
    },
  };

  await updatePlaylistOrder(api, ['3', '2', '1'], 'MUSIC_U=abc');
  assert.equal(payload.ids, '[3,2,1]');
  assert.equal(payload.cookie, 'MUSIC_U=abc');
});

test('run dry-run fetches songs but does not update order', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'netease-shuffle-test-'));
  const cookieFile = path.join(tempDir, 'cookie.json');
  await fs.writeFile(cookieFile, JSON.stringify({ cookie: 'MUSIC_U=mock' }), 'utf8');

  let updateCalled = false;
  const api = {
    login_status: async () => ({ body: { data: { account: { id: 1 } } } }),
    playlist_track_all: async () => ({
      body: {
        code: 200,
        songs: [
          { id: 1, name: 'A', ar: [{ name: 'artistA' }] },
          { id: 2, name: 'B', ar: [{ name: 'artistB' }] },
          { id: 3, name: 'C', ar: [{ name: 'artistC' }] },
        ],
      },
    }),
    playlist_order_update: async () => {
      updateCalled = true;
      return { body: { code: 200 } };
    },
  };

  const result = await run(
    ['--playlist', 'https://music.163.com/playlist?id=123', '--dry-run', '--cookie-file', cookieFile],
    { api, random: () => 0 },
  );

  assert.equal(result.changed, false);
  assert.equal(result.reason, 'dry-run');
  assert.equal(updateCalled, false);
});

test('run submits shuffled order when not dry-run', async () => {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'netease-shuffle-test-'));
  const cookieFile = path.join(tempDir, 'cookie.json');
  await fs.writeFile(cookieFile, JSON.stringify({ cookie: 'MUSIC_U=mock' }), 'utf8');

  let submittedIds;
  const api = {
    login_status: async () => ({ body: { data: { account: { id: 1 } } } }),
    playlist_track_all: async () => ({
      body: {
        code: 200,
        songs: [
          { id: 1, name: 'A', ar: [] },
          { id: 2, name: 'B', ar: [] },
          { id: 3, name: 'C', ar: [] },
        ],
      },
    }),
    playlist_order_update: async (query) => {
      submittedIds = query.ids;
      return { body: { code: 200 } };
    },
  };

  const result = await run(['--playlist', '123', '--cookie-file', cookieFile], { api, random: () => 0 });

  assert.equal(result.changed, true);
  assert.equal(submittedIds, '[2,3,1]');
});
