import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_FILE = path.join(__dirname, 'projectSyndicateData.json');
const EXTENSION_PATH = path.resolve(__dirname, 'extensions', 'bypass-paywalls', 'bypass-paywalls-chrome-clean-master');

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

async function scrapeProjectSyndicate() {
  console.log('[+] Starting Project Syndicate scraper...');
  
  // 1. Read existing scraped articles
  let existingArticles = [];
  if (fs.existsSync(DATA_FILE)) {
    try {
      existingArticles = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
      console.log(`[+] Loaded ${existingArticles.length} existing articles from database.`);
    } catch (e) {
      console.error('[-] Error reading data file, initializing empty list:', e.message);
    }
  }
  
  const existingUrls = new Set(existingArticles.map(art => art.url));

  // Verify extension path
  console.log(`[+] Loading paywall bypass extension from: ${EXTENSION_PATH}`);
  if (!fs.existsSync(EXTENSION_PATH)) {
    console.error(`[-] CRITICAL ERROR: Extension path does not exist at: ${EXTENSION_PATH}`);
    process.exit(1);
  }

  // 2. Launch browser with extension loaded
  const browser = await puppeteer.launch({
    headless: false, // Must be false for extensions to work
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

  try {
    const page = await browser.newPage();
    
    // Set realistic User Agent
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

    // 3. Discover latest article URLs
    console.log('[+] Fetching Project Syndicate home/commentary pages to discover article URLs...');
    
    const targetPages = [
      'https://www.project-syndicate.org/',
      'https://www.project-syndicate.org/commentary'
    ];

    const discoveredUrls = new Set();

    for (const targetUrl of targetPages) {
      try {
        console.log(`[+] Navigating to ${targetUrl}...`);
        await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        
        // Give page a small delay to load elements
        await delay(3000);

        // Find all links containing "/commentary/"
        const links = await page.evaluate(() => {
          const anchors = Array.from(document.querySelectorAll('a'));
          return anchors
            .map(a => a.href)
            .filter(href => href && href.includes('/commentary/') && !href.includes('/commentaries'));
        });

        links.forEach(link => {
          // Normalize URL: remove query params / hash
          const cleanUrl = link.split('?')[0].split('#')[0].trim();
          if (cleanUrl.startsWith('https://www.project-syndicate.org/commentary/')) {
            discoveredUrls.add(cleanUrl);
          }
        });
      } catch (err) {
        console.error(`[-] Error discovering URLs on ${targetUrl}:`, err.message);
      }
    }

    const newUrls = Array.from(discoveredUrls).filter(url => !existingUrls.has(url));
    console.log(`[+] Found ${discoveredUrls.size} total article URLs. ${newUrls.length} are new.`);

    if (newUrls.length === 0) {
      console.log('[+] No new articles to scrape. Exiting.');
      await browser.close();
      return;
    }

    // 4. Scrape each new article
    const scrapedArticles = [];

    // Limit to top 15 new articles per run to be polite and avoid timeouts
    const capLimit = 15;
    const urlsToScrape = newUrls.slice(0, capLimit);
    console.log(`[+] Commencing scraping for top ${urlsToScrape.length} new articles...`);

    for (let i = 0; i < urlsToScrape.length; i++) {
      const url = urlsToScrape[i];
      console.log(`\n[+] [${i + 1}/${urlsToScrape.length}] Scraping: ${url}`);

      // Politeness delay
      if (i > 0) {
        const sleepTime = 5000 + Math.random() * 5000;
        console.log(`[+] Sleeping for ${(sleepTime / 1000).toFixed(1)} seconds...`);
        await delay(sleepTime);
      }

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45000 });
        
        // Extra delay for dynamic payload and extension to execute
        await delay(4000);

        // Extract metadata and content
        const articleData = await page.evaluate((articleUrl) => {
          // Fallback utility for text content from selector
          const getText = (selector) => {
            const el = document.querySelector(selector);
            return el ? el.textContent.trim() : null;
          };

          // Fallback utility for array text content
          const getParagraphs = (selectors) => {
            for (const selector of selectors) {
              const nodes = document.querySelectorAll(selector);
              if (nodes && nodes.length > 0) {
                const paras = Array.from(nodes).map(n => n.textContent.trim()).filter(t => t.length > 0);
                if (paras.length > 0) return paras;
              }
            }
            return [];
          };

          // Find Title
          const title = getText('h1.article-header__title') || 
                        getText('h1.article__title') || 
                        getText('h1') || 
                        getText('.article-title') || 
                        'Untitled Article';

          // Find Author
          const author = getText('a[rel="author"]') || 
                         getText('.article-header__author') || 
                         getText('.article__author') || 
                         getText('.author-name') || 
                         getText('.author') || 
                         'Unknown Author';

          // Find Date
          const date = getText('.article-header__date') || 
                       getText('.article__pub-date') || 
                       getText('time') || 
                       getText('.pub-date') || 
                       new Date().toISOString().split('T')[0];

          // Find Content
          const contentParagraphs = getParagraphs([
            '.article__body-text p',
            '.article__content p',
            '.article__body p',
            'article p',
            '.post-content p',
            '.content p'
          ]);

          return {
            title,
            author,
            date,
            url: articleUrl,
            paragraphs: contentParagraphs,
            scrapedAt: new Date().toISOString()
          };
        }, url);

        // Filter out short paragraphs and metadata markers
        const cleanParagraphs = articleData.paragraphs.filter(p => {
          const lower = p.toLowerCase();
          return p.length > 20 && 
                 !lower.includes('sign up for our') &&
                 !lower.includes('project syndicate') &&
                 !lower.includes('read more') &&
                 !lower.includes('license this article') &&
                 !lower.includes('all rights reserved');
        });

        const fullContent = cleanParagraphs.join('\n\n');

        if (fullContent.length < 200) {
          console.warn(`[-] Warning: Extracted text is very short (${fullContent.length} chars). Scrape might be blocked or selector failed.`);
        }

        const article = {
          title: articleData.title,
          author: articleData.author,
          date: articleData.date,
          url: articleData.url,
          content: fullContent,
          scrapedAt: articleData.scrapedAt
        };

        scrapedArticles.push(article);
        console.log(`[+] Successfully scraped: "${article.title}" by ${article.author} (${article.content.length} chars)`);

        // Save incrementally so we don't lose progress if script crashes
        existingArticles.push(article);
        
        // Sort by date descending
        existingArticles.sort((a, b) => new Date(b.date) - new Date(a.date));
        
        fs.writeFileSync(DATA_FILE, JSON.stringify(existingArticles, null, 2), 'utf-8');

      } catch (articleErr) {
        console.error(`[-] Failed to scrape article at ${url}:`, articleErr.message);
      }
    }

    console.log(`\n[+] Scrape run completed. Added ${scrapedArticles.length} new articles.`);

  } catch (err) {
    console.error('[-] Scraping process encountered error:', err.message);
  } finally {
    await browser.close();
  }
}

scrapeProjectSyndicate()
  .then(() => {
    console.log('[+] Scraper run finished.');
    process.exit(0);
  })
  .catch(err => {
    console.error('[-] Unhandled exception in scraper:', err.message);
    process.exit(1);
  });
