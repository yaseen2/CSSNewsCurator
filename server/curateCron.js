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

// Core Curation Engine
async function runCuration() {
  console.log('[+] Starting CSS Aggregator background curation job...');
  
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

  // Sort candidates by heuristic score descending so the most syllabus-aligned are processed first
  candidates.sort((a, b) => b.heuristicScore - a.heuristicScore);

  // Cap candidates to evaluate to top 8 to prevent excessive rate-limiting/API usage
  const capLimit = 8;
  const processedCandidates = candidates.slice(0, capLimit);
  console.log(`[+] Compiled candidates. Pre-filtered and capped to top ${processedCandidates.length} highest heuristic-scoring articles out of ${candidates.length} total options.`);

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
      console.log('[+] Sleeping for 10 seconds to respect rate limits...');
      await delay(10000);
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

    console.log(`[+] Scraped ${fullText.length} characters. Evaluating via Gemini API...`);

    // B. Match candidate to past papers
    const matchedQuestion = matchPastQuestions(candidate.title, fullText);
    let pastQuestionPromptFragment = "";
    if (matchedQuestion) {
      pastQuestionPromptFragment = `
CRITICAL DIRECTIVE:
This article matches the following CSS Past Exam Question:
- Paper: ${matchedQuestion.paper}
- Year: ${matchedQuestion.year}
- Question: "${matchedQuestion.question}"

Evaluate the article specifically on how it helps a student address this exact past exam question.
`;
      console.log(`[+] Direct match found with past exam question: ${matchedQuestion.id}`);
    }

    // C. Send to Gemini for detailed evaluation
    const prompt = `
You are an expert CSS (Central Superior Services of Pakistan) examiner and syllabus developer.
Analyze the following editorial/opinion article from a Pakistani newspaper for a CSS aspirant:

Article Title: "${candidate.title}"
Author: "${candidate.author}"
Source: "${candidate.source}"
Article Content:
"""
${fullText}
"""
${pastQuestionPromptFragment}
Evaluate this article against the CSS examination syllabus. You are a strict, critical CSS examiner grading essays. Be highly selective; most standard columns should score below 75 (not suitable). Calculate a CSS Score (0-100) using these strict criteria:

1. Syllabus Precision & Past-Paper Trend Alignment (Max 30 points):
   - Score 30 ONLY if the article maps directly to core CSS papers AND explicitly addresses a post-2016 CSS past paper trend (e.g. SIFC investment council, 18th Amendment / NFC Award devolution, BRICS/SCO expansion vs US global dominance, maritime Indo-Pacific/QUAD/AUKUS geopolitics, climate summit roadmaps like COP28/COP29, transboundary water conflicts, hybrid/fifth-generation warfare, or nuclear strategic stability in South Asia).
   - Score 15 if it is a general, generic current affairs discussion (e.g., general bilateral relations, inflation overview) that a student already knows.
   - Score 0 if it is about temporary events, local political disputes (party clashes), or personal memoirs/stories.

2. Data & Fact Density (Max 20 points):
   - Score 20 if the article provides concrete figures, stats (e.g., GDP percentages, debt numbers), specific dates, or references to treaties/acts that a student can quote in their exam.
   - Score 0 if the article has general arguments and opinions without hard data.

3. Analytical Depth & Transition (Max 25 points):
   - Score 25 if the article explains systemic/root causes (why the problem exists) and uses rigorous, analytical reasoning.
   - Score 10 if it is mostly descriptive (just explaining what happened).
   - Score 0 if it is emotionally biased, uses sensationalist language, or lacks logical reasoning.

4. Actionable Policy Remedies (Max 15 points):
   - Score 15 if it outlines a structured, step-by-step policy recommendation or a concrete "way forward".
   - Score 0 if it only criticizes without offering constructive solutions.

5. Author Credibility (Max 10 points):
   - Score 10 if the author is a renowned policy expert/columnist (e.g., Maleeha Lodhi, Munir Akram, Khurram Husain, Sakib Sherani, Zahid Hussain, Reema Omer). Score 5 for standard guest columns or editorials.

CRITICAL RULES:
- If the final score is less than 75, or if the article is about local political party bickering/infighting, set "suitable" to false.
- Be extremely critical. Do not give high scores unless the article is rich in facts, statistics, and structural solutions. A standard, average column should score between 50 and 65. Only 2 to 3 articles per week should score above 80.

Return a JSON object with this exact structure:
{
  "suitable": true/false,
  "relevanceScore": 0-100,
  "paper": "e.g. Pakistan Affairs / Economics",
  "topic": "e.g. CPEC and Debt Restructuring",
  "whyMatters": "Explain in 2 sentences why a CSS student must quote this article.",
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
  "examOutline": {
    "question": "The focus exam question being answered (use the matched question above if provided, or generate a high-yield CSS past-paper style question based on this article)",
    "outline": [
      "I. Introduction (with a strong thesis statement mapping the main arguments)",
      "II. Historical Context & Structural Constraints of the issue",
      "III. Core Analytical Dimension A (incorporate key facts/data from the article)",
      "IV. Core Analytical Dimension B (systemic/root causes analysis)",
      "V. Pragmatic Policy Recommendations / Way Forward",
      "VI. Conclusion (futuristic re-assertion of the thesis)"
    ]
  }
}
Return ONLY valid JSON. Do not include markdown code block formatting (do NOT wrap in \`\`\`json).
`;

    try {
      const geminiResponse = await axios.post(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`,
        {
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { responseMimeType: "application/json" }
        },
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 45000
        }
      );

      const responseText = geminiResponse.data.candidates[0].content.parts[0].text;
      const evaluationResult = JSON.parse(responseText.trim());

      if (evaluationResult.suitable && evaluationResult.relevanceScore >= 75) {
        console.log(`[+] Article is SUITABLE for CSS (Score: ${evaluationResult.relevanceScore}%). Adding to database.`);
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
          ...evaluationResult
        };
        newCuratedArticles.push(newArticle);
        successCount++;
      } else {
        console.log(`[-] Article marked UNSUITABLE (Score: ${evaluationResult.relevanceScore}%). Skipping.`);
      }
    } catch (apiError) {
      console.error(`[-] Gemini curation API call failed for "${candidate.title}":`, apiError.message);
      // Wait extra time in case we hit rate limits or transient errors
      await delay(5000);
    }
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
      console.log(`\n[+] Successfully saved ${successCount} new CSS curated articles locally!`);
    } catch (saveError) {
      console.error('[-] Failed to save curated database (Redis/File):', saveError.message);
    }
  } else {
    console.log('\n[+] Curation finished. No new suitable articles added today.');
  }
}

// Run the script
runCuration().catch(err => {
  console.error('[-] Curation process encountered an unhandled error:', err.message);
  process.exit(1);
});
