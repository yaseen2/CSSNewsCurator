import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';

puppeteer.use(StealthPlugin());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const EXTENSION_PATH = path.resolve(__dirname, 'extensions', 'bypass-paywalls', 'bypass-paywalls-chrome-clean-master');

async function test() {
  console.log('[+] Launching Puppeteer...');
  const browser = await puppeteer.launch({
    headless: false,
    args: [
      `--disable-extensions-except=${EXTENSION_PATH}`,
      `--load-extension=${EXTENSION_PATH}`,
      '--no-sandbox',
      '--disable-setuid-sandbox'
    ]
  });

  try {
    const page = await browser.newPage();
    console.log('[+] Navigating to Economics section landing page...');
    await page.goto('https://www.project-syndicate.org/section/economics', { waitUntil: 'domcontentloaded', timeout: 45000 });
    await new Promise(r => setTimeout(r, 6000)); // wait for full render

    // Function to extract unique articles from the commentaries feed container
    const extractFeedArticles = async () => {
      return page.evaluate(() => {
        const container = document.querySelector('#tab-latest-commentaries-content');
        if (!container) return [];
        const anchors = Array.from(container.querySelectorAll('a'));
        const items = anchors
          .filter(a => a.href && a.href.includes('/commentary/') && !a.href.includes('/commentaries'))
          .map(a => ({
            title: a.getAttribute('aria-label') || a.textContent.trim() || '',
            url: a.href.split('?')[0].split('#')[0].trim()
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
    };

    // 1. Get Page 1 feed articles
    const feed1 = await extractFeedArticles();
    console.log(`[+] Page 1: Found ${feed1.length} feed articles. Sample:`);
    feed1.slice(0, 5).forEach((art, i) => console.log(`   ${i+1}. ${art.title} (${art.url})`));

    // 2. Click Page 2
    console.log('[+] Clicking Page 2 in paginator...');
    const clickSuccess = await page.evaluate(() => {
      const paginator = document.querySelector('#paginator-latest-commentaries');
      if (!paginator) return false;
      const anchors = Array.from(paginator.querySelectorAll('a'));
      const page2Link = anchors.find(a => a.textContent.trim() === '2');
      if (page2Link) {
        page2Link.click();
        return true;
      }
      return false;
    });

    if (!clickSuccess) {
      console.error('[-] Failed to click page 2 button.');
      return;
    }

    console.log('[+] Clicked! Waiting 6 seconds for AJAX load...');
    await new Promise(r => setTimeout(r, 6000));

    // 3. Get Page 2 feed articles
    const feed2 = await extractFeedArticles();
    console.log(`[+] Page 2: Found ${feed2.length} feed articles. Sample:`);
    feed2.slice(0, 5).forEach((art, i) => console.log(`   ${i+1}. ${art.title} (${art.url})`));

    console.log('[+] Feed changed? ', feed1[0]?.url !== feed2[0]?.url);

  } catch (err) {
    console.error('Error:', err.message);
  } finally {
    await browser.close();
  }
}

test();
