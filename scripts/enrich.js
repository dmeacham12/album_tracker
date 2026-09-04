// Runs in GitHub Actions (see .github/workflows/enrich.yml) to keep data/enriched.json
// up to date. Visitors' browsers load that JSON directly instead of calling MusicBrainz/
// Last.fm/iTunes themselves — this script pays the (rate-limited) API cost once, on a
// schedule, instead of once per visitor.
//
// Already-cached albums are skipped entirely, so a normal run only has to enrich
// whatever's new since the last run — safe and fast to run daily.

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_PATH = path.join(__dirname, '..', 'data', 'enriched.json');
const SHEET_URL = 'https://docs.google.com/spreadsheets/d/e/2PACX-1vSp3fA94KoiKePOhU1f_44EWyqzWDuQmZRmaVb2KOtMLxQn0S3cLl6MzMZeInyIVMcO1MzNO1c9i-uO/pub?output=csv';
const LASTFM_KEY = 'b25b959554ed76058ac220b7b2e0a026';

// MusicBrainz asks contributors to identify themselves with a descriptive User-Agent —
// personalize this with your repo URL or an email so MusicBrainz can reach you if this
// script ever needs throttling back further.
const MB_USER_AGENT = 'AlbumTrackerEnrichScript/1.0 ( https://github.com/YOUR-USERNAME/YOUR-REPO )';

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

// MusicBrainz is the trusted source for original release date and genre.
async function fetchFromMusicBrainz(artist, title) {
  const result = { releaseYear: null, genre: null };
  try {
    const q = `releasegroup:"${title.replace(/"/g, '')}" AND artist:"${artist.replace(/"/g, '')}"`;
    const res = await mbFetch(`https://musicbrainz.org/ws/2/release-group/?query=${encodeURIComponent(q)}&fmt=json&limit=1`);
    if (res.ok) {
      const data = await res.json();
      const rg = data['release-groups'] && data['release-groups'][0];
      if (rg && rg.score >= 90) {
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

// Last.fm: art, plus release year / genre as a fallback only. Its tags are unmoderated
// folksonomy, so obvious non-genre tags (bare years, decades, formats) are filtered out.
const LASTFM_SKIP_TAGS = new Set(['seen live', 'albums i own', 'spotify', 'favourite albums', 'love', 'vinyl', 'cd', 'compilation', 'soundtrack']);
async function fetchFromLastfm(artist, title) {
  const result = { art: null, releaseYear: null, genre: null };
  try {
    const url = `https://ws.audioscrobbler.com/2.0/?method=album.getinfo&api_key=${LASTFM_KEY}&artist=${encodeURIComponent(artist)}&album=${encodeURIComponent(title)}&format=json`;
    const res = await fetch(url);
    if (res.ok) {
      const data = await res.json();
      if (data.album) {
        const images = data.album.image || [];
        const mega = images.find(i => i.size === 'mega') || images.find(i => i.size === 'extralarge') || images[images.length - 1];
        const imgUrl = mega && mega['#text'];
        if (imgUrl) result.art = imgUrl;

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
    }
  } catch (e) { console.warn('Last.fm failed for', artist, '-', title, e.message); }
  return result;
}

async function fetchFromItunes(artist, title) {
  const result = { art: null, releaseYear: null };
  try {
    const q = encodeURIComponent(artist + ' ' + title);
    const res = await fetch(`https://itunes.apple.com/search?term=${q}&media=music&entity=album&limit=3`);
    if (res.ok) {
      const data = await res.json();
      const hit = data.results && data.results[0];
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
  let added = 0;

  for (const row of rows) {
    const artist = row['artist'] || '';
    const title = row['album title'] || row['album'] || '';
    if (!title) continue;

    const key = albumKey(title, artist);
    if (cache[key]) continue; // already enriched — this is what keeps repeat runs fast

    console.log('Enriching:', key);
    cache[key] = await enrichOne(artist, title);
    added++;
  }

  await fs.mkdir(path.dirname(CACHE_PATH), { recursive: true });
  await fs.writeFile(CACHE_PATH, JSON.stringify(cache, null, 2) + '\n');
  console.log(`Done. ${added} new album(s) enriched, ${Object.keys(cache).length} total in cache.`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
