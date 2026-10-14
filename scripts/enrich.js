// Runs in GitHub Actions (see .github/workflows/enrich.yml) to keep data/enriched.json
// up to date. Visitors' browsers load that JSON directly instead of calling MusicBrainz/
// Last.fm/iTunes themselves — this script pays the (rate-limited) API cost once, on a
// schedule, instead of once per visitor.
//
// Albums that already have cover art are skipped, so a normal run only has to enrich
// whatever's new. Albums whose art couldn't be found are retried on every run instead of
// being cached as "no art" forever.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = path.join(__dirname, '..', 'data', 'enriched.json');
const SHEET_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSp3fA94KoiKePOhU1f_44EWyqzWDuQmZRmaVb2KOtMLxQn0S3cLl6MzMZeInyIVMcO1MzNO1c9i-uO/pub?output=csv';
// The page uses this same key in every visitor's browser, so it often hits Last.fm's rate
// limit. To keep this script out of that, add your own Last.fm key as a repo secret named
// LASTFM_API_KEY (optional — without it the script falls back to the shared key, and to
// iTunes and Cover Art Archive when Last.fm is throttled).
const LASTFM_KEY = process.env.LASTFM_API_KEY || 'b25b959554ed76058ac220b7b2e0a026';
const LASTFM_PLACEHOLDER = '2a96cbd8b46e442fc41c2b86b821562f'; // Last.fm's grey "no image" star

const MB_USER_AGENT = 'AlbumTrackerEnrichScript/1.0 ( https://github.com/dmeacham12/album_tracker )';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function parseCSV(text) {
  const lines = text.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',').map(h => h.replace(/^"|"$/g, '').trim().toLowerCase());
  return lines.slice(1).map(line => {
    const vals = [];
    let cur = '', inQ = false;
    for (const c of line) {
      if (c === '"') inQ = !inQ;
      else if (c === ',' && !inQ) { vals.push(cur); cur = ''; }
      else cur += c;
    }
    vals.push(cur);
    const obj = {};
    headers.forEach((h, i) => { obj[h] = (vals[i] || '').replace(/^"|"$/g, '').trim(); });
    return obj;
  }).filter(r => r['album title'] || r['album']);
}

function albumKey(title, artist) {
  return title + '::' + artist;
}

// ── iTunes matching ──
// iTunes search is fuzzy and will happily return a single by a different artist, so a hit is
// only used when both the artist and the album title actually line up.
function normName(s) {
  return String(s || '').toLowerCase().replace(/&/g, 'and').replace(/\(.*?\)|\[.*?\]/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}
function squash(s) {
  return s.replace(/ /g, '');
}
function pickItunesHit(results, artist, title) {
  const a = squash(normName(artist)), t = squash(normName(title));
  if (!a || !t) return null;
  return (results || []).find(r => {
    if (/ - single$/i.test(r.collectionName || '')) return false;
    const ra = squash(normName(r.artistName)), rt = squash(normName(r.collectionName));
    const artistOk = ra === a || ra.includes(a) || a.includes(ra);
    const titleOk = rt === t || rt.startsWith(t) || t.startsWith(rt) || rt.includes(t);
    return artistOk && titleOk;
  }) || null;
}

// MusicBrainz calls are queued and spaced to respect its ~1 req/sec rate limit, with
// retry-with-backoff on 503 ("slow down") — this runs alone (not fanned out across many
// visitors), so it can stay close to the documented limit.
const MB_SPACING_MS = 1100;
let mbChain = Promise.resolve();
function mbFetchRaw(url) {
  const call = mbChain.then(() => fetch(url, { headers: { Accept: 'application/json', 'User-Agent': MB_USER_AGENT } }));
  mbChain = call.then(() => sleep(MB_SPACING_MS), () => sleep(MB_SPACING_MS));
  return call;
}
async function mbFetch(url, attempt = 0) {
  const res = await mbFetchRaw(url);
  if (res.status === 503 && attempt < 4) {
    await sleep(MB_SPACING_MS * (attempt + 1) * 2);
    return mbFetch(url, attempt + 1);
  }
  return res;
}

// MusicBrainz is the trusted source for original release date and genre. It also hands back
// the release-group id, which is how we find cover art on the Cover Art Archive as a last resort.
async function fetchFromMusicBrainz(artist, title) {
  const result = { releaseYear: null, genre: null, mbid: null };
  try {
    const q = `releasegroup:"${title.replace(/"/g, '')}" AND artist:"${artist.replace(/"/g, '')}"`;
    const res = await mbFetch(`https://musicbrainz.org/ws/2/release-group/?query=${encodeURIComponent(q)}&fmt=json&limit=1`);
    if (res.ok) {
      const data = await res.json();
      const rg = data['release-groups'] && data['release-groups'][0];
      if (rg && rg.score >= 90) {
        result.mbid = rg.id;
        if (rg['first-release-date']) {
          const yr = rg['first-release-date'].match(/^\d{4}/);
          if (yr) result.releaseYear = yr[0];
        }
        const res2 = await mbFetch(`https://musicbrainz.org/ws/2/release-group/${rg.id}?inc=genres&fmt=json`);
        if (res2.ok) {
          const detail = await res2.json();
          const genres = (detail.genres || []).slice().sort((a, b) => b.count - a.count);
          if (genres.length) result.genre = genres[0].name;
        }
      }
    }
  } catch (e) { console.warn('MusicBrainz failed for', artist, '-', title, e.message); }
  return result;
}

// Last.fm answers a throttled request with HTTP 200 and { error: 29 }, which looks like "album
// not found" if you only check res.ok. After a couple of throttled replies in one run we stop
// asking and let iTunes / Cover Art Archive cover the rest.
let lastfmThrottled = 0;
async function lastfmGet(url) {
  if (lastfmThrottled >= 3) return null;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      if (data.error === 29) { lastfmThrottled++; await sleep(2000 * (attempt + 1)); continue; }
      return data;
    }
    if (res.status === 429 || res.status >= 500) { lastfmThrottled++; await sleep(2000 * (attempt + 1)); continue; }
    return null;
  }
  return null;
}

