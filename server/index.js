import express from 'express';
import cors from 'cors';
import axios from 'axios';
import Parser from 'rss-parser';
import * as cheerio from 'cheerio';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { calculateRelevanceScore, mapSyllabus, matchPastQuestions } from './scoringEngine.js';
import { getRedisKey, setRedisKey } from './redis.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 5000;

app.use(cors());
app.use(express.json());

const parser = new Parser({
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  }
});

// Paths to data stores
const CURATED_FILE = path.join(__dirname, 'curatedData.json');
const NOTES_FILE = path.join(__dirname, 'notes.json');
const FEEDBACK_FILE = path.join(__dirname, 'feedback.json');

// Helper to safely write JSON data in read-only environments (like Vercel)
function safeWriteJsonFile(filePath, data) {
  try {
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
    return true;
  } catch (err) {
    console.warn(`[!] Warning: Failed to write JSON to ${filePath} (Read-only filesystem?):`, err.message);
    return false;
  }
}

// Ensure notes.json exists
try {
  if (!fs.existsSync(NOTES_FILE)) {
    fs.writeFileSync(NOTES_FILE, JSON.stringify([]));
  }
} catch (e) {
  console.warn('[!] Warning: Could not write/ensure notes.json locally:', e.message);
}

// Ensure feedback.json exists
try {
  if (!fs.existsSync(FEEDBACK_FILE)) {
    fs.writeFileSync(FEEDBACK_FILE, JSON.stringify([]));
  }
} catch (e) {
  console.warn('[!] Warning: Could not write/ensure feedback.json locally:', e.message);
}

// Scrape full-text parser rules for different websites
async function scrapeFullText(url, source) {
  try {
    const response = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.5'
      },
      timeout: 10000
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
    } else if (source === 'The News') {
      $('.story-detail-content p, .story-text p, .detail-preview p').each((i, el) => {
        paragraphs.push($(el).text().trim());
      });
    } else if (source === 'The Friday Times') {
      $('.entry-content p, .story-content p').each((i, el) => {
        paragraphs.push($(el).text().trim());
      });
    }

    // Clean up empty lines or ads
    paragraphs = paragraphs.filter(p => p.length > 30 && !p.toLowerCase().includes('follow us on') && !p.toLowerCase().includes('read more:'));
    
    return paragraphs.join('\n\n');
  } catch (error) {
    console.error(`Error scraping full text from ${url}:`, error.message);
    return null;
  }
}

// Main RSS Aggregator
app.get('/api/articles', async (req, res) => {
  try {
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

    const allArticles = [];

    // Loop through feeds and parse
    for (const feed of feeds) {
      try {
        console.log(`Fetching feed: ${feed.source} from ${feed.url}`);
        const parsed = await parser.parseURL(feed.url);
        
        parsed.items.forEach(item => {
          const link = item.link || '';
          if (feed.filter(link)) {
            const contentSnippet = item.contentSnippet || item.content || '';
            const author = item.creator || item.author || 'Editorial';
            const title = item.title || 'Untitled Article';
            
            // Calculate a preliminary score based on snippet
            const preScore = calculateRelevanceScore(title, author, contentSnippet);
            
            const mapping = mapSyllabus(title, contentSnippet);

            allArticles.push({
              title,
              link,
              pubDate: item.pubDate || new Date().toISOString(),
              author,
              source: feed.source,
              snippet: contentSnippet,
              relevanceScore: preScore,
              paper: mapping.paper,
              topic: mapping.topic
            });
          }
        });
      } catch (err) {
        console.error(`Failed to parse feed ${feed.source}:`, err.message);
      }
    }

    // Sort by relevance score desc
    allArticles.sort((a, b) => b.relevanceScore - a.relevanceScore);

    res.json(allArticles);
  } catch (error) {
    console.error('Error fetching articles:', error.message);
    res.status(500).json({ error: 'Internal Server Error', details: error.message });
  }
});

// Retrieve curated / recommended articles list
app.get('/api/recommendations', async (req, res) => {
  try {
    // 1. Try Redis first
    const curated = await getRedisKey('css:curated');
    if (curated) {
      return res.json(curated);
    }
    
    // 2. Fallback to local file
    if (fs.existsSync(CURATED_FILE)) {
      const fileData = JSON.parse(fs.readFileSync(CURATED_FILE, 'utf-8'));
      res.json(fileData);
    } else {
      res.json([]);
    }
  } catch (error) {
    console.error('Error fetching recommendations:', error.message);
    res.status(500).json({ error: 'Error reading curated database', details: error.message });
  }
});

