'use strict';
// Regenerates the HTML fixtures from the live sites, trimmed to the first rows
// of each table so the repo stays small. Run with: npm run fixtures:refresh
const fs = require('fs');
const path = require('path');
const cheerio = require('cheerio');
const { fetchHtml } = require('../../utilities/http');
const { PAGE_URL } = require('../../scrapers/wikipedia');
const { _internals: wiki } = require('../../scrapers/wikipedia');

const OUT = __dirname;
const KWORB = 'https://kworb.net/';
const KWORB_PAGES = {
    'kworb-artist-songs.html': 'spotify/artist/06HL4z0CvFAxyc27GXpf02_songs.html',
    'kworb-artist-albums.html': 'spotify/artist/06HL4z0CvFAxyc27GXpf02_albums.html',
    'kworb-artists.html': 'spotify/artists.html',
    'kworb-listeners.html': 'spotify/listeners.html',
    'kworb-songs.html': 'spotify/songs.html',
    'kworb-albums.html': 'spotify/albums.html',
    'kworb-yt-topvideos.html': 'youtube/topvideos.html',
};
const MAX_ROWS = 30;

function trimTables($, root, maxRows) {
    $(root).find('table').each((_, table) => {
        $(table).find('tr').slice(maxRows + 1).remove();
    });
}

async function kworbFixtures() {
    for (const [name, p] of Object.entries(KWORB_PAGES)) {
        const html = await fetchHtml(KWORB + p);
        const $ = cheerio.load(html);
        $('script, style, link, img, iframe').remove();
        trimTables($, $.root(), MAX_ROWS);
        fs.writeFileSync(path.join(OUT, name), $.html());
        console.log('wrote', name);
    }
}

// Keeps the real sibling sequence of each records section (heading wrapper,
// tables, notes, and the heading that ends the section) so the section walker
// is exercised exactly as on the live page.
async function wikipediaFixture() {
    const html = await fetchHtml(PAGE_URL, { userAgent: 'StatsCraveBot/1.0 (+https://statscrave.com)' });
    const $ = cheerio.load(html);
    const parts = [];
    for (const section of Object.values(wiki.SECTIONS)) {
        const heading = $(`#${section.id}`).first();
        if (!heading.length) throw new Error(`section ${section.id} missing on live page`);
        const level = parseInt(heading[0].tagName.slice(1), 10);
        const start = heading.parent().is('.mw-heading') ? heading.parent() : heading;
        let node = start;
        while (node.length) {
            const clone = node.clone();
            clone.find('style, script, link, img').remove();
            trimTables($, clone, 25);
            parts.push($.html(clone));
            node = node.next();
            if (!node.length) break;
            const h = node.is('.mw-heading') ? node.children('h1,h2,h3,h4,h5,h6').first() : (/^h[1-6]$/i.test(node[0].tagName || '') ? node : null);
            if (h && h.length && parseInt(h[0].tagName.slice(1), 10) <= level) {
                parts.push($.html(node.clone())); // the boundary heading, so the walker must stop here
                break;
            }
        }
    }
    const out = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>List of Spotify streaming records (trimmed fixture)</title></head><body><div class="mw-parser-output">\n${parts.join('\n')}\n</div></body></html>`;
    fs.writeFileSync(path.join(OUT, 'wikipedia-spotify-records.html'), out);
    console.log('wrote wikipedia-spotify-records.html');
}

(async () => {
    await kworbFixtures();
    await wikipediaFixture();
})().catch((err) => { console.error(err); process.exit(1); });
