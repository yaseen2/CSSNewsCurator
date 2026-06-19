import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import axios from 'axios';
import { getRedisKey } from './redis.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const FEEDBACK_FILE = path.join(__dirname, 'feedback.json');
const SCORING_ENGINE_FILE = path.join(__dirname, 'scoringEngine.js');
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

async function refineTaxonomy() {
  console.log('[+] Starting AI Taxonomy Optimization Job...');
  
  if (!GEMINI_API_KEY) {
    console.error('[-] Error: GEMINI_API_KEY environment variable is missing. Cannot optimize.');
    return;
  }

  // 1. Load feedback logs
  let feedbacks = [];
  try {
    const redisFeedback = await getRedisKey('css:feedback');
    if (redisFeedback) {
      feedbacks = redisFeedback;
      console.log(`[+] Read ${feedbacks.length} feedback events from Upstash Redis.`);
    } else if (fs.existsSync(FEEDBACK_FILE)) {
      feedbacks = JSON.parse(fs.readFileSync(FEEDBACK_FILE, 'utf-8'));
      console.log(`[+] Read ${feedbacks.length} feedback events from local logs.`);
    }
  } catch (e) {
    console.error('[-] Error reading feedback logs:', e.message);
  }

  if (feedbacks.length === 0) {
    console.log('[+] No user feedback found. Taxonomy is already optimal. Exiting.');
    return;
  }

  console.log(`[+] Loaded ${feedbacks.length} feedback events. Analyzing patterns with Gemini...`);

  // 2. Read current scoringEngine.js to extract CSS_TAXONOMY
  let engineContent = "";
  if (fs.existsSync(SCORING_ENGINE_FILE)) {
    engineContent = fs.readFileSync(SCORING_ENGINE_FILE, 'utf-8');
  } else {
    console.error('[-] Error: scoringEngine.js file not found.');
    return;
  }

  // Extract the CSS_TAXONOMY block using simple boundaries
  const startIdx = engineContent.indexOf('export const CSS_TAXONOMY = {');
  const endIdx = engineContent.indexOf('// CSS Subjective Past Paper Questions Database');
  
  if (startIdx === -1 || endIdx === -1) {
    console.error('[-] Error parsing scoringEngine.js structure.');
    return;
  }

  const currentTaxonomyStr = engineContent.substring(startIdx, endIdx);

  // 3. Prompt Gemini to suggest updates
  const prompt = `
You are an expert CSS (Civil Services of Pakistan) examiner and taxonomy data engineer.
We have a newspaper curation system. The heuristic scoring engine filters articles using a taxonomy structure:
"""
${currentTaxonomyStr}
"""

Here is a log of user feedback events rating curated articles as relevant (true) or irrelevant (false):
${JSON.stringify(feedbacks, null, 2)}

Analyze this feedback. Identify patterns (e.g. if users marked articles containing specific terms as irrelevant, or if highly relevant articles have common keywords/authors that are missing from our taxonomy).
Suggest additions or deletions to the "keywords", "authors", "transitions", and "solutions" arrays in the CSS_TAXONOMY structure.

Return ONLY the updated JavaScript block definition of CSS_TAXONOMY, in this exact format:
export const CSS_TAXONOMY = {
  keywords: [ ... ],
  authors: [ ... ],
  transitions: [ ... ],
  solutions: [ ... ]
};

Do NOT wrap in markdown block formatting (do NOT include \`\`\`js or \`\`\`json). Return ONLY valid JavaScript code.
`;

  try {
    const geminiResponse = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${GEMINI_API_KEY}`,
      {
        contents: [{ parts: [{ text: prompt }] }]
      },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 45000
      }
    );

    const responseText = geminiResponse.data.candidates[0].content.parts[0].text.trim();
    
    // Simple verification check to ensure it contains export const CSS_TAXONOMY
    if (responseText.includes('export const CSS_TAXONOMY') && responseText.includes('keywords:')) {
      // Reassemble scoringEngine.js by replacing the old block with the new optimized block
      const prefix = engineContent.substring(0, startIdx);
      const suffix = engineContent.substring(endIdx);
      const newEngineContent = prefix + responseText + "\n\n" + suffix;
      
      fs.writeFileSync(SCORING_ENGINE_FILE, newEngineContent, 'utf-8');
      console.log('[+] AI Brain optimization successful! scoringEngine.js taxonomy has been upgraded.');
    } else {
      console.warn('[-] Received invalid format from Gemini. Brain optimization aborted.');
      console.log('Response was:', responseText);
    }
  } catch (err) {
    console.error('[-] Gemini AI brain refinement call failed:', err.message);
  }
}

refineTaxonomy().catch(err => {
  console.error('[-] Refinement process failed:', err.message);
});
