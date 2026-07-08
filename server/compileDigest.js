import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DATA_FILE = path.join(__dirname, 'projectSyndicateData.json');
const DIGESTS_DIR = path.resolve(__dirname, '..', 'digests');

async function compileDigest() {
  console.log('[+] Starting monthly digest compiler...');

  // 1. Determine target month (YYYY-MM format)
  // Can be passed as command line argument, e.g. "node compileDigest.js 2026-07"
  let targetMonth = process.argv[2];
  
  if (!targetMonth) {
    // Default to current month
    const now = new Date();
    const year = now.getFullYear();
    const month = String(now.getMonth() + 1).padStart(2, '0');
    targetMonth = `${year}-${month}`;
  }

  console.log(`[+] Compiling digest for month: ${targetMonth}`);

  // 2. Read scraped database
  if (!fs.existsSync(DATA_FILE)) {
    console.error(`[-] Database file not found at ${DATA_FILE}. Run the scraper first!`);
    process.exit(1);
  }

  let articles = [];
  try {
    articles = JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch (err) {
    console.error('[-] Error reading database:', err.message);
    process.exit(1);
  }

  // 3. Filter articles by date
  // Expects date field in format "YYYY-MM-DD" or similar, matching "YYYY-MM"
  const filteredArticles = articles.filter(art => {
    if (!art.date) return false;
    try {
      const d = new Date(art.date);
      if (isNaN(d.getTime())) {
        return art.date.startsWith(targetMonth);
      }
      const year = d.getFullYear();
      const month = String(d.getMonth() + 1).padStart(2, '0');
      const artMonth = `${year}-${month}`;
      return artMonth === targetMonth;
    } catch (e) {
      return art.date.startsWith(targetMonth);
    }
  });

  // Sort chronological ascending (oldest first for a month reading digest)
  filteredArticles.sort((a, b) => new Date(a.date) - new Date(b.date));

  console.log(`[+] Found ${filteredArticles.length} articles for ${targetMonth}.`);

  if (filteredArticles.length === 0) {
    console.log(`[-] No articles found for the month ${targetMonth}. Skipping PDF generation.`);
    process.exit(0);
  }

  // 4. Generate beautiful clean HTML
  const monthNames = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December"
  ];
  const [yearStr, monthStr] = targetMonth.split('-');
  const monthName = monthNames[parseInt(monthStr, 10) - 1] || monthStr;
  const prettyMonthTitle = `${monthName} ${yearStr}`;

  let htmlContent = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <title>Project Syndicate Digest - ${prettyMonthTitle}</title>
  <style>
    body {
      font-family: 'Georgia', 'Times New Roman', serif;
      line-height: 1.6;
      color: #111;
      margin: 0;
      padding: 0;
      font-size: 14px;
    }
    .cover-page {
      height: 100vh;
      display: flex;
      flex-direction: column;
      justify-content: center;
      align-items: center;
      text-align: center;
      page-break-after: always;
      padding: 40px;
      box-sizing: border-box;
    }
    .cover-title {
      font-size: 36px;
      font-weight: bold;
      font-family: 'Helvetica Neue', 'Arial', sans-serif;
      margin-bottom: 20px;
      color: #0b3c5d;
    }
    .cover-subtitle {
      font-size: 20px;
      color: #666;
      margin-bottom: 50px;
    }
    .cover-meta {
      font-size: 12px;
      color: #888;
      margin-top: 100px;
    }
    .toc-page {
      page-break-after: always;
      padding: 20px 40px;
    }
    .toc-title {
      font-size: 24px;
      font-weight: bold;
      font-family: 'Helvetica Neue', 'Arial', sans-serif;
      border-bottom: 2px solid #0b3c5d;
      padding-bottom: 10px;
      margin-bottom: 20px;
    }
    .toc-list {
      list-style: none;
      padding: 0;
    }
    .toc-item {
      display: flex;
      justify-content: space-between;
      margin-bottom: 12px;
      border-bottom: 1px dotted #ccc;
      padding-bottom: 4px;
    }
    .toc-link {
      color: #111;
      text-decoration: none;
      font-weight: 500;
    }
    .article-container {
      page-break-before: always;
      padding: 20px 40px;
    }
    .article-title {
      font-size: 24px;
      font-weight: bold;
      font-family: 'Helvetica Neue', 'Arial', sans-serif;
      color: #0b3c5d;
      margin-top: 0;
      margin-bottom: 10px;
      line-height: 1.3;
    }
    .article-meta {
      font-size: 13px;
      color: #555;
      margin-bottom: 25px;
      padding-bottom: 10px;
      border-bottom: 1px solid #eee;
      font-family: 'Helvetica Neue', 'Arial', sans-serif;
    }
    .article-meta span {
      margin-right: 20px;
    }
    .article-link {
      color: #0066cc;
      text-decoration: none;
    }
    .article-body {
      text-align: justify;
    }
    .article-body p {
      margin-bottom: 16px;
      text-indent: 0;
    }
    
    @media print {
      body {
        font-size: 13px;
      }
      .article-container {
        page-break-before: always;
      }
      a {
        color: #111;
        text-decoration: none;
      }
    }
  </style>
</head>
<body>

  <!-- Cover Page -->
  <div class="cover-page">
    <div style="flex-grow: 1;"></div>
    <div class="cover-title">PROJECT SYNDICATE DIGEST</div>
    <div class="cover-subtitle">${prettyMonthTitle}</div>
    <div style="font-size: 14px; font-family: sans-serif; color: #444;">
      Compiled collection of all curated commentaries and analysis columns.
    </div>
    <div style="flex-grow: 1;"></div>
    <div class="cover-meta">
      Generated automatically on ${new Date().toLocaleDateString()}<br>
      Total Articles: ${filteredArticles.length}
    </div>
  </div>

  <!-- Table of Contents -->
  <div class="toc-page">
    <div class="toc-title">Table of Contents</div>
    <ul class="toc-list">
  `;

  filteredArticles.forEach((art, index) => {
    htmlContent += `
      <li class="toc-item">
        <a class="toc-link" href="#article-${index + 1}">${index + 1}. ${art.title}</a>
        <span style="font-family: sans-serif; font-size: 12px; color: #666;">by ${art.author}</span>
      </li>
    `;
  });

  htmlContent += `
    </ul>
  </div>

  <!-- Articles Content -->
  `;

  filteredArticles.forEach((art, index) => {
    htmlContent += `
  <div class="article-container" id="article-${index + 1}">
    <h2 class="article-title">${index + 1}. ${art.title}</h2>
    <div class="article-meta">
      <span><strong>Author:</strong> ${art.author}</span>
      <span><strong>Published:</strong> ${art.date}</span>
      <span><strong>Link:</strong> <a class="article-link" href="${art.url}" target="_blank">View Original</a></span>
    </div>
    <div class="article-body">
      ${art.content.split('\n\n').map(para => `<p>${para.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`).join('\n      ')}
    </div>
  </div>
    `;
  });

  htmlContent += `
</body>
</html>
  `;

  // 5. Ensure digests directory exists
  if (!fs.existsSync(DIGESTS_DIR)) {
    fs.mkdirSync(DIGESTS_DIR, { recursive: true });
    console.log(`[+] Created output directory: ${DIGESTS_DIR}`);
  }

  const tempHtmlFile = path.join(DIGESTS_DIR, `temp-${targetMonth}.html`);
  fs.writeFileSync(tempHtmlFile, htmlContent, 'utf-8');

  // 6. Print PDF using Puppeteer
  const pdfFilename = `Project-Syndicate-Digest-${targetMonth}.pdf`;
  const pdfPath = path.join(DIGESTS_DIR, pdfFilename);

  console.log('[+] Launching Puppeteer to export PDF...');
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  try {
    const page = await browser.newPage();
    // Load local HTML file
    await page.goto(`file://${tempHtmlFile}`, { waitUntil: 'networkidle0' });

    console.log('[+] Generating PDF layout...');
    await page.pdf({
      path: pdfPath,
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: `<div style="font-size: 8px; font-family: Arial, sans-serif; width: 100%; text-align: center; color: #888; border-bottom: 1px solid #ddd; padding-bottom: 5px; margin-left: 40px; margin-right: 40px;">Project Syndicate Commentary Digest — ${prettyMonthTitle}</div>`,
      footerTemplate: `<div style="font-size: 8px; font-family: Arial, sans-serif; width: 100%; text-align: right; color: #888; border-top: 1px solid #ddd; padding-top: 5px; padding-right: 40px; margin-left: 40px;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>`,
      margin: {
        top: '60px',
        bottom: '60px',
        left: '40px',
        right: '40px'
      }
    });

    console.log(`[+] PDF successfully created and saved to: ${pdfPath}`);
  } catch (err) {
    console.error('[-] Error generating PDF:', err.message);
  } finally {
    await browser.close();
    // Delete temp HTML file
    try {
      if (fs.existsSync(tempHtmlFile)) {
        fs.unlinkSync(tempHtmlFile);
      }
    } catch (cleanupErr) {
      console.warn('[-] Warning: Could not clean up temporary HTML file:', cleanupErr.message);
    }
  }
}

compileDigest()
  .then(() => {
    console.log('[+] Compiler job finished.');
    process.exit(0);
  })
  .catch(err => {
    console.error('[-] Unhandled exception in compiler:', err.message);
    process.exit(1);
  });
