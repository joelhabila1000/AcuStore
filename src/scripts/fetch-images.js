'use strict';

// Populates product images by downloading freely-licensed photos into
// public/uploads and pointing each product's `image` column at the local file.
//
//   npm run images            # fills in products that have no image yet
//   npm run images -- --force # re-fetches images for every product
//
// Sources: Openverse (aggregated CC photos) with a Wikimedia Commons fallback.
// Attribution for everything downloaded is written to IMAGE-CREDITS.md.
//
// These are demo images. Replace them with your own product photography before
// you launch — see IMAGE-CREDITS.md for the licences of what was downloaded.

const fs = require('fs');
const path = require('path');
const db = require('../db');
const config = require('../config');

const USER_AGENT = 'acuStore-image-seeder/1.0 (product catalog placeholder images)';
const OPENVERSE = 'https://api.openverse.org/v1/images/';
const COMMONS = 'https://commons.wikimedia.org/w/api.php';
const REQUEST_DELAY_MS = 1800;

const force = process.argv.includes('--force');
const CREDITS_JSON = path.join(config.root, 'IMAGE-CREDITS.json');
const CREDITS_MD = path.join(config.root, 'IMAGE-CREDITS.md');

// Search terms that return good product-style photos for the sample catalog.
// Any product not listed falls back to its own name.
const KEYWORDS = {
  'stoneware-coffee-mug': 'ceramic coffee mug',
  'cast-iron-skillet-10': 'cast iron skillet',
  'linen-tea-towel-set': 'linen tea towel',
  'bamboo-cutting-board': 'wooden chopping board',
  'glass-storage-set': 'glass food storage containers',
  'wireless-earbuds': 'wireless earbuds headphones',
  'usb-c-fast-charger': 'usb power adapter charger',
  'braided-charging-cable': 'usb cable',
  'bluetooth-speaker': 'bluetooth speaker',
  'desk-power-strip': 'power strip surge protector',
  'organic-cotton-t-shirt': 'cotton t-shirt',
  'canvas-tote-bag': 'canvas tote bag',
  'merino-wool-socks': 'wool socks',
  'packable-rain-jacket': 'rain jacket',
  'hardcover-notebook': 'notebook journal',
  'gel-pen-set': 'gel pens stationery',
  'desk-planner-pad': 'desk planner notebook',
  'kraft-sticky-notes': 'sticky notes',
  'insulated-water-bottle': 'insulated water bottle',
  'compact-camp-lantern': 'camping lantern',
  'picnic-blanket': 'picnic blanket',
  'trail-daypack-20l': 'hiking backpack'
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getJson(url, attempt = 1) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  if (res.status === 429 || res.status >= 500) {
    if (attempt <= 3) {
      await sleep(1500 * attempt);
      return getJson(url, attempt + 1);
    }
    throw new Error(`HTTP ${res.status} for ${url}`);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return res.json();
}

async function searchOpenverse(query) {
  const url = new URL(OPENVERSE);
  url.searchParams.set('q', query);
  url.searchParams.set('license_type', 'commercial');
  url.searchParams.set('mature', 'false');
  url.searchParams.set('page_size', '20');
  url.searchParams.set('size', 'large');

  const results = await getJson(url.toString());
  const rows = (results.results || []).filter((r) => {
    if (!r.url || !r.thumbnail) return false;
    if (r.width < 600 || r.height < 600) return false;
    const ratio = r.width / r.height;
    return ratio >= 0.6 && ratio <= 1.7;
  });

  // Prefer the provider's pre-scaled image: originals are frequently 10MB+,
  // which would wreck page weight for a storefront that only displays ~600px.
  return rows.map((r) => ({
    imageUrl: r.thumbnail || r.url,
    fallbackUrl: r.url,
    title: r.title || '',
    creator: r.creator || '',
    license: `${(r.license || '').toUpperCase()}${r.license_version ? ` ${r.license_version}` : ''}`.trim(),
    source: r.foreign_landing_url || r.url,
    provider: 'Openverse'
  }));
}

async function searchCommons(query) {
  const url = new URL(COMMONS);
  url.searchParams.set('action', 'query');
  url.searchParams.set('format', 'json');
  url.searchParams.set('generator', 'search');
  url.searchParams.set('gsrsearch', `filetype:bitmap ${query}`);
  url.searchParams.set('gsrnamespace', '6');
  url.searchParams.set('gsrlimit', '8');
  url.searchParams.set('prop', 'imageinfo');
  url.searchParams.set('iiprop', 'url|mime|size|extmetadata');
  url.searchParams.set('iiurlwidth', '900');

  const json = await getJson(url.toString());
  const pages = json.query && json.query.pages ? Object.values(json.query.pages) : [];

  return pages
    .filter((page) => page.imageinfo && page.imageinfo[0])
    .map((page) => {
      const info = page.imageinfo[0];
      const meta = info.extmetadata || {};
      return {
        imageUrl: info.thumburl || info.url,
        fallbackUrl: info.url,
        title: page.title.replace(/^File:/, ''),
        creator: meta.Artist ? String(meta.Artist.value).replace(/<[^>]+>/g, '').trim() : '',
        license: meta.LicenseShortName ? meta.LicenseShortName.value : 'unknown',
        source: `https://commons.wikimedia.org/wiki/${encodeURIComponent(page.title)}`,
        mime: info.mime
      };
    })
    .filter((row) => /jpeg|png/.test(row.mime || ''));
}

const EXTENSIONS = { 'image/jpeg': '.jpg', 'image/jpg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const MAX_IMAGE_BYTES = 2.5 * 1024 * 1024;

async function download(url, slug, attempt = 1) {
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT } });

  if (res.status === 429 || res.status >= 500) {
    if (attempt <= 2) {
      await sleep(700 * attempt);
      return download(url, slug, attempt + 1);
    }
    throw new Error(`download HTTP ${res.status}`);
  }
  if (!res.ok) throw new Error(`download HTTP ${res.status}`);

  const declared = Number(res.headers.get('content-length') || 0);
  if (declared > MAX_IMAGE_BYTES) {
    throw new Error(`image too large (${Math.round(declared / 1024)}KB)`);
  }

  const type = (res.headers.get('content-type') || '').split(';')[0].trim();
  const ext = EXTENSIONS[type];
  if (!ext) throw new Error(`unsupported image type ${type}`);

  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < 3000) throw new Error(`image too small (${buffer.length} bytes)`);
  if (buffer.length > MAX_IMAGE_BYTES) {
    throw new Error(`image too large (${Math.round(buffer.length / 1024)}KB)`);
  }

  const filename = `${slug}${ext}`;
  fs.writeFileSync(path.join(config.uploadsDir, filename), buffer);
  return { filename, bytes: buffer.length };
}