// Last.fm: art, plus release year / genre as a fallback only. Its tags are unmoderated
// folksonomy, so obvious non-genre tags (bare years, decades, formats) are filtered out.
const LASTFM_SKIP_TAGS = new Set(['seen live', 'albums i own', 'spotify', 'favourite albums', 'love', 'vinyl', 'cd', 'compilation', 'soundtrack']);
async function fetchFromLastfm(artist, title) {
  const result = { art: null, releaseYear: null, genre: null };
  try {
    const url = `https://ws.audioscrobbler.com/2.0/?method=album.getinfo&api_key=${LASTFM_KEY}&artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(title)}&format=json`;
    const data = await lastfmGet(url);
    if (data && data.album) {
      const images = data.album.image || [];
      const mega = images.find(i => i.size === 'mega') || images.find(i => i.size === 'extralarge') || images[images.length - 1];
      const imgUrl = mega && mega['#text'];
      if (imgUrl && !imgUrl.includes(LASTFM_PLACEHOLDER)) result.art = imgUrl;

      if (data.album.wiki && data.album.wiki.published) {
        const yr = data.album.wiki.published.match(/(19|20)\d{2}/);
        if (yr) result.releaseYear = yr[0];
      }

      const tags = (data.album.tags && data.album.tags.tag) || [];
      const topTag = tags.find(t =>
        !LASTFM_SKIP_TAGS.has(t.name.toLowerCase()) &&
        !/^\d{2,4}s?$/i.test(t.name.trim()) // reject bare years ("2022") and decades ("80s")
      );
      if (topTag) result.genre = topTag.name;
    }
  } catch (e) { console.warn('Last.fm failed for', artist, '-', title, e.message); }
  return result;
}

async function fetchFromItunes(artist, title) {
  const result = { art: null, releaseYear: null };
  try {
    const q = encodeURIComponent(artist + ' ' + title);
    const res = await fetch(`https://itunes.apple.com/search?term=${q}&media=music&entity=album&limit=8`);
    if (res.ok) {
      const data = await res.json();
      const hit = pickItunesHit(data.results, artist, title);
      if (hit) {
        if (hit.artworkUrl100) result.art = hit.artworkUrl100.replace('100x100bb', '600x600bb');
        if (hit.releaseDate) {
          const yr = hit.releaseDate.match(/^\d{4}/);
          if (yr) result.releaseYear = yr[0];
        }
      }
    }
  } catch (e) { console.warn('iTunes failed for', artist, '-', title, e.message); }
  return result;
}

// Cover Art Archive: community-uploaded covers keyed by MusicBrainz id. Covers obscure and
// brand-new releases that Last.fm and iTunes don't have.
async function fetchFromCoverArchive(mbid) {
  if (!mbid) return null;
  const url = `https://coverartarchive.org/release-group/${mbid}/front-500`;
  try {
    const res = await fetch(url, { method: 'HEAD', redirect: 'follow' });
    return res.ok ? url : null;
  } catch {
    return null;
  }
}

async function enrichOne(artist, title) {
  const [mb, lastfm] = await Promise.all([
    fetchFromMusicBrainz(artist, title),
    fetchFromLastfm(artist, title)
  ]);
  const result = {
    art: lastfm.art,
    releaseYear: mb.releaseYear || lastfm.releaseYear,
    genre: mb.genre || lastfm.genre
  };
  if (!result.art || !result.releaseYear) {
    const itunes = await fetchFromItunes(artist, title);
    if (!result.art) result.art = itunes.art;
    if (!result.releaseYear) result.releaseYear = itunes.releaseYear;
  }
  if (!result.art) result.art = await fetchFromCoverArchive(mb.mbid);
  return result;
}

async function loadExistingCache() {
  try {
    return JSON.parse(await fs.readFile(CACHE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

async function main() {
  const res = await fetch(SHEET_URL);
  if (!res.ok) throw new Error('Failed to fetch sheet: HTTP ' + res.status);
  const rows = parseCSV(await res.text());

  const cache = await loadExistingCache();
  let added = 0, retried = 0;
  const stillNoArt = [];

  for (const row of rows) {
    const artist = row['artist'] || '';
    const title = row['album title'] || row['album'] || '';
    if (!title) continue;

    const key = albumKey(title, artist);
    const existing = cache[key];
    if (existing && existing.art) continue; // already has a cover — this is what keeps repeat runs fast

    console.log(existing ? 'Retrying (no art yet):' : 'Enriching:', key);
    const fresh = await enrichOne(artist, title);
    cache[key] = existing
      ? { art: fresh.art || existing.art || null, releaseYear: fresh.releaseYear || existing.releaseYear || null, genre: fresh.genre || existing.genre || null }
      : fresh;
    if (existing) retried++; else added++;
    if (!cache[key].art) stillNoArt.push(key);
  }

  await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await fs.writeFile(CACHE_PATH, JSON.stringify(cache, null, 2) + '\n');
  console.log(`Done. ${added} new album(s), ${retried} retried, ${Object.keys(cache).length} total in cache.`);
  if (stillNoArt.length) console.log('Still no cover art for:\n  ' + stillNoArt.join('\n  '));
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
