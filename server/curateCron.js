import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import Parser from 'rss-parser';
import * as cheerio from 'cheerio';
import { calculateRelevanceScore, mapSyllabus, matchPastQuestions } from './scoringEngine.js';
import { getRedisKey, setRedisKey } from './redis.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const CURATED_FILE = path.join(__dirname, 'curatedData.json');
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GEMINI_API_KEY) {
  console.error('CRITICAL: GEMINI_API_KEY environment variable is not set. Exiting.');
  process.exit(1);
}

const parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  }
});

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// Scrape full-text parser rules
async function scrapeFullText(url, source) {
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5',
        'Referer': 'https://www.google.com/'
      },
      timeout: 15000
    });

    const $ = cheerio.load(response.data);
    let paragraphs = [];

    if (source === 'Dawn') {
      $('.story__content p').each((i, el) => {
        paragraphs.push($(el).text().trim());
      });
    } else if (source === 'Express Tribune') {
      $('.story-text p').each((i, el) => {
        paragraphs.push($(el).text().trim());
      });
      if (paragraphs.length === 0) {
        $('.post-content p').each((i, el) => {
          paragraphs.push($(el).text().trim());
        });
      }
    }

    // Clean up empty lines or obvious ads/sharing prompts
    paragraphs = paragraphs.filter(p =>
      p.length > 30 &&
      !p.toLowerCase().includes('follow us on') &&
      !p.toLowerCase().includes('read more:') &&
      !p.toLowerCase().includes('twitter')
    );

    return paragraphs.join('\n\n');
  } catch (error) {
    console.error(`[-] Error scraping full text from ${url}:`, error.message);
    return null;
  }
}

