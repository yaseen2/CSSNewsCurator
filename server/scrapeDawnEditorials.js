import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const CACHE_FILE = path.resolve(__dirname, 'dawnEditorialsData.json');
const DIGESTS_DIR = path.resolve(__dirname, '..', 'digests');

// Helper delay function
const delay = ms => new Promise(r => setTimeout(r, ms));

// Helper: Generate date range strings in descending order (newest first)
function getDatesInRange(startStr, endStr) {
  const dates = [];
  let cur = new Date(endStr);
  const start = new Date(startStr);
  
  while (cur >= start) {
    const yyyy = cur.getFullYear();
    const mm = String(cur.getMonth() + 1).padStart(2, '0');
    const dd = String(cur.getDate()).padStart(2, '0');
    dates.push(`${yyyy}-${mm}-${dd}`);
    cur.setDate(cur.getDate() - 1);
  }
  return dates;
}

// Clean text for metadata date line (remove leading/trailing spaces/newlines)
function cleanDateLine(text) {
  if (!text) return '';
  return text.replace(/\s+/g, ' ').trim();
}

async function run() {
  const args = process.argv.slice(2);
  let startDateStr = args[0] || '2026-01-01';
  let endDateStr = args[1];

  // Default end date to today
  if (!endDateStr) {
    const today = new Date();
    const yyyy = today.getFullYear();
    const mm = String(today.getMonth() + 1).padStart(2, '0');
    const dd = String(today.getDate()).padStart(2, '0');
    endDateStr = `${yyyy}-${mm}-${dd}`;
  }

  console.log(`[+] Running Dawn Editorials Scraper`);
  console.log(`[+] Date range: ${startDateStr} to ${endDateStr}`);

  // Load existing cache
  let cache = {};
  if (fs.existsSync(CACHE_FILE)) {
    try {
      cache = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf-8'));
      console.log(`[+] Loaded ${Object.keys(cache).length} articles from cache: ${CACHE_FILE}`);
    } catch (e) {
      console.error('[-] Error reading cache file, starting fresh:', e.message);
    }
  }

  const dateList = getDatesInRange(startDateStr, endDateStr);
  console.log(`[+] Total days to process: ${dateList.length}`);

  console.log('[+] Launching Puppeteer...');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const mainPage = await browser.newPage();
  await mainPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  // Intercept requests to block media/stylesheets/images/fonts for fast scraping
  await mainPage.setRequestInterception(true);
  mainPage.on('request', (req) => {
    const type = req.resourceType();
    if (['image', 'stylesheet', 'font', 'media'].includes(type)) {
      req.abort();
    } else {
      req.continue();
    }
  });

  const discoveredArticles = [];

  try {
    // ----------------------------------------------------
    // STEP 1: Discover Editorial URLs day-by-day
    // ----------------------------------------------------
    console.log('\n[+] Phase 1: Discovering editorial links...');
    
    for (const dateStr of dateList) {
      const archiveUrl = `https://www.dawn.com/newspaper/editorial/${dateStr}/`;
      console.log(`[+] Loading archive: ${archiveUrl}`);
      
      try {
        await mainPage.goto(archiveUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        // Small delay to ensure elements render
        await delay(1500);

        const titlesAndUrls = await mainPage.evaluate(() => {
          // Select only links within the main list container (class space-y-8)
          const container = document.querySelector('.space-y-8');
          if (!container) return [];
          
          const anchors = Array.from(container.querySelectorAll('a.story__link'));
          return anchors.map(a => ({
            title: a.textContent.trim(),
            url: a.href
          }));
        });

        // Deduplicate and filter links found
        const cleanLinks = [];
        const seen = new Set();
        titlesAndUrls.forEach(item => {
          if (!item.url) return;
          const cleanUrl = item.url.split('?')[0].split('#')[0].trim();
          if (cleanUrl.includes('/news/') && !seen.has(cleanUrl)) {
            seen.add(cleanUrl);
            cleanLinks.push({ title: item.title, url: cleanUrl });
          }
        });

        console.log(`    -> Found ${cleanLinks.length} editorials for ${dateStr}`);
        discoveredArticles.push(...cleanLinks.map(link => ({ ...link, archiveDate: dateStr })));

      } catch (err) {
        console.error(`[-] Error loading archive for ${dateStr}:`, err.message);
      }
    }

    console.log(`\n[+] Phase 1 Complete. Discovered ${discoveredArticles.length} total editorial links.`);

    // ----------------------------------------------------
    // STEP 2: Crawl article contents (utilizing cache)
    // ----------------------------------------------------
    console.log('\n[+] Phase 2: Scraping editorial contents...');
    const crawledArticles = [];

    for (const article of discoveredArticles) {
      const cleanUrl = article.url;
      
      // Check cache first
      if (cache[cleanUrl]) {
        console.log(`[+] CACHE HIT: "${article.title}"`);
        crawledArticles.push(cache[cleanUrl]);
        continue;
      }

      console.log(`[+] Scraping: ${cleanUrl}...`);
      try {
        await mainPage.goto(cleanUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await delay(2000);

        const contentData = await mainPage.evaluate(() => {
          const contentWrapper = document.querySelector('.story__content, .story-text');
          const paragraphs = contentWrapper ? Array.from(contentWrapper.querySelectorAll('p')).map(p => p.textContent.trim()).filter(p => p.length > 0) : [];
          
          const titleEl = document.querySelector('h1.story__title, h2.story__title, .story__title, h1 a, h1');
          const dateEl = document.querySelector('.story__time, time');

          return {
            title: titleEl ? titleEl.textContent.trim() : '',
            date: dateEl ? dateEl.textContent.trim() : '',
            content: paragraphs.join('\n\n')
          };
        });

        if (!contentData.content) {
          console.warn(`[-] Warning: Empty content extracted for ${cleanUrl}`);
          continue;
        }

        const crawled = {
          title: contentData.title || article.title,
          url: cleanUrl,
          content: contentData.content,
          date: cleanDateLine(contentData.date),
          archiveDate: article.archiveDate,
          source: 'Dawn',
          author: 'Dawn Editorial'
        };

        // Cache item
        cache[cleanUrl] = crawled;
        crawledArticles.push(crawled);

        // Save cache periodically
        fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2), 'utf-8');
        console.log(`    -> Scraped! cached "${crawled.title}"`);

        // Politeness delay
        await delay(800);

      } catch (err) {
        console.error(`[-] Error scraping article ${cleanUrl}:`, err.message);
      }
    }

    console.log(`\n[+] Phase 2 Complete. Crawled ${crawledArticles.length} editorials.`);

    if (crawledArticles.length === 0) {
      console.log('[-] No articles found to compile. Exiting.');
      return;
    }

    // ----------------------------------------------------
    // STEP 3: Generate PDF Digest
    // ----------------------------------------------------
    console.log('\n[+] Phase 3: Compiling PDF digest...');

    // Sort chronologically (earliest first)
    crawledArticles.sort((a, b) => new Date(a.archiveDate) - new Date(b.archiveDate));

    const pdfName = `Dawn-Editorials-${startDateStr}-to-${endDateStr}.pdf`;
    const pdfPath = path.join(DIGESTS_DIR, pdfName);

    let htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Dawn Editorials Digest - ${startDateStr} to ${endDateStr}</title>
  <style>
    body { font-family: 'Georgia', serif; line-height: 1.6; color: #111; margin: 0; padding: 0; font-size: 14px; }
    .cover { height: 100vh; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; page-break-after: always; padding: 40px; box-sizing: border-box; }
    .cover-title { font-size: 32px; font-weight: bold; margin-bottom: 20px; color: #1a365d; font-family: sans-serif; letter-spacing: 1px; }
    .cover-subtitle { font-size: 18px; color: #4a5568; margin-bottom: 50px; font-family: sans-serif; }
    .cover-meta { font-size: 12px; color: #718096; margin-top: 150px; }
    .toc { page-break-after: always; padding: 40px; }
    .toc-title { font-size: 24px; font-weight: bold; margin-bottom: 20px; color: #1a365d; border-bottom: 2px solid #1a365d; padding-bottom: 5px; font-family: sans-serif; }
    .article { page-break-before: always; padding: 40px; }
    .title { font-size: 24px; color: #1a365d; margin-bottom: 10px; font-family: sans-serif; font-weight: bold; }
    .meta { font-size: 12px; color: #718096; margin-bottom: 20px; border-bottom: 1px solid #e2e8f0; padding-bottom: 10px; }
    .body { text-align: justify; }
    p { margin-bottom: 1.2em; text-indent: 0; }
  </style>
</head>
<body>
  <div class="cover">
    <div style="flex-grow: 1;"></div>
    <div class="cover-title">DAWN EDITORIALS DIGEST</div>
    <div class="cover-subtitle">Daily Editorial Columns from Dawn Newspaper</div>
    <div style="font-size: 14px; color: #4a5568; font-weight: bold;">Date Range: ${startDateStr} to ${endDateStr}</div>
    <div style="font-size: 12px; color: #718096; margin-top: 10px;">Total Compiled Editorials: ${crawledArticles.length}</div>
    <div class="cover-meta">Generated on ${new Date().toLocaleDateString()}</div>
    <div style="flex-grow: 1.5;"></div>
  </div>

  <div class="toc">
    <div class="toc-title">Table of Contents</div>
    <ul style="list-style: none; padding: 0; margin: 0;">
      ${crawledArticles.map((art, idx) => `
        <li style="margin-bottom: 12px; border-bottom: 1px dotted #cbd5e0; padding-bottom: 4px; display: flex; justify-content: space-between; align-items: flex-end;">
          <a href="#art-${idx}" style="color: #2b6cb0; text-decoration: none; font-weight: bold;">${idx + 1}. ${art.title}</a>
          <span style="font-size: 12px; color: #718096; white-space: nowrap; margin-left: 10px;">(${art.archiveDate})</span>
        </li>
      `).join('')}
    </ul>
  </div>
    `;

    crawledArticles.forEach((art, idx) => {
      htmlContent += `
  <div class="article" id="art-${idx}">
    <h2 class="title">${idx + 1}. ${art.title}</h2>
    <div class="meta">
      <strong>Source:</strong> ${art.source} | <strong>Section:</strong> Editorial | <strong>Publish Date:</strong> ${art.date || art.archiveDate} | <strong>Link:</strong> <a href="${art.url}" target="_blank">${art.url}</a>
    </div>
    <div class="body">
      ${art.content.split('\n\n').map(p => `<p>${p.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`).join('\n      ')}
    </div>
  </div>
      `;
    });

    htmlContent += `
</body>
</html>
    `;

    if (!fs.existsSync(DIGESTS_DIR)) {
      fs.mkdirSync(DIGESTS_DIR, { recursive: true });
    }

    const tempHtml = path.join(DIGESTS_DIR, `temp-dawn-editorials.html`);
    fs.writeFileSync(tempHtml, htmlContent, 'utf-8');

    console.log('[+] Generating PDF layout using Puppeteer...');
    const printPage = await browser.newPage();
    // Disable timeout limits for large documents
    await printPage.setDefaultNavigationTimeout(0);
    await printPage.setDefaultTimeout(0);
    
    await printPage.goto(`file://${tempHtml}`, { waitUntil: 'domcontentloaded', timeout: 0 });

    await printPage.pdf({
      path: pdfPath,
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: `<div style="font-size: 8px; font-family: sans-serif; width: 100%; text-align: center; color: #888; border-bottom: 1px solid #ddd; padding-bottom: 5px; margin-left: 40px; margin-right: 40px;">Dawn Editorials - ${startDateStr} to ${endDateStr}</div>`,
      footerTemplate: `<div style="font-size: 8px; font-family: sans-serif; width: 100%; text-align: right; color: #888; border-top: 1px solid #ddd; padding-top: 5px; padding-right: 40px; margin-left: 40px;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>`,
      margin: { top: '60px', bottom: '60px', left: '40px', right: '40px' }
    });

    console.log(`[+] PDF successfully compiled at: ${pdfPath}`);
    
    // cleanup
    fs.unlinkSync(tempHtml);
    console.log('[+] Temporary HTML file cleaned up.');

  } catch (err) {
    console.error('[-] Error in run:', err.message);
  } finally {
    await browser.close();
  }
}

run();