// Returns candidate groups, best source first, so a throttled download from one
// provider can fall through to the next rather than losing the product.
async function gatherCandidates(query) {
  const groups = [];

  try {
    const openverse = await searchOpenverse(query);
    if (openverse.length) groups.push(openverse);
  } catch (err) {
    console.warn(`    openverse search failed for "${query}": ${err.message}`);
  }

  await sleep(REQUEST_DELAY_MS);

  try {
    const commons = await searchCommons(query);
    if (commons.length) groups.push(commons);
  } catch (err) {
    console.warn(`    commons search failed for "${query}": ${err.message}`);
  }

  return groups;
}

async function downloadFirst(candidates, slug) {
  const reasons = [];
  for (const candidate of candidates.slice(0, 3)) {
    const urls = [candidate.imageUrl, candidate.fallbackUrl].filter(
      (value, index, list) => value && list.indexOf(value) === index
    );
    for (const url of urls) {
      try {
        const file = await download(url, slug);
        return { file, pick: candidate };
      } catch (err) {
        reasons.push(err.message);
        await sleep(300);
      }
    }
  }
  throw new Error(reasons[reasons.length - 1] || 'no usable image');
}

// Postgres: no prepared-statement handles to keep. `pg` caches per connection and
// the dialect uses $n placeholders instead of ?.