// Helper to call Google Gemini API with retries and exponential backoff
async function callGemini(prompt, title) {
  let success = false;
  let retries = 3;
  let backoff = 45000; // 45 seconds initial backoff
  let resultText = null;

  const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';

  while (retries > 0 && !success) {
    try {
      const response = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`,
        {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json" }
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 45000
        }
      );

      resultText = response.data.candidates[0].content.parts[0].text;
      success = true;
    } catch (apiError) {
      retries--;
      const status = apiError.response?.status;
      console.error(`[-] Gemini API call failed for "${title}" (Status: ${status || 'Network Error'}, Message: ${apiError.message}). Retries remaining: ${retries}`);

      if (retries > 0) {
        console.log(`[+] Rate limit or API error encountered. Waiting ${backoff / 1000} seconds before retrying...`);
        await delay(backoff);
        backoff *= 2; // exponential backoff (45s -> 90s)
      } else {
        console.error(`[-] Max retries reached for "${title}".`);
      }
    }
  }
  return resultText;
}

// Core Curation Engine
async function runCuration() {
  console.log('[+] Starting Civil Digest background curation job...');

  // 1. Read existing curated database (Redis with local file fallback)
  let curatedList = [];
  try {
    const redisCurated = await getRedisKey('css:curated');
    if (redisCurated) {
      curatedList = redisCurated;
      console.log(`[+] Read ${curatedList.length} articles from Upstash Redis.`);
    } else if (fs.existsSync(CURATED_FILE)) {
      curatedList = JSON.parse(fs.readFileSync(CURATED_FILE, 'utf-8'));
      console.log(`[+] Read ${curatedList.length} articles from local database.`);
    }
  } catch (e) {
    console.error('[-] Error reading existing curated database:', e.message);
  }

  // Set of existing URLs to avoid duplicates
  const existingUrls = new Set(curatedList.map(item => item.url));

  // 2. Define feeds
  const feeds = [
    {
      source: 'Dawn',
      url: 'https://www.dawn.com/feeds/opinion',
      filter: () => true
    },
    {
      source: 'Dawn',
      url: 'https://www.dawn.com/feeds/home',
      filter: (link) => link.includes('/opinion/') || link.includes('/editorial/')
    },
    {
      source: 'Express Tribune',
      url: 'https://tribune.com.pk/opinion/feed',
      filter: () => true
    }
  ];

  // 3. Fetch feeds and compile candidates
  const candidates = [];
  const addedUrls = new Set();

  for (const feed of feeds) {
    try {
      console.log(`[+] Fetching RSS feed: ${feed.source} from ${feed.url}`);
      const parsed = await parser.parseURL(feed.url);

      for (const item of parsed.items) {
        const link = item.link || '';
        if (feed.filter(link) && !existingUrls.has(link) && !addedUrls.has(link)) {
          addedUrls.add(link);
          candidates.push({
            title: item.title || 'Untitled Article',
            link,
            pubDate: item.pubDate || new Date().toISOString(),
            author: item.creator || item.author || 'Editorial',
            source: feed.source,
            snippet: item.contentSnippet || item.content || ''
          });
        }
      }
    } catch (err) {
      console.error(`[-] Failed to parse feed ${feed.source}:`, err.message);
    }
  }

  // Calculate heuristic score for each candidate to sort/pre-filter
  candidates.forEach(cand => {
    cand.heuristicScore = calculateRelevanceScore(cand.title, cand.author, cand.snippet || cand.title);
  });

  // Pre-filter candidates: only keep articles with at least 40% heuristic relevance
  // This screens out articles with zero syllabus keywords, author watchlist matches, or solutions
  const relevantCandidates = candidates.filter(cand => cand.heuristicScore >= 40);

  // Sort candidates by heuristic score descending so the most syllabus-aligned are processed first
  relevantCandidates.sort((a, b) => b.heuristicScore - a.heuristicScore);

  // Cap candidates to evaluate to top 40 to prevent excessive rate-limiting/API usage
  const capLimit = 40;
  const processedCandidates = relevantCandidates.slice(0, capLimit);
  console.log(`[+] Compiled candidates. Pre-filtered and capped to top ${processedCandidates.length} highest heuristic-scoring articles (>=40%) out of ${candidates.length} total options.`);

  if (processedCandidates.length === 0) {
    console.log('[+] No new articles to process. Exiting.');
    return;
  }

  let successCount = 0;
  const newCuratedArticles = [];

  // 4. Process each candidate sequentially
  for (let i = 0; i < processedCandidates.length; i++) {
    const candidate = processedCandidates[i];
    console.log(`\n[+] Processing [${i + 1}/${processedCandidates.length}]: "${candidate.title}" (Heuristic Relevance: ${candidate.heuristicScore}%, Source: ${candidate.source})`);

    // Polite delay between scrapes (except the first one)
    if (i > 0) {
      console.log('[+] Sleeping for 60 seconds to respect rate limits...');
      await delay(60000);
    }

    // A. Scrape full content
    let fullText = await scrapeFullText(candidate.link, candidate.source);
    if (!fullText || fullText.length < 300) {
      console.warn(`[-] Scraper failed or was blocked for "${candidate.title}". Falling back to RSS feed snippet.`);
      fullText = candidate.snippet;
    }

    if (!fullText || fullText.length < 50) {
      console.warn(`[-] Skipping "${candidate.title}": no usable content snippet available.`);
      continue;
    }

    console.log(`[+] Scraped ${fullText.length} characters. Running Stage 1 Curation evaluation...`);

    // B. Match candidate to past papers
    const matchedQuestion = matchPastQuestions(candidate.title, fullText);
    let pastQuestionPromptFragment = "";
    if (matchedQuestion) {
      pastQuestionPromptFragment = `
CRITICAL DIRECTIVE:
This article matches the following Past Exam Question:
- Paper: ${matchedQuestion.paper}
- Year: ${matchedQuestion.year}
- Question: "${matchedQuestion.question}"

Evaluate the article specifically on how it helps a student address this exact past exam question.
`;
      console.log(`[+] Direct match found with past exam question: ${matchedQuestion.id}`);
    }

    // Stage 1 Prompt: Lightweight Suitability Check
    const stage1Prompt = `
You are an expert Competitive Exams examiner and policy analyst.
Analyze the following editorial/opinion article to determine if it is suitable for civil service aspirants:

Article Title: "${candidate.title}"
Author: "${candidate.author}"
Source: "${candidate.source}"
Article Content Snippet:
"""
${fullText.substring(0, 8000)}
"""

Evaluate this article against the competitive examination syllabus. You are a strict examiner. Be highly selective; most standard columns should score below 75 (not suitable). Calculate a Relevance Score (0-100) using these strict criteria:

1. Syllabus Precision & Past-Paper Trend Alignment (Max 30 points)
2. Data & Fact Density (Max 20 points)
3. Analytical Depth & Transition (Max 25 points)
4. Actionable Policy Remedies (Max 15 points)
5. Author Credibility (Max 10 points)

CRITICAL RULES:
- If the final score is less than 75, or if the article is about local political party bickering/infighting, set "suitable" to false.
- A standard, average column should score between 50 and 65. Only 2 to 3 articles per week should score above 80.

Return a JSON object with this exact structure:
{
  "suitable": true/false,
  "relevanceScore": 0-100,
  "reason": "One sentence summary of the suitability decision."
}
Return ONLY valid JSON. Do not include markdown code block formatting (do NOT wrap in \`\`\`json).
`;

    const stage1ResultText = await callGemini(stage1Prompt, candidate.title);
    if (!stage1ResultText) {
      console.warn(`[-] Skipping "${candidate.title}" due to Gemini Stage 1 API failure.`);
      continue;
    }

    let stage1Result = null;
    try {
      stage1Result = JSON.parse(stage1ResultText.trim());
    } catch (e) {
      console.error(`[-] Failed to parse Stage 1 JSON for "${candidate.title}":`, e.message);
      continue;
    }

    if (!stage1Result.suitable || stage1Result.relevanceScore < 75) {
      console.log(`[-] Article marked UNSUITABLE (Score: ${stage1Result.relevanceScore}%). Reason: ${stage1Result.reason || 'Syllabus mismatch'}. Skipping.`);
      continue;
    }

    console.log(`[+] Article is SUITABLE (Score: ${stage1Result.relevanceScore}%). Proceeding to Stage 2 study aid generation...`);

    // Stage 2 Prompt: Detailed Resource Generation
    const stage2Prompt = `
You are an expert Competitive Exams examiner and syllabus developer.
For this highly relevant article, generate detailed study aids for civil service aspirants:

Article Title: "${candidate.title}"
Author: "${candidate.author}"
Source: "${candidate.source}"
Article Content:
"""
${fullText}
"""
${pastQuestionPromptFragment}

Provide detailed study resources matching the competitive examination syllabus.

Return a JSON object with this exact structure:
{
  "paper": "e.g. Pakistan Affairs / Economics",
  "topic": "e.g. CPEC and Debt Restructuring",
  "whyMatters": "Explain in 2 sentences why a competitive exam student must quote this article.",
  "summary": [
    "Core argument 1",
    "Core argument 2",
    "Core argument 3",
    "Core argument 4"
  ],
  "facts": [
    "Critical data point/stat 1",
    "Critical data point/stat 2",
    "Critical data point/stat 3"
  ],
  "academicReferences": [
    "High-scoring citation (e.g., Andrew Small's 'The China-Pakistan Axis')",
    "High-scoring treaty/report (e.g., 18th Amendment / NFC Award)",
    "High-scoring global policy (e.g., COP29 Baku Roadmap)"
  ],
  "vocabulary": [
    {
      "word": "difficult word",
      "type": "adjective/noun/verb",
      "definition": "simple meaning",
      "sentence": "usage in sentence"
    }
  ],
  "quiz": [
    {
      "question": "Question 1",
      "options": ["A", "B", "C", "D"],
      "answerIndex": 0,
      "explanation": "Why this is correct"
    }
  ],
  "flashcards": [
    {
      "front": "A clear, conceptual question about a key argument, fact, or policy suggestion in the article. Do NOT ask about vocabulary, word meanings, or dictionary definitions (focus only on conceptual analysis).",
      "back": "The concise, accurate answer based on the article's text."
    },
    {
      "front": "Another key conceptual question",
      "back": "Another concise answer..."
    },
    {
      "front": "Another key conceptual question",
      "back": "Another concise answer..."
    },
    {
      "front": "Another key conceptual question",
      "back": "Another concise answer..."
    }
  ]
}
Return ONLY valid JSON. Do not include markdown code block formatting (do NOT wrap in \`\`\`json).
`;

    const stage2ResultText = await callGemini(stage2Prompt, candidate.title);
    if (!stage2ResultText) {
      console.warn(`[-] Skipping "${candidate.title}" due to Gemini Stage 2 API failure.`);
      continue;
    }

    let stage2Result = null;
    try {
      stage2Result = JSON.parse(stage2ResultText.trim());
    } catch (e) {
      console.error(`[-] Failed to parse Stage 2 JSON for "${candidate.title}":`, e.message);
      continue;
    }

    console.log(`[+] Curation details successfully generated. Adding to database.`);
    const newArticle = {
      id: `curated-${Date.now()}-${Math.floor(Math.random() * 1000)}`,
      title: candidate.title,
      source: candidate.source,
      url: candidate.link,
      date: new Date(candidate.pubDate).toISOString().split('T')[0],
      author: candidate.author,
      content: fullText,
      matchedQuestion: matchedQuestion ? {
        id: matchedQuestion.id,
        paper: matchedQuestion.paper,
        year: matchedQuestion.year,
        question: matchedQuestion.question
      } : null,
      suitable: true,
      relevanceScore: stage1Result.relevanceScore,
      ...stage2Result
    };
    newCuratedArticles.push(newArticle);
    successCount++;
  }

  // 5. Save if we have new curated articles
  if (newCuratedArticles.length > 0) {
    // Combine new with existing
    let updatedCuratedList = [...newCuratedArticles, ...curatedList];

    // Sort by date descending, then score descending
    updatedCuratedList.sort((a, b) => {
      const dateA = new Date(a.date);
      const dateB = new Date(b.date);
      if (dateA.getTime() !== dateB.getTime()) {
        return dateB - dateA;
      }
      return b.relevanceScore - a.relevanceScore;
    });

    // Enforce size limit to keep file lightweight (max 100 articles)
    if (updatedCuratedList.length > 100) {
      console.log(`[+] Capping curated list from ${updatedCuratedList.length} items to 100 items.`);
      updatedCuratedList = updatedCuratedList.slice(0, 100);
    }

    try {
      // Sync with Upstash Redis
      const savedRedis = await setRedisKey('css:curated', updatedCuratedList);
      if (savedRedis) {
        console.log('[+] Curated database successfully pushed to Upstash Redis.');
      }

      // Save locally as fallback and for git backups
      fs.writeFileSync(CURATED_FILE, JSON.stringify(updatedCuratedList, null, 2), 'utf-8');
      console.log(`\n[+] Successfully saved ${successCount} new curated articles locally!`);
    } catch (saveError) {
      console.error('[-] Failed to save curated database (Redis/File):', saveError.message);
    }
  } else {
    console.log('\n[+] Curation finished. No new suitable articles added today.');
  }
}

// Run the script
runCuration()
  .then(() => {
    console.log('[+] Curation run completed successfully. Exiting.');
    process.exit(0);
  })
  .catch(err => {
    console.error('[-] Curation process encountered an unhandled error:', err.message);
    process.exit(1);
  });
