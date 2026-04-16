'use client';

/**
 * StrategyGuide — Interactive explainer for the Triple C's investment methodology.
 *
 * This component breaks down:
 *   • What the Triple C's are and why they work
 *   • The three pillars: Triples, Cornerstone, Core/Income
 *   • Allocation targets and rebalancing logic
 *   • Risk management (margin, concentration caps)
 *   • When to trim and why
 *   • Market condition adjustments
 */

import { useState } from 'react';
import { ChevronDown, ChevronUp, BookOpen, TrendingUp, Shield, DollarSign } from 'lucide-react';

interface GuideSection {
  id: string;
  title: string;
  icon: React.ReactNode;
  color: string;
  content: React.ReactNode;
}

export function StrategyGuide() {
  const [expanded, setExpanded] = useState<string | null>('overview');

  const toggleSection = (id: string) => {
    setExpanded(expanded === id ? null : id);
  };

  const sections: GuideSection[] = [
    {
      id: 'overview',
      title: 'What Are the Triple C's?',
      icon: <BookOpen className="w-5 h-5" />,
      color: 'from-blue-600 to-blue-700',
      content: (
        <div className="space-y-3 text-sm text-gray-300">
          <p>
            The Triple C's is a proven investment strategy that combines <strong>three complementary pillars</strong> to achieve both growth and steady income.
          </p>
          <div className="bg-[#1e2139] border border-blue-800/50 rounded p-3">
            <p className="font-semibold text-blue-300 mb-2">The Three Pillars:</p>
            <ul className="space-y-2">
              <li><span className="text-emerald-400 font-medium">Triples</span> — Triple leveraged ETFs (UPRO, TQQQ, SPXL) for aggressive growth</li>
              <li><span className="text-amber-400 font-medium">Cornerstone</span> — CLM/CRF funds for high dividend yield + corporate DRIP</li>
              <li><span className="text-purple-400 font-medium">Core/Income</span> — Diversified income ETFs + growth anchors for stability</li>
            </ul>
          </div>
          <p className="text-xs text-gray-400">
            💡 <strong>Why it works:</strong> By combining leveraged growth with high-dividend income, you get capital appreciation AND qualifying income for loans, even in volatile markets.
          </p>
        </div>
      ),
    },
    {
      id: 'pillars',
      title: 'Understanding the Three Pillars',
      icon: <TrendingUp className="w-5 h-5" />,
      color: 'from-emerald-600 to-emerald-700',
      content: (
        <div className="space-y-4 text-sm text-gray-300">
          <div className="bg-[#1e2139] border border-emerald-800/50 rounded p-3">
            <p className="font-semibold text-emerald-300 mb-2">🚀 Triples (10-20% target)</p>
            <p className="text-xs text-gray-400 mb-2">Triple leveraged ETFs that track major indexes at 3x leverage.</p>
            <ul className="space-y-1 text-xs text-gray-300">
              <li>• <span className="font-mono text-emerald-400">UPRO</span> — S&P 500 × 3 (long)</li>
              <li>• <span className="font-mono text-emerald-400">TQQQ</span> — Nasdaq 100 × 3 (long)</li>
              <li>• <span className="font-mono text-emerald-400">SPXL</span> — S&P 500 × 3 (Direxion)</li>
            </ul>
            <p className="text-xs text-gray-400 mt-2">Why: Index-based, no single-stock risk. Compounds aggressively in bull markets, recovers quickly after corrections.</p>
          </div>

          <div className="bg-[#1e2139] border border-amber-800/50 rounded p-3">
            <p className="font-semibold text-amber-300 mb-2">💰 Cornerstone (15-25% target)</p>
            <p className="text-xs text-gray-400 mb-2">Closed-end funds with exceptional dividend yields and corporate DRIP at NAV.</p>
            <ul className="space-y-1 text-xs text-gray-300">
              <li>• <span className="font-mono text-amber-400">CLM</span> — Cornerstone Municipal Income ETF (~8-10% yield)</li>
              <li>• <span className="font-mono text-amber-400">CRF</span> — Cornerstone Total Return Fund (~10-12% yield)</li>
            </ul>
            <p className="text-xs text-gray-400 mt-2">Why: High yield + reinvest at NAV = massive compounding. Provides qualifying income for bank loans.</p>
          </div>

          <div className="bg-[#1e2139] border border-purple-800/50 rounded p-3">
            <p className="font-semibold text-purple-300 mb-2">📊 Core/Income (50-70% target)</p>
            <p className="text-xs text-gray-400 mb-2">Diversified mix of income ETFs, growth anchors, bonds, and hedges.</p>
            <ul className="space-y-1 text-xs text-gray-300">
              <li>• <span className="text-orange-400">Yieldmax, Defiance, Roundhill</span> — Single-stock yield ETFs</li>
              <li>• <span className="text-purple-400">QQQ, SPY, VTI</span> — Growth anchors</li>
              <li>• <span className="text-blue-400">TLT, AGG, SGOV</span> — Bond stabilizers</li>
              <li>• <span className="text-red-400">SPXU, SQQQ</span> — Hedges for downturns</li>
            </ul>
            <p className="text-xs text-gray-400 mt-2">Why: Diversification reduces volatility. Mix of growth + income + hedges keeps portfolio resilient in all market conditions.</p>
          </div>
        </div>
      ),
    },
    {
      id: 'allocation',
      title: 'Allocation Targets & Rebalancing',
      icon: <DollarSign className="w-5 h-5" />,
      color: 'from-amber-600 to-amber-700',
      content: (
        <div className="space-y-4 text-sm text-gray-300">
          <div className="bg-[#1e2139] border border-amber-800/50 rounded p-3">
            <p className="font-semibold text-amber-300 mb-2">📍 Default Allocation Targets</p>
            <div className="space-y-1 text-xs">
              <div className="flex justify-between">
                <span className="text-emerald-400">Triples:</span>
                <span className="font-mono text-white">10%</span>
              </div>
              <div className="flex justify-between">
                <span className="text-amber-400">Cornerstone:</span>
                <span className="font-mono text-white">15%</span>
              </div>
              <div className="flex justify-between">
                <span className="text-purple-400">Core/Income:</span>
                <span className="font-mono text-white">60%</span>
              </div>
              <div className="flex justify-between">
                <span className="text-red-400">Hedges:</span>
                <span className="font-mono text-white">5%</span>
              </div>
            </div>
            <p className="text-xs text-gray-400 mt-2">💡 These are adjustable in Settings based on your risk tolerance and market outlook.</p>
          </div>

          <div className="bg-[#1e2139] border border-blue-800/50 rounded p-3">
            <p className="font-semibold text-blue-300 mb-2">🔄 When to Rebalance</p>
            <ul className="space-y-2 text-xs text-gray-300">
              <li>• <span className="font-semibold">Monthly:</span> Check your pillar allocation vs. targets. If any pillar drifts &gt;5%, rebalance.</li>
              <li>• <span className="font-semibold">After big market moves:</span> +10% market rally → trim Triples. -10% crash → buy Triples dip.</li>
              <li>• <span className="font-semibold">Quarterly:</span> Review fund family concentration. No family &gt;20% of portfolio.</li>
              <li>• <span className="font-semibold">Annual:</span> Reset margin targets. Pay down if margin is above 20%.</li>
            </ul>
          </div>

          <div className="bg-[#1e2139] border border-green-800/50 rounded p-3">
            <p className="font-semibold text-green-300 mb-2">✂️ The Trim Rule</p>
            <p className="text-xs text-gray-300">
              When your <span className="text-emerald-400">Triples</span> hit 15-20% of portfolio (after a rally), <span className="font-semibold">trim 20-30%</span> of your position to lock in gains and rebalance back to 10%.
            </p>
            <p className="text-xs text-gray-400 mt-2">Why: "Take trips at market highs because you need to cash in some and live off your spoils."</p>
          </div>
        </div>
      ),
    },
    {
      id: 'risk',
      title: 'Risk Management: Margin & Concentration',
      icon: <Shield className="w-5 h-5" />,
      color: 'from-red-600 to-red-700',
      content: (
        <div className="space-y-4 text-sm text-gray-300">
          <div className="bg-[#1e2139] border border-red-800/50 rounded p-3">
            <p className="font-semibold text-red-300 mb-2">⚠️ Margin Rules (Three-Tier System)</p>
            <div className="space-y-2 text-xs">
              <div className="flex justify-between items-center p-2 bg-green-900/20 rounded border border-green-800/30">
                <span className="text-emerald-400">Healthy Zone</span>
                <span className="font-mono text-white">&lt; 20%</span>
              </div>
              <div className="flex justify-between items-center p-2 bg-yellow-900/20 rounded border border-yellow-800/30">
                <span className="text-yellow-400">Caution Zone</span>
                <span className="font-mono text-white">20-30%</span>
              </div>
              <div className="flex justify-between items-center p-2 bg-red-900/20 rounded border border-red-800/30">
                <span className="text-red-400">Danger Zone</span>
                <span className="font-mono text-white">30-50%</span>
              </div>
              <div className="flex justify-between items-center p-2 bg-red-950/40 rounded border border-red-700">
                <span className="text-red-300 font-semibold">Emergency Stop</span>
                <span className="font-mono text-red-300 font-bold">&gt; 50%</span>
              </div>
            </div>
            <p className="text-xs text-gray-400 mt-2">Margin = (Margin Balance / Total Value) × 100</p>
          </div>

          <div className="bg-[#1e2139] border border-orange-800/50 rounded p-3">
            <p className="font-semibold text-orange-300 mb-2">🎯 Concentration Cap</p>
            <p className="text-xs text-gray-300 mb-2">
              No single position &gt; <span className="font-mono text-orange-400">20%</span> of portfolio.
            </p>
            <p className="text-xs text-gray-400">
              No single <span className="font-semibold">fund family</span> (e.g., Yieldmax, Defiance) &gt; <span className="font-mono text-orange-400">20%</span> of portfolio.
            </p>
            <p className="text-xs text-gray-400 mt-2">Why: Prevents excessive concentration risk. Diversification = safety.</p>
          </div>

          <div className="bg-[#1e2139] border border-purple-800/50 rounded p-3">
            <p className="font-semibold text-purple-300 mb-2">📉 Market Correction Strategy</p>
            <p className="text-xs text-gray-300">
              In a down market (-10% to -20%), <span className="font-semibold">don't panic</span>. The Triple C's strategy is designed to recover:
            </p>
            <ul className="space-y-1 text-xs text-gray-300 mt-2">
              <li>• Triples recover 3x faster than the index in rallies</li>
              <li>• Cornerstone DRIP at NAV buys at discount during crashes</li>
              <li>• Core/Income + Hedges provide cushion</li>
            </ul>
          </div>
        </div>
      ),
    },
    {
      id: 'dynamic',
      title: 'Dynamic Allocation Based on Market Conditions',
      icon: <TrendingUp className="w-5 h-5" />,
      color: 'from-cyan-600 to-cyan-700',
      content: (
        <div className="space-y-4 text-sm text-gray-300">
          <p className="text-xs">
            The app watches <span className="font-semibold">VIX, market volatility, and trends</span> to recommend when to adjust your allocation targets.
          </p>

          <div className="bg-[#1e2139] border border-cyan-800/50 rounded p-3">
            <p className="font-semibold text-cyan-300 mb-2">📊 VIX Levels (Market Fear Gauge)</p>
            <div className="space-y-2 text-xs">
              <div className="flex justify-between items-start p-2 bg-blue-900/20 rounded border border-blue-800/30">
                <div>
                  <p className="text-blue-400 font-medium">VIX &lt; 15 (Low Fear)</p>
                  <p className="text-gray-400">Calm market, bull rally</p>
                </div>
                <span className="text-right">→ <span className="text-emerald-400">Increase Triples</span></span>
              </div>
              <div className="flex justify-between items-start p-2 bg-yellow-900/20 rounded border border-yellow-800/30">
                <div>
                  <p className="text-yellow-400 font-medium">VIX 15-25 (Normal)</p>
                  <p className="text-gray-400">Typical market conditions</p>
                </div>
                <span className="text-right">→ <span className="text-purple-400">Hold targets</span></span>
              </div>
              <div className="flex justify-between items-start p-2 bg-orange-900/20 rounded border border-orange-800/30">
                <div>
                  <p className="text-orange-400 font-medium">VIX 25-40 (High Fear)</p>
                  <p className="text-gray-400">Volatility spike, market uncertain</p>
                </div>
                <span className="text-right">→ <span className="text-yellow-400">Increase hedges</span></span>
              </div>
              <div className="flex justify-between items-start p-2 bg-red-900/20 rounded border border-red-800/30">
                <div>
                  <p className="text-red-400 font-medium">VIX &gt; 40 (Panic)</p>
                  <p className="text-gray-400">Market crash or extreme stress</p>
                </div>
                <span className="text-right">→ <span className="text-red-300 font-semibold">Buy dips</span></span>
              </div>
            </div>
          </div>

          <div className="bg-[#1e2139] border border-green-800/50 rounded p-3">
            <p className="font-semibold text-green-300 mb-2">📈 Market Trend Signals</p>
            <ul className="space-y-1 text-xs text-gray-300">
              <li><span className="font-semibold text-green-400">Strong uptrend:</span> Increase Triples. Markets are rallying — let leverage work for you.</li>
              <li><span className="font-semibold text-yellow-400">Sideways/flat:</span> Hold balanced allocation. No clear direction.</li>
              <li><span className="font-semibold text-red-400">Downtrend:</span> Reduce Triples, increase hedges or Core/Income. Protect capital.</li>
            </ul>
          </div>

          <div className="bg-[#1e2139] border border-purple-800/50 rounded p-3">
            <p className="font-semibold text-purple-300 mb-2">🤖 AI Recommendations</p>
            <p className="text-xs text-gray-300">
              Check the <span className="font-semibold">Market Conditions</span> panel for live VIX, volatility metrics, and AI-generated recommendations for allocation adjustments.
            </p>
          </div>
        </div>
      ),
    },
  ];

  return (
    <div className="w-full bg-gradient-to-b from-[#0f1117] to-[#1a1f36] rounded-lg border border-blue-900/30 overflow-hidden">
      {/* Header */}
      <div className="bg-gradient-to-r from-blue-900/40 to-purple-900/40 border-b border-blue-800/50 px-4 py-3">
        <h2 className="text-base font-bold text-white flex items-center gap-2">
          <BookOpen className="w-5 h-5 text-blue-400" />
          Triple C's Strategy Guide
        </h2>
        <p className="text-xs text-gray-400 mt-1">
          Learn how the strategy works, when to rebalance, and how to adjust for market conditions.
        </p>
      </div>

      {/* Sections */}
      <div className="divide-y divide-blue-900/20">
        {sections.map((section) => (
          <div key={section.id} className="border-b border-blue-900/10 last:border-0">
            <button
              onClick={() => toggleSection(section.id)}
              className="w-full px-4 py-3 flex items-center justify-between hover:bg-blue-900/10 transition-colors text-left"
            >
              <div className="flex items-center gap-3 flex-1">
                <div className={`p-2 rounded bg-gradient-to-br ${section.color} text-white`}>
                  {section.icon}
                </div>
                <span className="font-semibold text-white text-sm">{section.title}</span>
              </div>
              {expanded === section.id ? (
                <ChevronUp className="w-5 h-5 text-blue-400" />
              ) : (
                <ChevronDown className="w-5 h-5 text-gray-500" />
              )}
            </button>

            {expanded === section.id && (
              <div className="px-4 py-3 bg-blue-950/20 border-t border-blue-900/20">
                {section.content}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
