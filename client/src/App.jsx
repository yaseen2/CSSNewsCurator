import React, { useState, useEffect } from 'react';
import { 
  BookOpen, Compass, Award, FileText, Settings, 
  TrendingUp, Calendar, ArrowRight, BrainCircuit,
  Search, Sliders, ChevronDown, Check, AlertTriangle, 
  HelpCircle, RefreshCw, Star, Info, ExternalLink,
  Menu, X
} from 'lucide-react';
import Quiz from './components/Quiz';

function FlashcardDeck({ cards }) {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isFlipped, setIsFlipped] = useState(false);

  useEffect(() => {
    setIsFlipped(false);
  }, [currentIndex]);

  if (!cards || cards.length === 0) return null;

  const currentCard = cards[currentIndex];

  const handleNext = (e) => {
    e.stopPropagation();
    setIsFlipped(false);
    setTimeout(() => {
      setCurrentIndex((prev) => (prev + 1) % cards.length);
    }, 200);
  };

  const handlePrev = (e) => {
    e.stopPropagation();
    setIsFlipped(false);
    setTimeout(() => {
      setCurrentIndex((prev) => (prev - 1 + cards.length) % cards.length);
    }, 200);
  };

  return (
    <div className="flashcard-deck-wrapper">
      <div className="flashcard-deck-header">
        <span className="flashcard-badge">CONCEPT CARD</span>
        <span className="flashcard-counter">Card {currentIndex + 1} of {cards.length}</span>
      </div>
      
      <div 
        className={`flashcard-card-outer ${isFlipped ? 'flipped' : ''}`}
        onClick={() => setIsFlipped(!isFlipped)}
      >
        <div className="flashcard-card-inner">
          {/* Front Side */}
          <div className="flashcard-side flashcard-front">
            <div className="flashcard-side-tag">QUESTION</div>
            <div className="flashcard-text-container">
              <p className="flashcard-question-text">{currentCard.front}</p>
            </div>
            <div className="flashcard-hint">
              <span>Tap card to flip & reveal answer</span>
            </div>
          </div>
          {/* Back Side */}
          <div className="flashcard-side flashcard-back">
            <div className="flashcard-side-tag">ANSWER SUMMARY</div>
            <div className="flashcard-text-container">
              <p className="flashcard-answer-text">{currentCard.back}</p>
            </div>
            <div className="flashcard-hint">
              <span>Tap card to flip back</span>
            </div>
          </div>
        </div>
      </div>

      <div className="flashcard-deck-controls">
        <button className="btn btn-secondary text-xs" onClick={handlePrev}>
          ← Previous
        </button>
        <button className="btn btn-secondary text-xs font-semibold" style={{ minWidth: '90px' }} onClick={(e) => { e.stopPropagation(); setIsFlipped(!isFlipped); }}>
          {isFlipped ? 'Show Q' : 'Show A'}
        </button>
        <button className="btn btn-secondary text-xs" onClick={handleNext}>
          Next →
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const [activeTab, setActiveTab] = useState('dashboard');
  
  // Data states
  const [curatedArticles, setCuratedArticles] = useState([]);
  const [liveArticles, setLiveArticles] = useState([]);
  const [notes, setNotes] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedSource, setSelectedSource] = useState('All');
  
  // API and Scraper statuses
  const [apiKey, setApiKey] = useState(localStorage.getItem('gemini_api_key') || '');
  const [githubRepoUrl, setGithubRepoUrl] = useState(localStorage.getItem('github_repo_url') || 'https://github.com/yaseen2/CSSNewsCurator');
  const [apiServerUrl, setApiServerUrl] = useState(localStorage.getItem('api_server_url') || '');
  const [isScrapingLive, setIsScrapingLive] = useState(false);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [apiStatus, setApiStatus] = useState('idle'); // idle, testing, valid, invalid
  const [errorMessage, setErrorMessage] = useState('');
  
  // Selection states
  const [readingArticle, setReadingArticle] = useState(null);
  const [quizArticle, setQuizArticle] = useState(null);
  const [expandedCuratedId, setExpandedCuratedId] = useState(null);

  // Notes state inside standard reader
  const [noteTitle, setNoteTitle] = useState('');
  const [notesText, setNotesText] = useState('');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const BACKEND_URL = (apiServerUrl || '').replace(/\/+$/, '') || (
    window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
      ? 'http://localhost:5000'
      : window.location.origin
  );

  useEffect(() => {
    fetchCurated();
    fetchNotes();
    fetchLiveFeed();
  }, []);

  useEffect(() => {
    if (readingArticle) {
      setNoteTitle(`Study Outline: ${readingArticle.title.substring(0, 30)}...`);
      
      // Get flashcards (backward compatible fallback for articles with only outlines)
      let flashcardsList = readingArticle.flashcards;
      if (!flashcardsList && readingArticle.examOutline) {
        flashcardsList = [
          { front: "What is the focus exam question for this article?", back: readingArticle.examOutline.question },
          ...(readingArticle.examOutline.outline || []).map((step, sIdx) => ({
            front: `Step ${sIdx + 1} Outline Guidance`,
            back: step
          }))
        ];
      }

      if (flashcardsList && flashcardsList.length > 0) {
        let noteStr = `### AI-GENERATED STUDY FLASHCARDS\n`;
        noteStr += `**Source:** ${readingArticle.source} | **Author:** ${readingArticle.author} | **Paper:** ${readingArticle.paper}\n\n`;
        flashcardsList.forEach((card, idx) => {
          noteStr += `**Q${idx + 1}:** ${card.front}\n**A${idx + 1}:** ${card.back}\n\n`;
        });
        setNotesText(noteStr);
      } else {
        setNotesText(`### STUDY NOTES\n**Article:** ${readingArticle.title}\n**Source:** ${readingArticle.source} | **Author:** ${readingArticle.author}\n\n**1. Relevance:**\n- Paper: ${readingArticle.paper}\n- Topic: ${readingArticle.topic}\n\n**2. Core Arguments:**\n- \n\n**3. Key Takeaways:**\n- `);
      }
    }
  }, [readingArticle]);

  const parseGithubUrl = (url) => {
    if (!url) return null;
    try {
      const clean = url.replace('https://github.com/', '').replace('http://github.com/', '').replace('.git', '');
      const parts = clean.split('/');
      if (parts.length >= 2) {
        return { username: parts[0], repo: parts[1] };
      }
    } catch (e) {
      console.error('Failed to parse GitHub URL:', e);
    }
    return null;
  };

  const fetchCurated = async () => {
    const savedRepo = localStorage.getItem('github_repo_url') || 'https://github.com/yaseen2/CSSNewsCurator';
    const parsed = parseGithubUrl(savedRepo);
    let fetchUrl = `${BACKEND_URL}/api/recommendations`;
    
    const isProduction = window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1';
    if (parsed && (isProduction || !BACKEND_URL)) {
      fetchUrl = `https://raw.githubusercontent.com/${parsed.username}/${parsed.repo}/main/server/curatedData.json?t=${Date.now()}`;
    }

    try {
      const res = await fetch(fetchUrl);
      if (res.ok) {
        const data = await res.json();
        setCuratedArticles(data);
        if (data.length > 0) setExpandedCuratedId(data[0].id);
      } else {
        throw new Error(`HTTP status ${res.status}`);
      }
    } catch (err) {
      console.warn('Primary recommendations fetch failed, falling back to backend api:', err.message);
      if (fetchUrl !== `${BACKEND_URL}/api/recommendations`) {
        try {
          const fallbackRes = await fetch(`${BACKEND_URL}/api/recommendations`);
          if (fallbackRes.ok) {
            const data = await fallbackRes.json();
            setCuratedArticles(data);
            if (data.length > 0) setExpandedCuratedId(data[0].id);
          }
        } catch (fallbackErr) {
          console.error('Recommendations backend fallback also failed:', fallbackErr.message);
        }
      }
    }
  };

  const fetchNotes = async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/notes`);
      if (res.ok) {
        const data = await res.json();
        setNotes(data);
      }
    } catch (err) {
      console.error('Error fetching notes:', err);
    }
  };

  const fetchLiveFeed = async () => {
    setIsScrapingLive(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/articles`);
      if (res.ok) {
        const data = await res.json();
        setLiveArticles(data);
      }
    } catch (err) {
      console.error('Error fetching live feed:', err);
    } finally {
      setIsScrapingLive(false);
    }
  };

  // Test Gemini key using backend proxy
  const handleTestApiKey = async (keyToTest) => {
    if (!keyToTest) {
      setApiStatus('invalid');
      setErrorMessage('API Key cannot be empty.');
      return;
    }
    setApiStatus('testing');
    setErrorMessage('');
    try {
      const res = await fetch(`${BACKEND_URL}/api/gemini/test`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: keyToTest })
      });
      const data = await res.json();
      if (res.ok) {
        setApiStatus('valid');
        localStorage.setItem('gemini_api_key', keyToTest);
        setApiKey(keyToTest);
      } else {
        setApiStatus('invalid');
        setErrorMessage(data.error || 'Connection failed.');
      }
    } catch (err) {
      setApiStatus('invalid');
      setErrorMessage(`Failed to connect to backend: ${err.message || 'Check network connection, server URL, or CORS configuration.'}`);
    }
  };

  const handleSaveSettings = (key, repoUrl, serverUrl) => {
    localStorage.setItem('gemini_api_key', key);
    setApiKey(key);
    localStorage.setItem('github_repo_url', repoUrl);
    setGithubRepoUrl(repoUrl);
    localStorage.setItem('api_server_url', serverUrl);
    setApiServerUrl(serverUrl);
    alert('Settings saved locally!');
  };

  // Scrape content and open reader card
  const handleStartReading = async (article) => {
    if (article.content) {
      setReadingArticle(article);
      setQuizArticle(null);
      return;
    }

    setIsAnalyzing(true);
    try {
      const res = await fetch(`${BACKEND_URL}/api/articles/scrape`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: article.link, source: article.source })
      });
      if (res.ok) {
        const data = await res.json();
        const fullArticle = {
          ...article,
          content: data.fullText
        };
        setReadingArticle(fullArticle);
        setQuizArticle(null);
      } else {
        alert('Could not scrape full article body automatically. Please read it directly on the publisher website.');
        window.open(article.link, '_blank');
      }
    } catch (err) {
      console.error(err);
      alert('Error fetching full text.');
    } finally {
      setIsAnalyzing(false);
    }
  };

  // Live AI Curation with Gemini API via backend proxy
  const handleAnalyzeWithGemini = async (article) => {
    if (!apiKey) {
      alert('Please configure your Gemini API Key in the settings tab to run live AI analysis.');
      setActiveTab('settings');
      return;
    }

    setIsAnalyzing(true);
    try {
      // 1. Scrape full content
      const scrapeRes = await fetch(`${BACKEND_URL}/api/articles/scrape`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: article.link, source: article.source })
      });
      
      let fullContent = article.snippet;
      if (scrapeRes.ok) {
        const data = await scrapeRes.json();
        fullContent = data.fullText;
      }

      // 2. Call backend proxy
      const geminiRes = await fetch(`${BACKEND_URL}/api/gemini/curate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          key: apiKey,
          article: {
            title: article.title,
            author: article.author,
            source: article.source
          },
          content: fullContent
        })
      });

      const data = await geminiRes.json();

      if (geminiRes.ok) {
        if (data.suitable === false) {
          alert('Gemini evaluated this article and marked it as not academically valuable/suitable for Civil Service papers (e.g. local political debate).');
        } else {
          const newCurated = {
            id: `temp-${Date.now()}`,
            title: article.title,
            source: article.source,
            url: article.link,
            date: new Date().toISOString().split('T')[0],
            author: article.author,
            content: fullContent,
            ...data
          };
          setCuratedArticles([newCurated, ...curatedArticles]);
          setExpandedCuratedId(newCurated.id);
          setActiveTab('dashboard');
          alert('AI Curation complete! The article has been added to your Recommended Dashboard.');
        }
      } else {
        alert(`AI curation failed: ${data.error || 'Server error'}`);
      }
    } catch (err) {
      console.error(err);
      alert('Error running AI evaluation: ' + err.message);
    } finally {
      setIsAnalyzing(false);
    }
  };

  const handleFeedback = async (article, isRelevant) => {
    const key = `feedback_voted_${article.id}`;
    if (localStorage.getItem(key)) {
      alert("You have already submitted feedback for this article!");
      return;
    }

    try {
      const res = await fetch(`${BACKEND_URL}/api/feedback`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          articleId: article.id,
          isRelevant,
          title: article.title,
          url: article.url,
          paper: article.paper,
          topic: article.topic
        })
      });
      
      const data = await res.json();
      if (res.ok) {
        setCuratedArticles(prev => 
          prev.map(art => {
            if (art.id === article.id) {
              return {
                ...art,
                upvotes: data.upvotes !== undefined ? data.upvotes : art.upvotes,
                downvotes: data.downvotes !== undefined ? data.downvotes : art.downvotes
              };
            }
            return art;
          })
        );
        localStorage.setItem(key, isRelevant ? 'up' : 'down');
        alert("Thank you for your feedback! It will help improve the AI grading accuracy over time.");
      } else {
        alert("Failed to submit feedback: " + (data.error || "Server error"));
      }
    } catch (err) {
      console.error('Feedback submission error:', err);
      alert("Failed to connect to backend server to log feedback.");
    }
  };

  const handleSaveNotes = async () => {
    try {
      const res = await fetch(`${BACKEND_URL}/api/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title: noteTitle,
          articleTitle: readingArticle.title,
          articleUrl: readingArticle.url || readingArticle.link,
          content: notesText
        })
      });
      if (res.ok) {
        fetchNotes();
        alert('Study outline saved to Outline Bank!');
      }
    } catch (err) {
      console.error('Error saving outline:', err);
    }
  };

  const handleDeleteNote = async (id) => {
    if (confirm('Are you sure you want to delete this study outline?')) {
      try {
        const res = await fetch(`${BACKEND_URL}/api/notes/${id}`, {
          method: 'DELETE'
        });
        if (res.ok) {
          fetchNotes();
        }
      } catch (err) {
        console.error('Error deleting note:', err);
      }
    }
  };

  const filteredLiveArticles = liveArticles.filter(art => {
    const matchesSearch = art.title.toLowerCase().includes(searchQuery.toLowerCase()) || 
                          art.topic.toLowerCase().includes(searchQuery.toLowerCase());
    const matchesSource = selectedSource === 'All' || art.source === selectedSource;
    return matchesSearch && matchesSource;
  });

  return (
    <div className="layout-container">
      
      {/* Mobile Top Bar */}
      <header className="mobile-header">
        <div className="mobile-logo-brand">
          <div className="logo-box-mobile">
            <BrainCircuit style={{ width: '18px', height: '18px', color: 'white' }} />
          </div>
          <span className="mobile-brand-title">Civil Digest</span>
        </div>
        <button 
          onClick={() => setMobileMenuOpen(!mobileMenuOpen)}
          className="mobile-menu-toggle"
          aria-label="Toggle Navigation Menu"
        >
          {mobileMenuOpen ? <X className="icon-sm" /> : <Menu className="icon-sm" />}
        </button>
      </header>

      {/* Mobile Sidebar Overlay Backdrop */}
      {mobileMenuOpen && (
        <div 
          className="sidebar-mobile-overlay" 
          onClick={() => setMobileMenuOpen(false)}
        ></div>
      )}

      {/* Sidebar Navigation */}
      <aside className={`sidebar ${mobileMenuOpen ? 'mobile-open' : ''}`}>
        <div>
          <div className="sidebar-header">
            <div className="logo-box">
              <BrainCircuit />
            </div>
            <div>
              <h2 className="brand-title">Civil Digest</h2>
              <span className="brand-subtitle">Study Companion</span>
            </div>
          </div>

          <nav className="sidebar-nav">
            <button 
              onClick={() => { setActiveTab('dashboard'); setReadingArticle(null); setQuizArticle(null); setMobileMenuOpen(false); }}
              className={`nav-item-btn ${activeTab === 'dashboard' && !readingArticle && !quizArticle ? 'active' : ''}`}
            >
              <Star className="icon-sm" />
              Daily Curation
            </button>
            <button 
              onClick={() => { setActiveTab('rss-feed'); setReadingArticle(null); setQuizArticle(null); setMobileMenuOpen(false); }}
              className={`nav-item-btn ${activeTab === 'rss-feed' && !readingArticle && !quizArticle ? 'active' : ''}`}
            >
              <Compass className="icon-sm" />
              Live News Feeds
            </button>
            <button 
              onClick={() => { setActiveTab('syllabus'); setReadingArticle(null); setQuizArticle(null); setMobileMenuOpen(false); }}
              className={`nav-item-btn ${activeTab === 'syllabus' && !readingArticle && !quizArticle ? 'active' : ''}`}
            >
              <BookOpen className="icon-sm" />
              Syllabus Tracker
            </button>
            <button 
              onClick={() => { setActiveTab('notes-bank'); setReadingArticle(null); setQuizArticle(null); setMobileMenuOpen(false); }}
              className={`nav-item-btn ${activeTab === 'notes-bank' && !readingArticle && !quizArticle ? 'active' : ''}`}
            >
              <FileText className="icon-sm" />
              My Notes Bank
            </button>
            <button 
              onClick={() => { setActiveTab('settings'); setReadingArticle(null); setQuizArticle(null); setMobileMenuOpen(false); }}
              className={`nav-item-btn ${activeTab === 'settings' && !readingArticle && !quizArticle ? 'active' : ''}`}
            >
              <Settings className="icon-sm" />
              AI Setup
            </button>
          </nav>
        </div>

        <div className="sidebar-footer">
          <div className="footer-status">
            <div className={`status-dot ${apiKey ? 'active' : 'warning'}`}></div>
            <span>{apiKey ? "Gemini Connected" : "Local Engine"}</span>
          </div>
          <p className="footer-desc">Curation for Civil Service papers. Fully responsive dark-slate interface.</p>
        </div>
      </aside>

      {/* Main View Area */}
      <main className="main-content">
        
        {isAnalyzing && (
          <div className="fixed-loader-overlay animate-fade-in">
            <div className="loader-spinner"></div>
            <h3 className="brand-title">Gemini is Processing Article...</h3>
            <p className="footer-desc">Extracting key arguments, mapping syllabus tags, and building mock exam questions.</p>
          </div>
        )}

        {/* -------------------- ACTIVE READING MODE -------------------- */}
        {readingArticle ? (
          <div className="article-reader-container animate-fade-in">
            <div className="reader-header">
              <div className="reader-topic-badges">
                <span className="badge badge-primary">{readingArticle.source}</span>
                <span className="badge badge-accent">{readingArticle.paper}</span>
              </div>
              <h2 className="reader-title">{readingArticle.title}</h2>
              <div className="reader-meta-row">
                <span>By {readingArticle.author}</span>
                <span>•</span>
                <span>Published: {readingArticle.date || readingArticle.pubDate}</span>
              </div>
            </div>
            
            <div className="reader-body">
              {readingArticle.content ? (
                readingArticle.content.split('\n\n').map((p, idx) => (
                  <p key={idx} className="reader-paragraph">{p}</p>
                ))
              ) : (
                <p className="reader-paragraph">No content found.</p>
              )}
            </div>

            <div className="reader-notes-section">
              <div className="notes-section-header">
                <h3 className="list-title">Create Study Outline</h3>
                <input 
                  type="text" 
                  value={noteTitle} 
                  onChange={(e) => setNoteTitle(e.target.value)}
                  className="notes-input-title"
                  placeholder="Outline Title"
                />
              </div>
              <textarea 
                value={notesText} 
                onChange={(e) => setNotesText(e.target.value)}
                className="notes-textarea"
                placeholder="Outline key arguments, facts & figures, and policy solutions..."
              />
              <div className="notes-actions">
                <button 
                  onClick={() => {
                    navigator.clipboard.writeText(notesText);
                    alert('Outline copied to clipboard!');
                  }} 
                  className="btn btn-secondary text-xs"
                >
                  Copy Notes
                </button>
                <button 
                  onClick={handleSaveNotes} 
                  className="btn btn-primary text-xs"
                >
                  Save to Outline Bank
                </button>
              </div>
            </div>

            <div className="reader-actions-footer">
              <button onClick={() => setReadingArticle(null)} className="btn btn-secondary">
                ← Close Article
              </button>
              <a 
                href={readingArticle.url || readingArticle.link} 
                target="_blank" 
                rel="noopener noreferrer" 
                className="btn btn-primary"
              >
                Read Original on {readingArticle.source} Website ↗
              </a>
            </div>
          </div>
        ) : quizArticle ? (
          /* -------------------- ACTIVE QUIZ MODE -------------------- */
          <div className="animate-fade-in">
            <Quiz 
              quizData={quizArticle.quiz} 
              articleTitle={quizArticle.title} 
              onBack={() => setQuizArticle(null)}
            />
          </div>
        ) : (
          /* -------------------- STANDARD TABS -------------------- */
          <>
            {/* Header branding */}
            <header className="content-header">
              <div>
                <h1 className="page-title">
                  {activeTab === 'dashboard' && 'Daily Curation Dashboard'}
                  {activeTab === 'rss-feed' && 'Live News Feeds'}
                  {activeTab === 'syllabus' && 'Syllabus Tracker'}
                  {activeTab === 'notes-bank' && 'Study Outline Bank'}
                  {activeTab === 'settings' && 'AI setup'}
                </h1>
                <p className="page-subtitle">
                  <Calendar className="icon-sm" />
                  Today is {new Date().toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}
                </p>
              </div>
              {activeTab === 'rss-feed' && (
                <button 
                  onClick={fetchLiveFeed} 
                  disabled={isScrapingLive}
                  className="btn btn-secondary text-xs flex-center-gap"
                >
                  <RefreshCw className={`icon-sm ${isScrapingLive ? 'animate-spin' : ''}`} />
                  Refresh Feeds
                </button>
              )}
            </header>

            {/* TAB CONTENT: CURATED ARTICLES DASHBOARD */}
            {activeTab === 'dashboard' && (
              <div className="animate-fade-in">
                
                <div className="intro-banner">
                  <h3 className="intro-title">Today's Essential Curation</h3>
                  <p className="intro-desc">
                    We reviewed 24 Op-Eds and Editorials from Dawn, Express Tribune, and The Friday Times. 
                    These **{curatedArticles.length} articles** hold maximum value for the syllabus today. Read them, practice the quizzes, and build outlines.
                  </p>
                </div>

                {curatedArticles.length === 0 ? (
                  <div className="card text-center py-12">
                    <AlertTriangle className="icon-sm error-color" />
                    <h3 className="intro-title mt-4">No Curated Articles</h3>
                    <p className="intro-desc">Live scraping feeds are initializing. Or add your Gemini API Key to run automated assessments.</p>
                    <button onClick={fetchCurated} className="btn btn-primary text-xs mt-4">Load Curated Database</button>
                  </div>
                ) : (
                  <div className="curated-list">
                    {curatedArticles.map(art => {
                      const isExpanded = expandedCuratedId === art.id;
                      return (
                        <div key={art.id} className="card curated-card animate-fade-in">
                          <div 
                            className="curated-header-clickable"
                            onClick={() => setExpandedCuratedId(isExpanded ? null : art.id)}
                          >
                            <div>
                              <div className="meta-badges-row">
                                <span className="badge badge-primary">{art.source}</span>
                                <span className="badge badge-accent">{art.paper}</span>
                                <span className="badge badge-gold">{art.topic}</span>
                              </div>
                              <h3 className="curated-title">
                                {art.title}
                              </h3>
                              <p className="curated-author">Author: {art.author}</p>
                            </div>

                            <div className="score-panel">
                              <div>
                                <span className="score-number">{art.relevanceScore}%</span>
                                <span className="score-label">POLICY SCORE</span>
                              </div>
                              <ChevronDown className="icon-sm" style={{ transform: isExpanded ? 'rotate(180deg)' : 'none', transition: 'transform 0.2s' }} />
                            </div>
                          </div>

                          {/* Expanded content analysis details */}
                          {isExpanded && (
                            <div className="curated-details">
                              
                              <div>
                                <h4 className="details-section-title">
                                  <TrendingUp className="icon-sm" /> Syllabus Relevance & Context
                                </h4>
                                <p className="details-context-box">
                                  {art.whyMatters}
                                </p>
                                {art.matchedQuestion && (
                                  <div className="matched-question-box" style={{ marginTop: '12px' }}>
                                    <span className="badge badge-accent">🎯 Matched Past Exam Question (CE {art.matchedQuestion.year})</span>
                                    <p className="matched-question-text">
                                      <strong>{art.matchedQuestion.paper}:</strong> {art.matchedQuestion.question}
                                    </p>
                                  </div>
                                )}
                              </div>

                              <div className="analysis-grid">
                                <div>
                                  <h4 className="list-title">Key Arguments</h4>
                                  <ul className="arguments-list">
                                    {art.summary.map((arg, idx) => (
                                      <li key={idx} className="argument-item">
                                        <span className="argument-num">{idx + 1}.</span>
                                        <span>{arg}</span>
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                                <div>
                                  <h4 className="list-title">Facts & Data Points</h4>
                                  <ul className="facts-list">
                                    {art.facts.map((fact, idx) => (
                                      <li key={idx} className="fact-item">
                                        <span className="fact-bullet">■</span>
                                        <span>{fact}</span>
                                      </li>
                                    ))}
                                  </ul>
                                </div>
                              </div>

                              {art.academicReferences && art.academicReferences.length > 0 && (
                                <div style={{ marginTop: '16px', marginBottom: '16px' }}>
                                  <h4 className="details-section-title" style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                                    <BookOpen className="icon-sm" /> High-Yield Citations & Treaties (Past Paper References)
                                  </h4>
                                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginTop: '8px' }}>
                                    {art.academicReferences.map((ref, idx) => (
                                      <span key={idx} className="badge badge-accent" style={{ fontSize: '0.8rem', padding: '6px 12px' }}>
                                        {ref}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              )}

                              {(() => {
                                let articleFlashcards = art.flashcards;
                                if (!articleFlashcards && art.examOutline) {
                                  articleFlashcards = [
                                    { front: "What is the focus exam question for this article?", back: art.examOutline.question },
                                    ...(art.examOutline.outline || []).map((step, sIdx) => ({
                                      front: `Outline Guidance - Step ${sIdx + 1}:`,
                                      back: step
                                    }))
                                  ];
                                }
                                return articleFlashcards && articleFlashcards.length > 0 ? (
                                  <div className="exam-outline-section" style={{ marginTop: '20px', marginBottom: '20px' }}>
                                    <h4 className="details-section-title">
                                      <BrainCircuit className="icon-sm" /> Study Flashcards ({articleFlashcards.length})
                                    </h4>
                                    <FlashcardDeck cards={articleFlashcards} />
                                  </div>
                                ) : null;
                              })()}

                              {/* Vocabulary panel */}
                              <div>
                                <h4 className="vocab-title">Vocabulary Power-up</h4>
                                <div className="vocab-grid">
                                  {art.vocabulary.map((vocab, idx) => (
                                    <div key={idx} className="vocab-card">
                                      <div>
                                        <div className="vocab-header">
                                          <span className="vocab-word">{vocab.word}</span>
                                          <span className="vocab-type">{vocab.type}</span>
                                        </div>
                                        <p className="vocab-definition">{vocab.definition}</p>
                                      </div>
                                      <p className="vocab-usage">"{vocab.sentence}"</p>
                                    </div>
                                  ))}
                                </div>
                              </div>

                              {/* CTA Footers */}
                              <div className="curated-actions-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', width: '100%', flexWrap: 'wrap', gap: '16px' }}>
                                <div className="feedback-section flex-center-gap">
                                  <span className="feedback-label" style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>Was this evaluation relevant?</span>
                                  <button 
                                    onClick={() => handleFeedback(art, true)}
                                    className="btn-feedback upvote flex-center-gap"
                                    title="Yes, relevant"
                                    style={{ background: 'rgba(16, 185, 129, 0.08)', border: '1px solid rgba(16, 185, 129, 0.2)', padding: '6px 12px', borderRadius: '6px', color: '#10b981', cursor: 'pointer', transition: 'var(--transition-smooth)' }}
                                  >
                                    👍 <span className="vote-count" style={{ fontWeight: '700', fontSize: '0.8rem' }}>{art.upvotes || 0}</span>
                                  </button>
                                  <button 
                                    onClick={() => handleFeedback(art, false)}
                                    className="btn-feedback downvote flex-center-gap"
                                    title="No, irrelevant"
                                    style={{ background: 'rgba(239, 68, 68, 0.08)', border: '1px solid rgba(239, 68, 68, 0.2)', padding: '6px 12px', borderRadius: '6px', color: '#ef4444', cursor: 'pointer', transition: 'var(--transition-smooth)' }}
                                  >
                                    👎 <span className="vote-count" style={{ fontWeight: '700', fontSize: '0.8rem' }}>{art.downvotes || 0}</span>
                                  </button>
                                </div>
                                
                                <div className="flex-center-gap">
                                  <a 
                                    href={art.url} 
                                    target="_blank" 
                                    rel="noopener noreferrer" 
                                    className="btn btn-secondary text-xs flex-center-gap"
                                  >
                                    Open Original Link <ExternalLink className="icon-sm" />
                                  </a>
                                  <button 
                                    onClick={() => setQuizArticle(art)}
                                    className="btn btn-outline text-xs"
                                  >
                                    Take Quiz
                                  </button>
                                  <button 
                                    onClick={() => handleStartReading(art)}
                                    className="btn btn-primary text-xs"
                                  >
                                    Read Summary & Outline
                                  </button>
                                </div>
                              </div>

                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* TAB CONTENT: LIVE NEWS SCRApER FEED */}
            {activeTab === 'rss-feed' && (
              <div className="space-y-6 animate-fade-in">
                
                {/* Search / Filter header */}
                <div className="filters-panel">
                  <div className="search-wrapper">
                    <Search className="icon-sm search-icon" />
                    <input 
                      type="text" 
                      placeholder="Search articles..."
                      value={searchQuery}
                      onChange={(e) => setSearchQuery(e.target.value)}
                      className="search-input"
                    />
                  </div>

                  <div className="source-filter-row">
                    <span className="filter-label">Source:</span>
                    <div className="source-filter-selector">
                      {['All', 'Dawn', 'Express Tribune'].map(src => (
                        <button 
                          key={src}
                          onClick={() => setSelectedSource(src)}
                          className={`source-filter-btn ${selectedSource === src ? 'active' : ''}`}
                        >
                          {src}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Scraper items list */}
                {isScrapingLive ? (
                  <div className="card text-center py-20">
                    <RefreshCw className="icon-sm loader-spinner mx-auto mb-4" />
                    <h3 className="intro-title">Scraping Pakistan's Opinion Desks</h3>
                    <p className="intro-desc">Connecting to Dawn, Tribune, and The News. Parsing RSS formats...</p>
                  </div>
                ) : filteredLiveArticles.length === 0 ? (
                  <div className="card text-center py-12">
                    <AlertTriangle className="icon-sm mx-auto mb-4 text-dark" />
                    <p className="intro-desc">No articles found matching filters.</p>
                  </div>
                ) : (
                  <div className="card-grid">
                    {filteredLiveArticles.map((art, idx) => {
                      return (
                        <div key={idx} className="card feed-card">
                          <div>
                            <div className="feed-header">
                              <span className="badge badge-primary">{art.source}</span>
                              <span className="badge badge-accent">{art.relevanceScore}% Relevance</span>
                            </div>

                            <h3 className="feed-title">
                              {art.title}
                            </h3>
                            <p className="feed-snippet">
                              {art.snippet}
                            </p>
                          </div>

                          <div className="feed-footer">
                            <span className="feed-author">By {art.author}</span>
                            <div className="feed-actions">
                              <button 
                                onClick={() => handleStartReading(art)}
                                className="btn btn-secondary text-xs"
                                style={{ padding: '6px 12px' }}
                              >
                                Read
                              </button>
                              <button 
                                onClick={() => handleAnalyzeWithGemini(art)}
                                className="btn btn-primary text-xs flex-center-gap font-semibold"
                                style={{ padding: '6px 12px' }}
                              >
                                <BrainCircuit className="icon-sm" /> AI Crate
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* TAB CONTENT: SYLLABUS TRACKER MAP */}
            {activeTab === 'syllabus' && (
              <div className="syllabus-grid animate-fade-in">
                
                {/* Curriculum syllabus groups */}
                <div className="card">
                  <h3 className="list-title mb-4">
                    Compulsory Syllabus Papers
                  </h3>

                  <div className="space-y-4" style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                    {[
                      { name: "English Essay", desc: "Socio-Economic & Climate topics" },
                      { name: "Current Affairs", desc: "Foreign policy & geopolitics" },
                      { name: "Pakistan Affairs", desc: "Circular debt, constitution, security" },
                      { name: "General Science & Ability", desc: "Environmental Science & IT" },
                      { name: "Economics (Option)", desc: "IMF programs & resource allocation" }
                    ].map((subj, idx) => (
                      <div key={idx} className="syllabus-topic-card">
                        <span className="syllabus-topic-title">{subj.name}</span>
                        <span className="syllabus-topic-desc">{subj.desc}</span>
                      </div>
                    ))}
                  </div>
                </div>

                {/* Mapped syllabus guidelines */}
                <div className="card">
                  <h3 className="list-title mb-4">
                    Curated Reading List by Syllabus Area
                  </h3>

                  {curatedArticles.length === 0 ? (
                    <p className="intro-desc">No articles analyzed yet. They will map here automatically.</p>
                  ) : (
                    <div className="syllabus-mapped-section">
                      {['Pakistan Affairs / Economics', 'English Essay / General Science & Ability', 'International Relations / Current Affairs'].map((section, idx) => {
                        const matched = curatedArticles.filter(art => art.paper.toLowerCase().includes(section.split(' / ')[0].toLowerCase()) || art.paper.toLowerCase().includes(section.split(' / ')[1].toLowerCase()));
                        return (
                          <div key={idx} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                            <h4 className="syllabus-section-header">
                              {section}
                            </h4>
                            {matched.length === 0 ? (
                              <p className="intro-desc" style={{ paddingLeft: '14px' }}>No recommended articles under this syllabus code yet.</p>
                            ) : (
                              <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
                                {matched.map(art => (
                                  <div key={art.id} className="syllabus-mapped-article-item">
                                    <span className="syllabus-mapped-link" onClick={() => handleStartReading(art)}>
                                      • {art.title}
                                    </span>
                                    <span className="syllabus-mapped-source">{art.source}</span>
                                  </div>
                                ))}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

              </div>
            )}

            {/* TAB CONTENT: STUDY NOTES BANK */}
            {activeTab === 'notes-bank' && (
              <div className="animate-fade-in">
                
                {notes.length === 0 ? (
                  <div className="card text-center py-16">
                    <FileText className="icon-sm mx-auto mb-4 text-dark" style={{ width: '42px', height: '42px' }} />
                    <h3 className="intro-title">No Study Outlines Saved</h3>
                    <p className="intro-desc mb-4">
                      Read articles and save outlines to this bank for exam revision.
                    </p>
                    <button onClick={() => setActiveTab('dashboard')} className="btn btn-primary text-xs">
                      Browse Curations
                    </button>
                  </div>
                ) : (
                  <div className="card-grid">
                    {notes.map(note => (
                      <div key={note.id} className="card note-card">
                        <div>
                          <div className="note-header">
                            <h3 className="note-title">{note.title}</h3>
                            <button 
                              onClick={() => handleDeleteNote(note.id)}
                              className="note-delete-btn"
                            >
                              Delete
                            </button>
                          </div>
                          <p className="note-source-ref">Source: "{note.articleTitle}"</p>
                          <div className="note-preview-box">
                            <pre className="note-preview-content">
                              {note.content}
                            </pre>
                          </div>
                        </div>

                        <div className="note-footer">
                          <span className="note-date">Saved: {new Date(note.createdAt).toLocaleDateString()}</span>
                          <button 
                            onClick={() => {
                              navigator.clipboard.writeText(note.content);
                              alert('Outline copied to clipboard!');
                            }}
                            className="note-action-link"
                          >
                            Copy Outline
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

            {/* TAB CONTENT: SETTINGS (AI SETUP) */}
            {activeTab === 'settings' && (
              <div className="settings-card card animate-fade-in">
                <div>
                  <div className="settings-header-icon">
                    <BrainCircuit />
                  </div>
                  <h2 className="settings-title">Configure Gemini AI Curation</h2>
                  <p className="settings-desc">
                    Connect your free Gemini API Key to enable automated article analysis, summary generation, vocabulary lists, and quiz generation.
                  </p>
                </div>

                <div className="form-group">
                  <label className="form-label">Gemini API Key</label>
                  <input 
                    type="password" 
                    value={apiKey} 
                    onChange={(e) => setApiKey(e.target.value)}
                    className="input-password"
                    placeholder="Paste your API key here (AI Studio API Key)"
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">GitHub Repository URL (Optional - For Production)</label>
                  <input 
                    type="text" 
                    value={githubRepoUrl} 
                    onChange={(e) => setGithubRepoUrl(e.target.value)}
                    className="input-password"
                    placeholder="e.g., https://github.com/your-username/your-repo-name"
                  />
                  <p className="footer-desc" style={{ marginTop: '4px' }}>
                    If deployed to Vercel, the app will fetch daily curations directly from this GitHub repo's raw database without rebuilding.
                  </p>
                </div>

                <div className="form-group">
                  <label className="form-label">API Server URL (Optional - e.g. Vercel backend link)</label>
                  <input 
                    type="text" 
                    value={apiServerUrl} 
                    onChange={(e) => setApiServerUrl(e.target.value)}
                    className="input-password"
                    placeholder="e.g., https://your-backend-app.vercel.app"
                  />
                  <p className="footer-desc" style={{ marginTop: '4px' }}>
                    Provide the URL of your deployed Express API. If blank, it defaults to the current origin URL or localhost.
                  </p>
                </div>

                <div className="form-actions-row">
                  <button 
                    onClick={() => handleTestApiKey(apiKey)}
                    disabled={apiStatus === 'testing'}
                    className="btn btn-secondary text-xs"
                  >
                    {apiStatus === 'testing' ? 'Testing Link...' : 'Test Connection'}
                  </button>
                  <button 
                    onClick={() => handleSaveSettings(apiKey, githubRepoUrl, apiServerUrl)}
                    className="btn btn-primary text-xs"
                  >
                    Save Settings
                  </button>
                </div>

                {apiStatus === 'valid' && (
                  <div className="api-status-box valid">
                    <Check className="icon-sm" />
                    <span>Connection established. Gemini API is ready to curate.</span>
                  </div>
                )}

                {apiStatus === 'invalid' && (
                  <div className="api-status-box invalid">
                    <AlertTriangle className="icon-sm" />
                    <span>Error: {errorMessage || 'Invalid API key or network error.'}</span>
                  </div>
                )}

                <div className="settings-help-box">
                  <h4 className="help-title">
                    <HelpCircle className="icon-sm success-color" /> How to get a free API Key:
                  </h4>
                  <ol className="help-list">
                    <li>Go to the <a href="https://aistudio.google.com/" target="_blank" rel="noopener noreferrer">Google AI Studio</a>.</li>
                    <li>Log in with your Google account.</li>
                    <li>Click **"Get API Key"** in the top left sidebar.</li>
                    <li>Click **"Create API Key"** and copy it to this settings panel.</li>
                    <li>The free tier provides 15 Requests per Minute—plenty for daily readings!</li>
                  </ol>
                </div>
              </div>
            )}
          </>
        )}
      </main>
    </div>
  );
}
