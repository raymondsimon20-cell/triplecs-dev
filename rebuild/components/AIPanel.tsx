'use client';
import { useState } from 'react';

export function AIPanel() {
  const [question, setQuestion] = useState('');
  const [analysis, setAnalysis] = useState('');
  const [loading, setLoading] = useState(false);

  const run = async () => {
    setLoading(true);
    setAnalysis('');
    try {
      const res = await fetch('/api/ai-analysis', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(question ? { question } : {}),
      });
      const json = await res.json();
      setAnalysis(res.ok ? json.analysis : `Error: ${json.error}`);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="card p-4">
      <h3 className="mb-2 text-sm font-semibold uppercase tracking-wide opacity-70">AI Analysis</h3>
      <div className="flex gap-2">
        <input
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask about the portfolio (or leave blank for full health check)…"
          className="flex-1 rounded border border-slate-300 bg-transparent px-2 py-1.5 text-sm dark:border-slate-700"
        />
        <button
          onClick={run}
          disabled={loading}
          className="rounded bg-indigo-600 px-4 py-1.5 text-sm font-semibold text-white disabled:opacity-50"
        >
          {loading ? 'Analyzing…' : 'Analyze'}
        </button>
      </div>
      {analysis && (
        <pre className="mt-3 max-h-80 overflow-auto whitespace-pre-wrap rounded bg-slate-50 p-3 text-xs leading-relaxed dark:bg-slate-900">
          {analysis}
        </pre>
      )}
      <p className="mt-2 text-[10px] opacity-50">
        Claude narrates and recommends — hard limits are enforced by the guardrails layer in code.
      </p>
    </div>
  );
}
