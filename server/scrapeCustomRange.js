import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXTENSION_PATH = path.resolve(__dirname, 'extensions', 'bypass-paywalls', 'bypass-paywalls-chrome-clean-master');
const DIGESTS_DIR = path.resolve(__dirname, '..', 'digests');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Parse date strings safely
function parseDate(dateStr) {
  try {
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) return d;
  } catch (e) {}
  return null;
}

// Format date to clean YYYY-MM-DD string
function formatDate(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function run() {
  const targetPath = process.argv[2]; // e.g., 'section/economics', 'tag/iran', 'columnist/daron-acemoglu'
  const startDateStr = process.argv[3]; // e.g., '2026-05-01'
  const endDateStr = process.argv[4];   // e.g., '2026-05-15'

  if (!targetPath || !startDateStr || !endDateStr) {
    console.log('\n[!] Usage Error: Missing arguments.');
    console.log('    Usage: node scrapeCustomRange.js <path-slug> <start-date> <end-date>');
    console.log('    Example: node scrapeCustomRange.js tag/iran 2026-05-01 2026-05-10\n');
    process.exit(1);
  }

  const startDate = parseDate(startDateStr);
  const endDate = parseDate(endDateStr);

  if (!startDate || !endDate) {
    console.error('[-] Error: Invalid start or end date format. Use YYYY-MM-DD.');
    process.exit(1);
  }

  // Set start to beginning of day and end to end of day
  startDate.setHours(0, 0, 0, 0);
  endDate.setHours(23, 59, 59, 999);

  if (startDate > endDate) {
    console.error('[-] Error: Start date must be before or equal to end date.');
    process.exit(1);
  }

  const cleanSlug = targetPath.replace(/\//g, '-');
  const pdfName = `Project-Syndicate-${cleanSlug}-${formatDate(startDate)}-to-${formatDate(endDate)}.pdf`;
  const pdfPath = path.join(DIGESTS_DIR, pdfName);

  console.log(`[+] Target Path: https://www.project-syndicate.org/${targetPath}`);
  console.log(`[+] Date Range: ${formatDate(startDate)} to ${formatDate(endDate)}`);
  console.log(`[+] Destination: ${pdfPath}\n`);

  if (!fs.existsSync(EXTENSION_PATH)) {
    console.error(`[-] Extension not found at: ${EXTENSION_PATH}`);
    process.exit(1);
  }

  const browser = await puppeteer.launch({
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--window-size=1280,1024'
    ],
    defaultViewport: { width: 1280, height: 1024 }
  });

  const scrapedArticles = [];
  let pageNumber = 1;
  let keepPaginating = true;

  try {
    const mainPage = await browser.newPage();
    await mainPage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // Navigation Url
    const listUrl = `https://www.project-syndicate.org/${targetPath}`;
    console.log(`[+] Loading landing page: ${listUrl}`);
    await mainPage.goto(listUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await delay(6000); // Wait for full render

    while (keepPaginating) {
      console.log(`\n[+] Processing listing page ${pageNumber}...`);

      if (pageNumber > 1) {
        console.log(`[+] Programmatically clicking page ${pageNumber} link...`);
        const clicked = await mainPage.evaluate((pageNum) => {
          const paginator = document.querySelector('#paginator-latest-commentaries');
          if (!paginator) return false;
          const anchors = Array.from(paginator.querySelectorAll('a'));
          const targetAnchor = anchors.find(a => a.textContent.trim() === String(pageNum));
          if (targetAnchor) {
            targetAnchor.click();
            return true;
          }
          return false;
        }, pageNumber);

        if (!clicked) {
          console.log(`[-] Could not click page ${pageNumber} button (end of pagination). Stopping.`);
          break;
        }

        console.log(`[+] Clicked! Waiting 6 seconds for dynamic load...`);
        await delay(6000);
      }

      // Check for rate limit
      const pageTitle = await mainPage.title();
      if (pageTitle.includes('429') || pageTitle.toLowerCase().includes('too many requests')) {
        console.warn('[-] Warning: Encountered rate limit (429). Waiting 15 seconds before retrying...');
        await delay(15000);
        continue;
      }

      // Extract feed article links
      const uniqueItems = await mainPage.evaluate(() => {
        // Fallback checks to extract main feed items only
        const container = document.querySelector('#tab-latest-commentaries-content') || 
                          document.querySelector('.l-grid.grid--list') || 
                          document.querySelector('main') || 
                          document;
        
        const anchors = Array.from(container.querySelectorAll('a'));
        const items = anchors
          .filter(a => {
            const href = a.href;
            if (!href || href.includes('/commentaries')) return false;
            const isCommentary = href.includes('/commentary/');
            const isOnPoint = href.includes('/onpoint/');
            if (!isCommentary && !isOnPoint) return false;
            // Exclude header, footer, sidebars, and trending lists
            if (a.closest('header') || a.closest('footer') || a.closest('.sidebar') || a.closest('.trending') || a.closest('.trending-commentaries')) return false;
            return true;
          })
          .map(a => ({
            url: a.href.split('?')[0].split('#')[0].trim(),
            title: a.getAttribute('aria-label') || a.textContent.trim() || ''
          }))
          .filter(item => item.title.length > 5);

        // Deduplicate
        const unique = [];
        const seen = new Set();
        for (const item of items) {
          if (!seen.has(item.url)) {
            seen.add(item.url);
            unique.push(item);
          }
        }
        return unique;
      });

      console.log(`[+] Page ${pageNumber} has ${uniqueItems.length} unique articles in feed.`);

      if (uniqueItems.length === 0) {
        console.log('[-] No feed articles found on this page. Stopping.');
        break;
      }

      let hasNewerOrEqualArticles = false;

      // Scrape detail tab
      const articlePage = await browser.newPage();
      await articlePage.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

      for (const item of uniqueItems) {
        console.log(`[+] Checking article: "${item.title}"`);
        const sleepTime = 4000 + Math.random() * 4000;
        await delay(sleepTime);

        try {
          await articlePage.goto(item.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
          await delay(4000); // wait for paywall bypass extension

          const articleData = await articlePage.evaluate((url) => {
            const getText = selector => document.querySelector(selector)?.textContent.trim() || null;
            const getParagraphs = selectors => {
              for (const s of selectors) {
                const nodes = document.querySelectorAll(s);
                if (nodes.length > 0) return Array.from(nodes).map(n => n.textContent.trim()).filter(t => t.length > 0);
              }
              return [];
            };

            const title = getText('h1.article-header__title') || getText('h1.article__title') || getText('h1') || 'Untitled';
            const author = getText('a[href*="/columnist/"]') || 
                           getText('.byline a') || 
                           getText('.byline') || 
                           getText('a[rel="author"]') || 
                           getText('.article-header__author') || 
                           getText('.article__author') || 
                           getText('.author-name') || 
                           getText('.author') || 
                           'Unknown Author';
            const date = getText('.article-header__date') || getText('.article__pub-date') || getText('time') || '';
            const paras = getParagraphs(['.article__body-text p', '.article__content p', '.article__body p', 'article p']);

            return { title, author, date, url, paragraphs: paras };
          }, item.url);

          const fullText = articleData.paragraphs
            .filter(p => p.length > 20 && !p.toLowerCase().includes('sign up for our') && !p.toLowerCase().includes('read more'))
            .join('\n\n');

          const articleDate = parseDate(articleData.date);
          if (!articleDate) {
            console.log(`[-] Could not parse date "${articleData.date}" for "${articleData.title}". Skipping.`);
            continue;
          }

          const artTime = articleDate.getTime();
          console.log(`[+] Article published: ${formatDate(articleDate)}`);

          // Relevancy checks
          if (artTime >= startDate.getTime()) {
            hasNewerOrEqualArticles = true; // Still within or newer than start limit
          }

          const isWithinRange = (artTime >= startDate.getTime() && artTime <= endDate.getTime());

          if (isWithinRange) {
            console.log(`[+] SCRAPED MATCH: "${articleData.title}" by ${articleData.author}`);
            scrapedArticles.push({
              title: articleData.title,
              author: articleData.author,
              date: articleData.date,
              url: item.url,
              content: fullText
            });
          } else if (artTime > endDate.getTime()) {
            console.log(`[-] Article is too new. Skipping.`);
          } else {
            console.log(`[-] Article is too old. Skipping.`);
          }

        } catch (artErr) {
          console.error(`[-] Error scraping article ${item.url}:`, artErr.message);
        }
      }

      await articlePage.close();

      // If this page had only older articles, stop paginating
      if (!hasNewerOrEqualArticles) {
        console.log(`[+] No articles on page ${pageNumber} are within or newer than start date ${formatDate(startDate)}. Stopping pagination.`);
        keepPaginating = false;
      }

      if (keepPaginating) {
        pageNumber++;
        if (pageNumber > 60) { // safety limit
          console.log('[+] Safety limit of 60 listing pages reached. Stopping pagination.');
          break;
        }
      }
    }

    console.log(`\n[+] Finished scraping. Found ${scrapedArticles.length} matching articles.`);

    if (scrapedArticles.length === 0) {
      console.log('[-] No matching articles found to compile. Exiting.');
      return;
    }

    // Generate HTML for PDF compiler
    console.log('[+] Generating HTML layout for digest...');
    const rangeMetaTitle = `${formatDate(startDate)} to ${formatDate(endDate)}`;
    let htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Project Syndicate Digest - ${targetPath}</title>
  <style>
    body { font-family: 'Georgia', serif; line-height: 1.6; color: #111; margin: 0; padding: 0; font-size: 14px; }
    .cover { height: 100vh; display: flex; flex-direction: column; justify-content: center; align-items: center; text-align: center; page-break-after: always; padding: 40px; box-sizing: border-box; }
    .cover-title { font-size: 32px; font-weight: bold; margin-bottom: 20px; color: #0b3c5d; font-family: sans-serif; }
    .cover-meta { font-size: 12px; color: #666; margin-top: 100px; }
    .toc { page-break-after: always; padding: 40px; }
    .article { page-break-before: always; padding: 40px; }
    .title { font-size: 24px; color: #0b3c5d; margin-bottom: 10px; font-family: sans-serif; }
    .meta { font-size: 12px; color: #666; margin-bottom: 20px; border-bottom: 1px solid #ddd; padding-bottom: 10px; }
    .body { text-align: justify; }
  </style>
</head>
<body>
  <div class="cover">
    <div style="flex-grow: 1;"></div>
    <div class="cover-title">PROJECT SYNDICATE DIGEST</div>
    <div style="font-size: 20px; margin-bottom: 20px;">Feed Path: ${targetPath}</div>
    <div style="font-size: 18px; color: #666;">Range: ${rangeMetaTitle}</div>
    <div style="flex-grow: 1;"></div>
    <div class="cover-meta">Generated: ${new Date().toLocaleDateString()} | Articles: ${scrapedArticles.length}</div>
  </div>

  <div class="toc">
    <h2 style="font-family: sans-serif;">Table of Contents</h2>
    <ul style="list-style: none; padding: 0;">
      ${scrapedArticles.map((art, idx) => `
        <li style="margin-bottom: 10px; border-bottom: 1px dotted #ccc; padding-bottom: 4px;">
          <a href="#art-${idx}" style="color: #111; text-decoration: none;">${idx + 1}. ${art.title}</a>
          <span style="float: right; font-size: 12px; color: #666;">by ${art.author} (${art.date})</span>
        </li>
      `).join('')}
    </ul>
  </div>
    `;

    scrapedArticles.forEach((art, idx) => {
      htmlContent += `
  <div class="article" id="art-${idx}">
    <h2 class="title">${idx + 1}. ${art.title}</h2>
    <div class="meta">
      <strong>Author:</strong> ${art.author} | <strong>Date:</strong> ${art.date} | <strong>Original:</strong> <a href="${art.url}" target="_blank">${art.url}</a>
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

    const tempHtml = path.join(DIGESTS_DIR, `temp-custom-${cleanSlug}.html`);
    fs.writeFileSync(tempHtml, htmlContent, 'utf-8');

    console.log('[+] Generating PDF layout using Puppeteer...');
    const printPage = await browser.newPage();
    await printPage.goto(`file://${tempHtml}`, { waitUntil: 'networkidle0' });
    
    await printPage.pdf({
      path: pdfPath,
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: `<div style="font-size: 8px; font-family: sans-serif; width: 100%; text-align: center; color: #888; border-bottom: 1px solid #ddd; padding-bottom: 5px; margin-left: 40px; margin-right: 40px;">Project Syndicate - ${targetPath.toUpperCase()} - ${rangeMetaTitle}</div>`,
      footerTemplate: `<div style="font-size: 8px; font-family: sans-serif; width: 100%; text-align: right; color: #888; border-top: 1px solid #ddd; padding-top: 5px; padding-right: 40px; margin-left: 40px;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>`,
      margin: { top: '60px', bottom: '60px', left: '40px', right: '40px' }
    });

    console.log(`[+] PDF successfully compiled at: ${pdfPath}`);
    
    // cleanup
    fs.unlinkSync(tempHtml);

  } catch (err) {
    console.error('[-] Error in run:', err.message);
  } finally {
    await browser.close();
  }
}

run();