// Scraping the full text for reading mode
app.post('/api/articles/scrape', async (req, res) => {
  const { url, source } = req.body;
  if (!url || !source) {
    return res.status(400).json({ error: 'URL and Source are required' });
  }

  console.log(`Scraping full text requested for: ${url} (${source})`);
  const fullText = await scrapeFullText(url, source);
  
  if (fullText) {
    res.json({ fullText });
  } else {
    // If scraper fails, send back a mock text alert
    res.status(500).json({ error: 'Failed to scrape full text from original article' });
  }
});

// Notes CRUD
app.get('/api/notes', async (req, res) => {
  try {
    let notes = await getRedisKey('css:notes');
    if (!notes) {
      notes = fs.existsSync(NOTES_FILE) ? JSON.parse(fs.readFileSync(NOTES_FILE, 'utf-8')) : [];
    }
    res.json(notes);
  } catch (error) {
    console.error('Error fetching notes:', error.message);
    res.status(500).json({ error: 'Error reading notes' });
  }
});

app.post('/api/notes', async (req, res) => {
  try {
    let notes = await getRedisKey('css:notes');
    if (!notes) {
      notes = fs.existsSync(NOTES_FILE) ? JSON.parse(fs.readFileSync(NOTES_FILE, 'utf-8')) : [];
    }
    const newNote = {
      id: Date.now().toString(),
      title: req.body.title || 'Untitled Note',
      articleTitle: req.body.articleTitle || 'Self Outline',
      articleUrl: req.body.articleUrl || '',
      content: req.body.content || '',
      createdAt: new Date().toISOString()
    };
    notes.push(newNote);
    
    // Save to Redis or fallback to file
    const savedRedis = await setRedisKey('css:notes', notes);
    if (!savedRedis) {
      safeWriteJsonFile(NOTES_FILE, notes);
    }
    
    res.status(201).json(newNote);
  } catch (error) {
    console.error('Error saving note:', error.message);
    res.status(500).json({ error: 'Error saving note' });
  }
});

app.put('/api/notes/:id', async (req, res) => {
  try {
    let notes = await getRedisKey('css:notes');
    if (!notes) {
      notes = fs.existsSync(NOTES_FILE) ? JSON.parse(fs.readFileSync(NOTES_FILE, 'utf-8')) : [];
    }
    const index = notes.findIndex(n => n.id === req.params.id);
    if (index !== -1) {
      notes[index] = {
        ...notes[index],
        title: req.body.title || notes[index].title,
        content: req.body.content || notes[index].content,
        updatedAt: new Date().toISOString()
      };
      
      const savedRedis = await setRedisKey('css:notes', notes);
      if (!savedRedis) {
        safeWriteJsonFile(NOTES_FILE, notes);
      }
      
      res.json(notes[index]);
    } else {
      res.status(404).json({ error: 'Note not found' });
    }
  } catch (error) {
    console.error('Error updating note:', error.message);
    res.status(500).json({ error: 'Error updating note' });
  }
});

app.delete('/api/notes/:id', async (req, res) => {
  try {
    let notes = await getRedisKey('css:notes');
    if (!notes) {
      notes = fs.existsSync(NOTES_FILE) ? JSON.parse(fs.readFileSync(NOTES_FILE, 'utf-8')) : [];
    }
    const filtered = notes.filter(n => n.id !== req.params.id);
    
    const savedRedis = await setRedisKey('css:notes', filtered);
    if (!savedRedis) {
      safeWriteJsonFile(NOTES_FILE, filtered);
    }
    
    res.json({ success: true });
  } catch (error) {
    console.error('Error deleting note:', error.message);
    res.status(500).json({ error: 'Error deleting note' });
  }
});

// Feedback System endpoints
app.post('/api/feedback', async (req, res) => {
  const { articleId, isRelevant, title, url, paper, topic } = req.body;
  if (!articleId) {
    return res.status(400).json({ error: 'Missing articleId' });
  }

  try {
    // 1. Log feedback event
    let feedbacks = await getRedisKey('css:feedback');
    if (!feedbacks) {
      feedbacks = fs.existsSync(FEEDBACK_FILE) ? JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf-8')) : [];
    }
    
    const newFeedback = {
      articleId,
      title: title || 'Untitled',
      url: url || '',
      paper: paper || 'Unknown',
      topic: topic || 'Unknown',
      isRelevant: !!isRelevant,
      timestamp: new Date().toISOString()
    };
    feedbacks.push(newFeedback);
    
    const savedRedisFeedback = await setRedisKey('css:feedback', feedbacks);
    if (!savedRedisFeedback) {
      safeWriteJsonFile(FEEDBACK_FILE, feedbacks);
    }

    // 2. Increment upvotes/downvotes inside curatedData
    let curated = await getRedisKey('css:curated');
    if (!curated) {
      curated = fs.existsSync(CURATED_FILE) ? JSON.parse(fs.readFileSync(CURATED_FILE, 'utf-8')) : [];
    }

    const index = curated.findIndex(art => art.id === articleId);
    if (index !== -1) {
      if (!curated[index].upvotes) curated[index].upvotes = 0;
      if (!curated[index].downvotes) curated[index].downvotes = 0;
      
      if (isRelevant) {
        curated[index].upvotes += 1;
      } else {
        curated[index].downvotes += 1;
      }

      const savedRedisCurated = await setRedisKey('css:curated', curated);
      if (!savedRedisCurated) {
        safeWriteJsonFile(CURATED_FILE, curated);
      }
      
      res.json({ success: true, upvotes: curated[index].upvotes, downvotes: curated[index].downvotes });
    } else {
      res.json({ success: true, message: 'Feedback logged, but article not found in recommendations.' });
    }
  } catch (error) {
    console.error('Error logging feedback:', error.message);
    res.status(500).json({ error: 'Error logging feedback', details: error.message });
  }
});

