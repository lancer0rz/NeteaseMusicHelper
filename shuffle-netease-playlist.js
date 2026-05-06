#!/usr/bin/env node
'use strict';

/**
 * Randomly shuffle song order in a NetEase Cloud Music playlist.
 */

const fs = require('fs/promises');
const readline = require('readline/promises');
const { stdin: input, stdout: output } = require('process');
const path = require('path');
const qrcode = require('qrcode-terminal');
const defaultApi = require('NeteaseCloudMusicApi');

const COOKIE_FILE = path.join(process.cwd(), '.netease-cookie.json');
const LOGIN_POLL_INTERVAL_MS = 2000;
const LOGIN_TIMEOUT_MS = 180000;

function parseArgs(argv) {
  const args = {
    dryRun: false,
    forceLogin: false,
    list: false,
    limit: 100000,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--playlist' || arg === '-p') {
      args.playlist = argv[++i];
    } else if (arg === '--cookie-file') {
      args.cookieFile = argv[++i];
    } else if (arg === '--dry-run') {
      args.dryRun = true;
    } else if (arg === '--force-login') {
      args.forceLogin = true;
    } else if (arg === '--list') {
      args.list = true;
    } else if (arg === '--limit') {
      args.limit = Number(argv[++i]);
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (!arg.startsWith('-') && !args.playlist) {
      args.playlist = arg;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!Number.isFinite(args.limit) || args.limit < 1) {
    throw new Error('--limit must be a positive number');
  }

  return args;
}

function printHelp() {
  console.log(`Usage:
  node shuffle-netease-playlist.js [--playlist <playlist-id-or-url>] [options]

Options:
  -p, --playlist <id|url>   NetEase Cloud Music playlist id or URL
      --dry-run            Show the shuffled result but do not submit changes
      --force-login        Ignore cached cookie and scan QR code again
      --list               List my editable playlists and exit
      --cookie-file <path> Cookie cache file, default: ./.netease-cookie.json
      --limit <n>          Max tracks to read, default: 100000
  -h, --help               Show this help

Examples:
  node shuffle-netease-playlist.js
  node shuffle-netease-playlist.js --list
  node shuffle-netease-playlist.js -p 123456789
  node shuffle-netease-playlist.js -p 'https://music.163.com/playlist?id=123456789' --dry-run
`);
}

function extractPlaylistId(inputText) {
  if (!inputText) return null;
  const text = String(inputText).trim();

  if (/^\d+$/.test(text)) return text;

  try {
    const url = new URL(text.replace(/^http:\/\//, 'https://'));
    const id = url.searchParams.get('id');
    if (id && /^\d+$/.test(id)) return id;
  } catch (_) {
    // Fall through to regex extraction.
  }

  const match = text.match(/[?&]id=(\d+)/) || text.match(/playlist\D+(\d+)/i);
  return match ? match[1] : null;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function toCookieString(cookie) {
  if (!cookie) return '';
  if (Array.isArray(cookie)) return cookie.join('; ');
  return String(cookie);
}

async function loadCookie(cookieFile) {
  try {
    const raw = await fs.readFile(cookieFile, 'utf8');
    const data = JSON.parse(raw);
    return data.cookie || '';
  } catch (_) {
    return '';
  }
}

async function saveCookie(cookieFile, cookie) {
  await fs.writeFile(
    cookieFile,
    JSON.stringify({ cookie, savedAt: new Date().toISOString() }, null, 2),
    'utf8',
  );
}

async function getLoginAccount(api, cookie) {
  if (!cookie) return null;
  try {
    const res = await api.login_status({ cookie, timestamp: Date.now() });
    return res.body && res.body.data && res.body.data.account ? res.body.data.account : null;
  } catch (_) {
    return null;
  }
}

async function loginByQr(api, cookieFile, options = {}) {
  const keyRes = await api.login_qr_key({ timestamp: Date.now() });
  const key = keyRes.body && keyRes.body.data && keyRes.body.data.unikey;
  if (!key) {
    throw new Error(`Failed to get QR login key: ${JSON.stringify(keyRes.body)}`);
  }

  const qrRes = await api.login_qr_create({ key, qrimg: false, timestamp: Date.now() });
  const qrurl = qrRes.body && qrRes.body.data && qrRes.body.data.qrurl;
  if (!qrurl) {
    throw new Error(`Failed to create QR code: ${JSON.stringify(qrRes.body)}`);
  }

  console.log('请用网易云音乐 App 扫描下面的二维码登录：');
  qrcode.generate(qrurl, { small: true });

  const pollIntervalMs = options.pollIntervalMs || LOGIN_POLL_INTERVAL_MS;
  const timeoutMs = options.timeoutMs || LOGIN_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);
    const checkRes = await api.login_qr_check({ key, timestamp: Date.now() });
    const body = checkRes.body || {};

    if (body.code === 803) {
      const cookie = body.cookie || toCookieString(checkRes.cookie);
      if (!cookie) throw new Error('登录成功，但没有拿到 cookie。');
      await saveCookie(cookieFile, cookie);
      console.log('登录成功，cookie 已保存。');
      return cookie;
    }

    if (body.code === 802) {
      process.stdout.write('已扫码，请在手机上确认登录...\n');
    } else if (body.code === 801) {
      process.stdout.write('等待扫码...\n');
    } else if (body.code === 800) {
      throw new Error('二维码已过期，请重新运行脚本。');
    } else {
      process.stdout.write(`登录状态：${JSON.stringify(body)}\n`);
    }
  }

  throw new Error('登录超时，请重新运行脚本。');
}

async function getEditablePlaylists(api, userId, cookie) {
  const res = await api.user_playlist({
    uid: userId,
    limit: 1000,
    offset: 0,
    cookie,
    timestamp: Date.now(),
  });

  if (!res.body || res.body.code !== 200 || !Array.isArray(res.body.playlist)) {
    throw new Error(`Failed to fetch user playlists: ${JSON.stringify(res.body)}`);
  }

  return res.body.playlist
    .filter((playlist) => !playlist.subscribed)
    .map((playlist) => ({
      id: String(playlist.id),
      name: playlist.name || '',
      trackCount: playlist.trackCount || 0,
    }));
}

function printPlaylists(playlists) {
  console.log('\n你的可编辑歌单：');
  playlists.forEach((playlist, index) => {
    console.log(
      `${String(index + 1).padStart(2, ' ')}. ${playlist.name} (${playlist.trackCount} 首, id: ${playlist.id})`,
    );
  });
}

async function selectPlaylistInteractively(playlists, deps = {}) {
  if (playlists.length === 0) {
    throw new Error('没有找到可编辑歌单。');
  }

  printPlaylists(playlists);

  if (deps.selectPlaylist) {
    const selected = await deps.selectPlaylist(playlists);
    const playlist = typeof selected === 'number' ? playlists[selected - 1] : selected;
    if (!playlist || !playlist.id) {
      throw new Error('选择的歌单无效。');
    }
    return playlist;
  }

  const rl = readline.createInterface({ input, output });
  try {
    while (true) {
      const answer = await rl.question('\n请输入要打乱的歌单序号，或输入 q 退出：');
      const trimmed = answer.trim().toLowerCase();
      if (trimmed === 'q' || trimmed === 'quit' || trimmed === 'exit') {
        throw new Error('已取消。');
      }

      const index = Number(trimmed);
      if (Number.isInteger(index) && index >= 1 && index <= playlists.length) {
        return playlists[index - 1];
      }

      console.log(`请输入 1-${playlists.length} 之间的数字。`);
    }
  } finally {
    rl.close();
  }
}

function shuffleInPlace(array, random = Math.random) {
  for (let i = array.length - 1; i > 0; i -= 1) {
    const j = Math.floor(random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function sameOrder(a, b) {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

async function getPlaylistTrackIds(api, playlistId, cookie) {
  const res = await api.playlist_detail({
    id: playlistId,
    cookie,
    timestamp: Date.now(),
  });

  if (!res.body || res.body.code !== 200 || !res.body.playlist || !Array.isArray(res.body.playlist.trackIds)) {
    throw new Error(`Failed to fetch playlist detail: ${JSON.stringify(res.body).slice(0, 500)}`);
  }

  return res.body.playlist.trackIds.map((track) => String(track.id));
}

function normalizeSong(song) {
  return {
    id: String(song.id),
    name: song.name || '',
    artists: Array.isArray(song.ar) ? song.ar.map((artist) => artist.name).join('/') : '',
  };
}

async function getSongDetails(api, ids, cookie, batchSize = 500) {
  const songs = [];
  for (let offset = 0; offset < ids.length; offset += batchSize) {
    const batch = ids.slice(offset, offset + batchSize);
    const res = await api.song_detail({
      ids: batch.join(','),
      cookie,
      timestamp: Date.now(),
    });

    if (!res.body || res.body.code !== 200 || !Array.isArray(res.body.songs)) {
      throw new Error(`Failed to fetch song details: ${JSON.stringify(res.body).slice(0, 500)}`);
    }

    songs.push(...res.body.songs.map(normalizeSong));
  }
  return songs;
}

async function getPlaylistTracks(api, playlistId, cookie, limit) {
  const trackIds = await getPlaylistTrackIds(api, playlistId, cookie);
  const limitedIds = trackIds.slice(0, limit);

  if (limitedIds.length === 0) return [];

  try {
    const details = await getSongDetails(api, limitedIds, cookie);
    const byId = new Map(details.map((song) => [song.id, song]));
    return limitedIds.map((id) => byId.get(id) || { id, name: `歌曲 ${id}`, artists: '' });
  } catch (error) {
    console.warn(`歌曲详情获取失败，将只使用歌曲 ID 继续执行：${error.message}`);
    return limitedIds.map((id) => ({ id, name: `歌曲 ${id}`, artists: '' }));
  }
}

async function updatePlaylistOrder(api, playlistId, ids, cookie) {
  const res = await api.song_order_update({
    pid: playlistId,
    ids: JSON.stringify(ids.map((id) => Number(id))),
    cookie,
    timestamp: Date.now(),
  });

  if (!res.body || res.body.code !== 200) {
    throw new Error(`Failed to update playlist song order: ${JSON.stringify(res.body)}`);
  }
  return res.body;
}

function preview(title, tracks) {
  console.log(`\n${title}`);
  tracks.slice(0, 10).forEach((track, index) => {
    const suffix = track.artists ? ` - ${track.artists}` : '';
    console.log(`${String(index + 1).padStart(2, ' ')}. ${track.name}${suffix} (${track.id})`);
  });
  if (tracks.length > 10) console.log(`... 另有 ${tracks.length - 10} 首`);
}

async function run(argv, deps = {}) {
  const api = deps.api || defaultApi;
  const args = parseArgs(argv);

  if (args.help) {
    printHelp();
    return { changed: false, reason: 'help' };
  }

  const cookieFile = path.resolve(args.cookieFile || COOKIE_FILE);
  let cookie = args.forceLogin ? '' : await loadCookie(cookieFile);
  let account = await getLoginAccount(api, cookie);

  if (!account) {
    cookie = await loginByQr(api, cookieFile, deps.loginOptions);
    account = await getLoginAccount(api, cookie);
  } else {
    console.log(`已使用缓存登录态：${cookieFile}`);
  }

  if (!account || !account.id) {
    throw new Error('登录成功，但无法获取当前账号 ID。');
  }

  let playlistId = extractPlaylistId(args.playlist);
  if (!playlistId || args.list) {
    const playlists = await getEditablePlaylists(api, account.id, cookie);
    if (args.list) {
      printPlaylists(playlists);
      return { changed: false, reason: 'list', playlistCount: playlists.length };
    }

    const selected = await selectPlaylistInteractively(playlists, deps);
    playlistId = selected.id;
    console.log(`\n已选择歌单：${selected.name} (${playlistId})`);
  }

  const tracks = await getPlaylistTracks(api, playlistId, cookie, args.limit);
  if (tracks.length < 2) {
    console.log(`歌单只有 ${tracks.length} 首歌，无需打乱。`);
    return { changed: false, reason: 'too-few-tracks', playlistId, trackCount: tracks.length };
  }

  const shuffled = shuffleInPlace([...tracks], deps.random || Math.random);
  if (sameOrder(tracks.map((track) => track.id), shuffled.map((track) => track.id))) {
    [shuffled[0], shuffled[1]] = [shuffled[1], shuffled[0]];
  }

  preview('当前前 10 首：', tracks);
  preview('打乱后前 10 首：', shuffled);

  if (args.dryRun) {
    console.log('\n--dry-run 已启用，未修改歌单。');
    return { changed: false, reason: 'dry-run', playlistId, trackCount: shuffled.length };
  }

  await updatePlaylistOrder(api, playlistId, shuffled.map((track) => track.id), cookie);
  console.log(`\n完成：已随机打乱歌单 ${playlistId} 的 ${shuffled.length} 首歌曲顺序。`);
  return { changed: true, playlistId, trackCount: shuffled.length };
}

if (require.main === module) {
  run(process.argv.slice(2)).catch((error) => {
    console.error(`\n错误：${error.message}`);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  extractPlaylistId,
  getLoginAccount,
  getEditablePlaylists,
  getPlaylistTrackIds,
  getSongDetails,
  selectPlaylistInteractively,
  shuffleInPlace,
  sameOrder,
  getPlaylistTracks,
  updatePlaylistOrder,
  run,
};
