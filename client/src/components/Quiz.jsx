import React, { useState } from 'react';
import { Award, CheckCircle2, XCircle, ArrowRight, RotateCcw } from 'lucide-react';

export default function Quiz({ quizData, articleTitle, onBack }) {
  const [currentQuestionIndex, setCurrentQuestionIndex] = useState(0);
  const [selectedOption, setSelectedOption] = useState(null);
  const [isAnswered, setIsAnswered] = useState(false);
  const [score, setScore] = useState(0);
  const [showResults, setShowResults] = useState(false);

  if (!quizData || quizData.length === 0) {
    return (
      <div className="card text-center py-8">
        <p className="text-muted text-sm">No quiz available for this article yet.</p>
      </div>
    );
  }

  const currentQuestion = quizData[currentQuestionIndex];

  const handleOptionClick = (optionIndex) => {
    if (isAnswered) return;
    setSelectedOption(optionIndex);
    setIsAnswered(true);
    
    if (optionIndex === currentQuestion.answerIndex) {
      setScore(score + 1);
    }
  };

  const handleNext = () => {
    setSelectedOption(null);
    setIsAnswered(false);
    
    if (currentQuestionIndex + 1 < quizData.length) {
      setCurrentQuestionIndex(currentQuestionIndex + 1);
    } else {
      setShowResults(true);
    }
  };

  const handleReset = () => {
    setCurrentQuestionIndex(0);
    setSelectedOption(null);
    setIsAnswered(false);
    setScore(0);
    setShowResults(false);
  };

  if (showResults) {
    const percentage = Math.round((score / quizData.length) * 100);
    return (
      <div className="quiz-results-card animate-fade-in">
        <div className="results-icon-container">
          <Award className="results-icon" />
        </div>
        <h3 className="results-title">Quiz Completed!</h3>
        <p className="results-subtitle">Based on: <span className="highlight-text">{articleTitle}</span></p>
        
        <div className="results-score">
          {score} <span className="score-denominator">/ {quizData.length}</span>
        </div>

        <div className="progress-bar-container">
          <div 
            className="progress-bar-fill"
            style={{ width: `${percentage}%` }}
          ></div>
        </div>

        <p className="results-feedback">
          {percentage >= 80 
            ? "Excellent retention! You've mastered the core arguments and data points from this editorial. Use these insights in your papers."
            : percentage >= 50 
              ? "Good effort! Consider reviewing the highlighted key arguments in the article to reinforce your facts and figures."
              : "Review recommended. CSS exams require precise retention of data and policy recommendations. Go through the article again."}
        </p>

        <div className="quiz-action-footer">
          <button onClick={onBack} className="btn btn-secondary text-xs">
            Back to Dashboard
          </button>
          <button onClick={handleReset} className="btn btn-primary text-xs">
            <RotateCcw className="icon-sm" /> Try Again
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="quiz-card relative overflow-hidden">
      {/* Progress header */}
      <div className="quiz-header">
        <div>
          <span className="badge badge-primary">Daily Quiz</span>
          <span className="quiz-index-label">Q: {currentQuestionIndex + 1} of {quizData.length}</span>
        </div>
        <div className="quiz-topic-label">
          Comprehension Check
        </div>
      </div>

      {/* Question */}
      <h3 className="quiz-question">
        {currentQuestion.question}
      </h3>

      {/* Options */}
      <div className="quiz-options-list">
        {currentQuestion.options.map((option, index) => {
          let btnClass = "quiz-option-btn";
          let icon = null;

          if (isAnswered) {
            if (index === currentQuestion.answerIndex) {
              btnClass += " option-correct";
              icon = <CheckCircle2 className="icon-sm success-color" />;
            } else if (selectedOption === index) {
              btnClass += " option-incorrect";
              icon = <XCircle className="icon-sm error-color" />;
            } else {
              btnClass += " option-muted";
            }
          }

          return (
            <button 
              key={index} 
              onClick={() => handleOptionClick(index)}
              disabled={isAnswered}
              className={btnClass}
            >
              <span>{option}</span>
              {icon}
            </button>
          );
        })}
      </div>

      {/* Explanation & Action Footer */}
      {isAnswered && (
        <div className="quiz-explanation-box animate-fade-in">
          <h4 className="explanation-title">Explanation</h4>
          <p className="explanation-text">
            {currentQuestion.explanation}
          </p>
        </div>
      )}

      {isAnswered && (
        <div className="quiz-controls-row">
          <button 
            onClick={handleNext}
            className="btn btn-primary text-xs flex-center-gap"
          >
            {currentQuestionIndex + 1 === quizData.length ? "Finish Quiz" : "Next Question"}
            <ArrowRight className="icon-sm" />
          </button>
        </div>
      )}
    </div>
  );
}