app.get('/api/feedback', async (req, res) => {
  try {
    let feedbacks = await getRedisKey('css:feedback');
    if (!feedbacks) {
      feedbacks = fs.existsSync(FEEDBACK_FILE) ? JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf-8')) : [];
    }
    res.json(feedbacks);
  } catch (error) {
    console.error('Error reading feedback logs:', error.message);
    res.status(500).json({ error: 'Error reading feedback logs' });
  }
});

// Gemini connection test endpoint
app.post('/api/gemini/test', async (req, res) => {
  const { key } = req.body;
  if (!key) {
    return res.status(400).json({ error: 'API key is required' });
  }

  try {
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${key}`,
      {
        contents: [{ parts: [{ text: 'Hello' }] }]
      },
      {
        headers: { 'Content-Type': 'application/json' }
      }
    );
    res.json({ success: true });
  } catch (error) {
    console.error('Gemini connection test failed:', error.message);
    const errorMessage = error.response?.data?.error?.message || error.message || 'Network error connecting to Google AI API';
    res.status(error.response?.status || 500).json({ error: errorMessage });
  }
});

// Gemini article curation endpoint
app.post('/api/gemini/curate', async (req, res) => {
  const { key, article, content } = req.body;
  if (!key || !article || !content) {
    return res.status(400).json({ error: 'Missing required parameters: key, article, or content' });
  }

  const matchedQuestion = matchPastQuestions(article.title, content);
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
  }

  const prompt = `
You are an expert Competitive Exams examiner and syllabus developer.
Analyze the following editorial/opinion article from a Pakistani newspaper for a civil service aspirant:

Article Title: "${article.title}"
Author: "${article.author}"
Source: "${article.source}"
Article Content:
"""
${content}
"""
${pastQuestionPromptFragment}
Evaluate this article against the competitive examination syllabus. You are a strict, critical civil service examiner grading essays. Be highly selective; most standard columns should score below 75 (not suitable). Calculate a Relevance Score (0-100) using these strict criteria:

1. Syllabus Precision & Past-Paper Trend Alignment (Max 30 points):
   - Score 30 ONLY if the article maps directly to core syllabus papers AND explicitly addresses a post-2016 past paper trend (e.g. SIFC investment council, 18th Amendment / NFC Award devolution, BRICS/SCO expansion vs US global dominance, maritime Indo-Pacific/QUAD/AUKUS geopolitics, climate summit roadmaps like COP28/COP29, transboundary water conflicts, hybrid/fifth-generation warfare, or nuclear strategic stability in South Asia).
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
      "front": "A clear, conceptual question about a key argument, fact, or policy suggestion in the article.",
      "back": "The concise, accurate answer based on the article's text."
    },
    {
      "front": "Another key question...",
      "back": "Another concise answer..."
    },
    {
      "front": "Another key question...",
      "back": "Another concise answer..."
    },
    {
      "front": "Another key question...",
      "back": "Another concise answer..."
    }
  ]
}
Return ONLY valid JSON. Do not include markdown code block formatting (do NOT wrap in \`\`\`json).
`;

  try {
    const model = process.env.GEMINI_MODEL || 'gemini-1.5-flash';
    const response = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`,
      {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json" }
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 45000
      }
    );

    const text = response.data.candidates[0].content.parts[0].text;
    const result = JSON.parse(text.trim());
    if (result.suitable && result.relevanceScore < 75) {
      result.suitable = false;
    }
    
    // Attach matchedQuestion to return object
    result.matchedQuestion = matchedQuestion ? {
      id: matchedQuestion.id,
      paper: matchedQuestion.paper,
      year: matchedQuestion.year,
      question: matchedQuestion.question
    } : null;

    res.json(result);
  } catch (error) {
    console.error('Gemini curation failed:', error.message);
    const errorMessage = error.response?.data?.error?.message || error.message || 'Network error during AI curation';
    res.status(error.response?.status || 500).json({ error: errorMessage });
  }
});

app.listen(PORT, () => {
  console.log(`Civil Digest backend running on http://localhost:${PORT}`);
});