// Credits accumulate across runs, so a later partial run never loses the
// licence record of images fetched earlier.
function loadCredits() {
  try {
    const parsed = JSON.parse(fs.readFileSync(CREDITS_JSON, 'utf8'));
    if (Array.isArray(parsed)) return parsed;
  } catch {
    /* nothing recorded yet */
  }
  return [];
}

function saveCredits(credits) {
  credits.sort((a, b) => a.slug.localeCompare(b.slug));
  fs.writeFileSync(CREDITS_JSON, `${JSON.stringify(credits, null, 2)}\n`);

  const lines = [
    '# Image credits',
    '',
    'Placeholder product photos downloaded by `npm run images`. Each image is',
    'freely licensed by its author — check the licence before using it commercially,',
    'and replace these with your own product photography before you launch.',
    '',
    'Generated from IMAGE-CREDITS.json — edit that file, not this one.',
    ''
  ];
  for (const credit of credits) {
    lines.push(`## ${credit.product}`);
    lines.push(`- File: \`${credit.file}\``);
    if (credit.title) lines.push(`- Title: ${credit.title}`);
    if (credit.creator) lines.push(`- Author: ${credit.creator}`);
    if (credit.license) lines.push(`- Licence: ${credit.license}`);
    if (credit.source) lines.push(`- Source: ${credit.source}`);
    lines.push('');
  }
  fs.writeFileSync(CREDITS_MD, lines.join('\n'));
  console.log(`\nRecorded credits for ${credits.length} image(s) in IMAGE-CREDITS.md`);
}

async function main() {
  fs.mkdirSync(config.uploadsDir, { recursive: true });

  const products = (await db.many('SELECT id, name, slug, image FROM products ORDER BY id ASC')).filter(
    (product) => force || !product.image,
  );

  if (!products.length) {
    console.log('Every product already has an image. Use --force to re-fetch.');
    return;
  }

  console.log(`Fetching images for ${products.length} product(s)…\n`);
  const credits = loadCredits();
  let ok = 0;
  let failed = 0;

  for (const product of products) {
    const query = KEYWORDS[product.slug] || product.name;
    process.stdout.write(`  ${product.slug.padEnd(26)} "${query}" … `);

    try {
      const groups = await gatherCandidates(query);
      if (!groups.length) {
        console.log('no suitable image found');
        failed += 1;
        continue;
      }

      let result = null;
      const problems = [];
      for (const group of groups) {
        try {
          result = await downloadFirst(group, product.slug);
          break;
        } catch (err) {
          problems.push(err.message);
        }
      }
      if (!result) throw new Error(problems[problems.length - 1] || 'no usable image');

      const { file, pick } = result;
      await db.query('UPDATE products SET image = $1, updated_at = now() WHERE id = $2', [
        `/uploads/${file.filename}`,
        product.id,
      ]);
      console.log(`ok (${Math.round(file.bytes / 1024)}KB, ${pick.license || 'unknown'})`);

      const entry = {
        product: product.name,
        slug: product.slug,
        file: `/uploads/${file.filename}`,
        title: pick.title,
        creator: pick.creator,
        license: pick.license,
        source: pick.source
      };
      const existing = credits.findIndex((credit) => credit.slug === product.slug);
      if (existing >= 0) credits[existing] = entry;
      else credits.push(entry);
      ok += 1;
    } catch (err) {
      console.log(`failed: ${err.message}`);
      failed += 1;
    }

    await sleep(REQUEST_DELAY_MS);
  }

  if (credits.length) saveCredits(credits);

  console.log(`\nDone: ${ok} image(s) added, ${failed} skipped.`);
  console.log('Restart the server if it is already running.');
}

main()
  .catch((err) => {
    console.error('Image seeding failed:', err);
    process.exitCode = 1;
  })
  // Release the pool, otherwise the script hangs on an open connection.
  .finally(() => db.close().catch(() => {}));
