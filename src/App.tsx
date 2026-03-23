import React, { useState, useEffect, useRef } from 'react';
import { BarChart, Bar, XAxis, YAxis, Cell, Tooltip, ResponsiveContainer } from 'recharts';

interface Quote {
  price: number;
  change: number;
  changePct: number;
}

interface FearGreed {
  value: string;
  value_classification: string;
}

interface BriefData {
  brief: string;
  quotes: Record<string, Quote>;
  fearGreed: FearGreed;
  cached: boolean;
}

const TICKERS = [
  { sym: 'SPY', label: 'S&P500' },
  { sym: 'QQQ', label: '나스닥' },
  { sym: 'IWM', label: '러셀2000' },
  { sym: '^VIX', label: 'VIX' },
  { sym: 'BTC-USD', label: 'BTC' },
  { sym: 'ETH-USD', label: 'ETH' },
  { sym: 'GC=F', label: '금' },
  { sym: 'DX-Y.NYB', label: '달러' },
  { sym: '^TNX', label: '10Y금리', isYield: true },
  { sym: '^IRX', label: '3M금리', isYield: true },
];

const SECTORS = [
  { sym: 'XLK', label: '기술' },
  { sym: 'XLC', label: '커뮤니케이션' },
  { sym: 'XLY', label: '소비재(임의)' },
  { sym: 'XLF', label: '금융' },
  { sym: 'XLI', label: '산업재' },
  { sym: 'XLV', label: '헬스케어' },
  { sym: 'XLE', label: '에너지' },
  { sym: 'XLB', label: '소재' },
  { sym: 'XLRE', label: '부동산' },
  { sym: 'XLP', label: '소비재(필수)' },
  { sym: 'XLU', label: '유틸리티' },
];

function fmtPct(v?: number) {
  if (v == null) return 'N/A';
  return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
}

function fmtPrice(v?: number, sym?: string) {
  if (v == null) return 'N/A';
  if (sym?.includes('BTC') || sym?.includes('ETH')) return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
  if (sym === '^TNX' || sym === '^IRX' || sym === '^FVX') return v.toFixed(3) + '%';
  return v.toFixed(2);
}

function TradingViewHeatmap() {
  const containerRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!containerRef.current) return;
    containerRef.current.innerHTML = '';
    const script = document.createElement('script');
    script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-stock-heatmap.js';
    script.async = true;
    script.textContent = JSON.stringify({
      exchanges: [],
      dataSource: 'SPX500',
      grouping: 'sector',
      blockSize: 'market_cap_basic',
      blockColor: 'change',
      locale: 'en',
      colorTheme: 'dark',
      hasTopBar: false,
      isDataSetEnabled: false,
      isZoomEnabled: true,
      hasSymbolTooltip: true,
      isMonoSize: false,
      width: '100%',
      height: 400,
    });
    containerRef.current.appendChild(script);
    return () => { if (containerRef.current) containerRef.current.innerHTML = ''; };
  }, []);
  return <div ref={containerRef} style={{ borderRadius: 8, overflow: 'hidden' }} />;
}

function getToday() {
  return new Date().toLocaleDateString('ko-KR', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
}

export default function App() {
  const [data, setData] = useState<BriefData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadBrief(force = false) {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/brief${force ? '?force=true' : ''}`);
      if (!res.ok) throw new Error((await res.json()).error);
      setData(await res.json());
    } catch (e: any) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadBrief(); }, []);

  const sectorChartData = SECTORS.map(s => ({
    label: s.label,
    value: data?.quotes[s.sym]?.changePct ?? 0,
  })).sort((a, b) => b.value - a.value);

  return (
    <div className="app">
      <header className="header">
        <div className="header-top">
          <div>
            <h1 className="title">미장 브리핑</h1>
            <p className="date">{getToday()}</p>
          </div>
          <button className="refresh-btn" onClick={() => loadBrief(true)} disabled={loading}>
            {loading ? '생성 중...' : '새로 생성'}
          </button>
        </div>

        {/* 티커 */}
        <div className="ticker-scroll">
          {TICKERS.map(t => {
            const q = data?.quotes[t.sym];
            const up = (q?.changePct ?? 0) >= 0;
            return (
              <div key={t.sym} className="ticker-item">
                <span className="ticker-label">{t.label}</span>
                <span className="ticker-price">{fmtPrice(q?.price, t.sym)}</span>
                <span className={up ? 'up' : 'down'}>{fmtPct(q?.changePct)}</span>
              </div>
            );
          })}
          {data?.fearGreed && (
            <div className="ticker-item">
              <span className="ticker-label">공포탐욕</span>
              <span className="ticker-price">{data.fearGreed.value}</span>
              <span className="ticker-sub">{data.fearGreed.value_classification}</span>
            </div>
          )}
        </div>
      </header>

      <main className="main">
        {error && (
          <div className="error-box">
            오류: {error}
            <br />
            <small>ANTHROPIC_API_KEY가 .env 파일에 설정되어 있는지 확인하세요.</small>
          </div>
        )}

        {loading && !data && (
          <div className="loading-box">
            <div className="spinner" />
            <p>시장 데이터 수집 중 + AI 분석 생성 중...</p>
            <small>약 15~30초 소요돼요</small>
          </div>
        )}

        {data && (
          <>
            {/* AI 브리핑 텍스트 */}
            <section className="card brief-card">
              {data.cached && <span className="cached-badge">캐시됨</span>}
              <div className="brief-text">
                {data.brief.split('\n').filter(Boolean).map((line, i) => (
                  <p key={i} className={line.startsWith('[') ? 'brief-tag' : 'brief-para'}>{line}</p>
                ))}
              </div>
            </section>

            {/* 섹터 차트 */}
            <section className="card">
              <h2 className="card-title">섹터별 등락</h2>
              <ResponsiveContainer width="100%" height={300}>
                <BarChart data={sectorChartData} layout="vertical" margin={{ left: 80, right: 40, top: 4, bottom: 4 }}>
                  <XAxis type="number" tickFormatter={v => `${v}%`} tick={{ fill: '#6b7280', fontSize: 11 }} axisLine={false} tickLine={false} />
                  <YAxis type="category" dataKey="label" tick={{ fill: '#9ca3af', fontSize: 12 }} axisLine={false} tickLine={false} width={80} />
                  <Tooltip
                    formatter={(v: number) => [`${v.toFixed(2)}%`, '']}
                    contentStyle={{ background: '#1a1a2e', border: '1px solid #2a2a3e', borderRadius: 8, color: '#e8e8f0' }}
                  />
                  <Bar dataKey="value" radius={3}>
                    {sectorChartData.map((entry, i) => (
                      <Cell key={i} fill={entry.value >= 0 ? '#00d084' : '#ff4560'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </section>

            {/* TradingView 히트맵 */}
            <section className="card">
              <h2 className="card-title">S&P500 히트맵</h2>
              <TradingViewHeatmap />
            </section>
          </>
        )}
      </main>
    </div>
  );
}
