import 'dotenv/config';
import express from 'express';
import axios from 'axios';
import Anthropic from '@anthropic-ai/sdk';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';
import { TwitterApi } from 'twitter-api-v2';
import { createCanvas } from 'canvas';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(cors());
app.use(express.json());

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

let dailyCache = { date: null, brief: null, quotes: null, fearGreed: null, prevBrief: null };

const SYMBOLS = [
  'SPY', 'QQQ', 'IWM', 'DIA',
  '^VIX',
  'HYG', 'JNK', 'TLT',
  '^IRX', '^FVX', '^TNX',
  'DX-Y.NYB', 'GC=F', 'CL=F',
  'BTC-USD', 'ETH-USD',
  'TSLA', 'NVDA', 'AAPL', 'MSFT', 'AMZN', 'GOOGL', 'META',
  'XLK', 'XLF', 'XLE', 'XLV', 'XLI', 'XLY', 'XLP', 'XLU', 'XLRE', 'XLB', 'XLC',
];

const SECTOR_LABELS = {
  XLK: '기술', XLF: '금융', XLE: '에너지', XLV: '헬스케어',
  XLI: '산업재', XLY: '소비재(임의)', XLP: '소비재(필수)',
  XLU: '유틸리티', XLRE: '부동산', XLB: '소재', XLC: '커뮤니케이션',
};

const SYSTEM_PROMPT = `당신은 월스트리트 10년 경력의 퀀트 트레이더 겸 매크로 분석가입니다. 헤지펀드에서 일하다 독립해 개인 투자자들을 위한 날카로운 시장 분석을 제공하고 있습니다. 당신의 분석은 단순한 수치 해설이 아닌, 시장 참여자들의 심리, 자금 흐름, 그리고 숨겨진 패턴을 읽어내는 것으로 유명합니다. 항상 데이터에 기반하되, 그 이면의 "왜?"를 파고드는 스타일로 분석합니다. 말투는 반드시 친한 친구에게 설명하듯 ~야, ~거야, ~거임, ~보임, ~함, ~잖아, ~인듯, ~같음 같은 캐주얼한 종결어미를 사용해야 합니다. ~입니다, ~합니다, ~거예요, ~습니다 같은 격식체/존댓말은 절대 사용하지 마세요. 단, [요약1], [요약2], [요약3] 세 줄만큼은 X(트위터)에 실제 올리는 글처럼 써야 합니다 — 비문이어도 되고, 축약어 자유롭게 써도 됩니다. ㅋㅋ/ㅠ/ㄷㄷ 같은 감탄사는 3줄 전체에서 최대 1번, 진짜 어울릴 때만 쓰세요. 매 줄마다 붙이면 기계적으로 보입니다.`;

const MA_SYMBOLS = new Set(['SPY', 'QQQ', 'IWM', 'TSLA', 'NVDA', 'AAPL', 'MSFT', 'META']);

async function fetchOneQuote(symbol) {
  const encoded = encodeURIComponent(symbol);
  const range = MA_SYMBOLS.has(symbol) ? '250d' : '2d';
  const { data } = await axios.get(
    `https://query2.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1d&range=${range}`,
    { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' } }
  );
  const result = data.chart.result[0];
  const meta = result.meta;
  const price = meta.regularMarketPrice;
  const prev = meta.chartPreviousClose || meta.previousClose;
  const changePct = prev ? ((price - prev) / prev) * 100 : 0;
  const volume = meta.regularMarketVolume || null;
  const avgVolume = meta.averageDailyVolume3Month || null;
  const volRatio = (volume && avgVolume) ? volume / avgVolume : null;
  const fiftyTwoWeekHigh = meta.fiftyTwoWeekHigh || null;
  const fiftyTwoWeekLow = meta.fiftyTwoWeekLow || null;
  let fiftyDayAverage = null, twoHundredDayAverage = null;
  if (MA_SYMBOLS.has(symbol)) {
    const closes = result.indicators?.quote?.[0]?.close?.filter(v => v != null) || [];
    if (closes.length >= 50) fiftyDayAverage = closes.slice(-50).reduce((a, b) => a + b, 0) / 50;
    if (closes.length >= 200) twoHundredDayAverage = closes.slice(-200).reduce((a, b) => a + b, 0) / 200;
  }
  return { price, changePct, change: price - (prev || price), volume, avgVolume, volRatio, fiftyTwoWeekHigh, fiftyTwoWeekLow, fiftyDayAverage, twoHundredDayAverage };
}

async function fetchQuotes() {
  const results = await Promise.allSettled(SYMBOLS.map(sym => fetchOneQuote(sym)));
  const quotes = {};
  SYMBOLS.forEach((sym, i) => {
    if (results[i].status === 'fulfilled') {
      quotes[sym] = results[i].value;
    }
  });
  return quotes;
}

async function fetchWeeklyChange(symbol) {
  const encoded = encodeURIComponent(symbol);
  const { data } = await axios.get(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1d&range=5d`,
    { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' } }
  );
  const result = data.chart.result[0];
  const closes = result.indicators?.quote?.[0]?.close?.filter(v => v != null);
  if (!closes || closes.length < 2) return null;
  const weekStart = closes[0];
  const weekEnd = closes[closes.length - 1];
  return ((weekEnd - weekStart) / weekStart) * 100;
}

async function fetchWeeklyChanges() {
  const WEEKLY_SYMBOLS = [
    'SPY', 'QQQ', 'IWM', 'DIA', '^VIX', 'BTC-USD', 'ETH-USD',
    'GC=F', 'CL=F', 'DX-Y.NYB', '^TNX', '^IRX', '^FVX',
    'HYG', 'JNK', 'TLT',
    'XLK', 'XLF', 'XLE', 'XLV', 'XLI', 'XLY', 'XLP', 'XLU', 'XLRE', 'XLB', 'XLC',
    'TSLA', 'NVDA', 'AAPL', 'MSFT', 'META',
  ];
  const results = await Promise.allSettled(WEEKLY_SYMBOLS.map(sym => fetchWeeklyChange(sym)));
  const weekly = {};
  WEEKLY_SYMBOLS.forEach((sym, i) => {
    if (results[i].status === 'fulfilled' && results[i].value !== null) {
      weekly[sym] = results[i].value;
    }
  });
  return weekly;
}

async function fetchFearGreed() {
  try {
    const { data } = await axios.get('https://api.alternative.me/fng/?limit=7');
    const latest = data.data[0];
    const trend = data.data.slice(0, 7).map(d => Number(d.value));
    const trendDir = trend.length >= 2
      ? (trend[0] > trend[trend.length - 1] ? '▲상승중' : '▼하락중')
      : '';
    return { ...latest, trend: trend.join('→'), trendDir };
  } catch {
    return { value: 'N/A', value_classification: 'Unknown', trend: '', trendDir: '' };
  }
}

async function fetchNews() {
  try {
    const { data } = await axios.get(
      'https://feeds.finance.yahoo.com/rss/2.0/headline?s=SPY,QQQ,NVDA,TSLA,BTC-USD&region=US&lang=en-US',
      { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 6000 }
    );
    const titles = [...data.matchAll(/<title><!\[CDATA\[(.*?)\]\]><\/title>/g)]
      .map(m => m[1])
      .filter(t => !t.toLowerCase().includes('yahoo finance'))
      .slice(0, 8);
    return titles;
  } catch {
    return [];
  }
}

async function fetchEconomicCalendar() {
  try {
    const { data } = await axios.get(
      'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
      { timeout: 6000 }
    );
    return data
      .filter(e => e.country === 'USD' && (e.impact === 'High' || e.impact === 'Medium'))
      .slice(0, 8);
  } catch {
    return [];
  }
}

async function fetchNextWeekCalendar() {
  try {
    const { data } = await axios.get(
      'https://nfs.faireconomy.media/ff_calendar_nextweek.json',
      { timeout: 6000 }
    );
    return data
      .filter(e => e.country === 'USD' && (e.impact === 'High' || e.impact === 'Medium'))
      .slice(0, 10);
  } catch {
    return [];
  }
}

async function fetchEarningsNextWeek() {
  try {
    const today = new Date();
    const results = [];
    // 다음 주 월~금 날짜 생성
    const daysUntilMonday = (8 - today.getUTCDay()) % 7 || 7;
    for (let i = 0; i < 5; i++) {
      const d = new Date(today);
      d.setUTCDate(today.getUTCDate() + daysUntilMonday + i);
      const dateStr = d.toISOString().split('T')[0];
      try {
        const { data } = await axios.get(
          `https://api.nasdaq.com/api/calendar/earnings?date=${dateStr}`,
          { headers: { 'User-Agent': 'Mozilla/5.0', 'Accept': 'application/json' }, timeout: 6000 }
        );
        const rows = data?.data?.rows || [];
        const major = rows.filter(r => {
          const sym = (r.symbol || '').toUpperCase();
          return ['TSLA','NVDA','AAPL','MSFT','META','AMZN','GOOGL','NFLX','AMD','INTC','PLTR','COIN'].includes(sym);
        }).map(r => `${r.symbol}(${dateStr.slice(5)})`);
        results.push(...major);
      } catch {}
    }
    return results.length > 0 ? results : [];
  } catch {
    return [];
  }
}

function buildPrompt(quotes, fg, today, news, calendar, prevBrief, earnings) {
  const f = (sym) => {
    const q = quotes[sym];
    if (!q) return 'N/A';
    const sign = q.changePct >= 0 ? '+' : '';
    const decimals = sym.includes('BTC') || sym.includes('ETH') ? 0 : 2;
    return `${q.price?.toFixed(decimals)} (${sign}${q.changePct?.toFixed(2)}%)`;
  };

  const fYield = (sym) => {
    const q = quotes[sym];
    if (!q) return 'N/A';
    const sign = q.changePct >= 0 ? '+' : '';
    return `${q.price?.toFixed(3)}% (${sign}${q.changePct?.toFixed(2)}%)`;
  };

  const fLevel = (sym) => {
    const q = quotes[sym];
    if (!q || !q.twoHundredDayAverage) return '';
    const ma200 = q.twoHundredDayAverage;
    const ma50 = q.fiftyDayAverage;
    const pct200 = ((q.price - ma200) / ma200 * 100).toFixed(1);
    const pct52h = q.fiftyTwoWeekHigh ? ((q.price - q.fiftyTwoWeekHigh) / q.fiftyTwoWeekHigh * 100).toFixed(1) : null;
    const ma50str = ma50 ? ` | 50MA ${ma50.toFixed(2)}` : '';
    const h52str = pct52h ? ` | 52주고점대비 ${pct52h}%` : '';
    return ` [200MA ${ma200.toFixed(2)} (${pct200 >= 0 ? '+' : ''}${pct200}%)${ma50str}${h52str}]`;
  };

  const yc10 = quotes['^TNX']?.price;
  const yc3m = quotes['^IRX']?.price;
  const ycSpread = (yc10 && yc3m) ? (yc10 - yc3m).toFixed(3) : 'N/A';
  const ycLabel = ycSpread !== 'N/A' ? (parseFloat(ycSpread) < 0 ? ' [역전 중!]' : '') : '';

  const volNote = (sym) => {
    const q = quotes[sym];
    if (!q?.volRatio) return '';
    const pct = Math.round(q.volRatio * 100);
    if (pct > 150) return ` [거래량 급증 ${pct}%]`;
    if (pct < 60) return ` [거래량 저조 ${pct}%]`;
    return '';
  };

  const sectorLines = Object.keys(SECTOR_LABELS).map(sym => {
    const q = quotes[sym];
    const sign = (q?.changePct ?? 0) >= 0 ? '+' : '';
    return `  ${SECTOR_LABELS[sym]}: ${sign}${q?.changePct?.toFixed(2)}%`;
  }).join('\n');

  const newsSection = news.length > 0
    ? `\n[오늘의 주요 뉴스 헤드라인]\n${news.map((n, i) => `${i + 1}. ${n}`).join('\n')}`
    : '';

  const calendarSection = calendar.length > 0
    ? `\n[이번 주 주요 경제 이벤트 (USD)]\n${calendar.map(e =>
        `  ${e.date} ${e.time} - ${e.title}${e.forecast ? ` | 예측: ${e.forecast}, 이전: ${e.previous}` : ''}${e.actual ? ` | 실제: ${e.actual}` : ''}`
      ).join('\n')}`
    : '';

  const earningsSection = earnings?.length > 0
    ? `\n[다음 주 주요 어닝 일정]\n  ${earnings.join(', ')}`
    : '';

  const prevSection = prevBrief
    ? `\n[전날 브리핑 (연속성 참고용 - 직접 인용하지 말 것)]\n${prevBrief.slice(0, 1000)}`
    : '';

  const fgTrend = fg.trend ? ` | 7일 추세: ${fg.trend} ${fg.trendDir}` : '';

  return `오늘 날짜: ${today}

[오늘의 미장 데이터]
주요 지수: SPY ${f('SPY')}${fLevel('SPY')}${volNote('SPY')} / QQQ ${f('QQQ')}${fLevel('QQQ')}${volNote('QQQ')} / IWM ${f('IWM')} / DIA ${f('DIA')}
변동성: VIX ${f('^VIX')} | 공포탐욕지수 ${fg.value} (${fg.value_classification})${fgTrend}
채권: HYG ${f('HYG')} / JNK ${f('JNK')} / TLT ${f('TLT')}
수익률 커브: 3개월 ${fYield('^IRX')} / 5년 ${fYield('^FVX')} / 10년 ${fYield('^TNX')} | 3M-10Y 스프레드: ${ycSpread}%${ycLabel}
매크로: 달러(DXY) ${f('DX-Y.NYB')} / 금 ${f('GC=F')} / 오일(WTI) ${f('CL=F')}
크립토: BTC ${f('BTC-USD')} / ETH ${f('ETH-USD')}
주요종목: TSLA ${f('TSLA')}${fLevel('TSLA')}${volNote('TSLA')} / NVDA ${f('NVDA')}${fLevel('NVDA')}${volNote('NVDA')} / AAPL ${f('AAPL')}${fLevel('AAPL')} / MSFT ${f('MSFT')}${fLevel('MSFT')} / META ${f('META')}${fLevel('META')}
섹터별 등락:
${sectorLines}
${newsSection}
${calendarSection}
${earningsSection}
${prevSection}

위 데이터를 바탕으로 오늘의 미장 마감 브리핑을 작성해주세요.

[스타일 가이드]
- 반드시 아래 네 줄로 시작할 것:
  첫째 줄: "[카지노 마켓] ${today} 미장 마감 브리핑"
  둘째 줄: "[요약1] " + 오늘 장 보면서 실제로 느낀 것. 숫자 박고 감정 그대로. 비문/축약 OK. 15자 이내. 감탄사(ㅋㅋ/ㅠ)는 3줄 중 최대 1번만. (예: "VIX 28 이게뭔데", "나스닥 -2% 진짜 싫다", "공포탐욕 19 바닥이길", "SPY 또 털렸음 ㅠ")
  셋째 줄: "[요약2] " + 오늘 장에서 남들이 놓친 거 한 줄. 교과서 답 말고 진짜 투자자 시각으로. 20자 이내. (예: "채권이 진작에 알고 있었음", "거래량 없는 반등 믿지 마", "달러 강한데 금도 오르는 게 이상함")
  넷째 줄: "[요약3] " + 지금 당장 어떻게 할 건지. 개인 의견처럼. 15자 이내. (예: "지금 포지 반만 들고 있어야함", "현금이 제일 나은 구간", "지지선 지키면 그때 들어감")
  다섯째 줄부터 본문 시작
- 말투: 반드시 친한 친구에게 설명하듯 ~야, ~거야, ~거임, ~보임, ~함, ~잖아, ~인듯, ~같음 등 캐주얼 종결어미 사용. ~입니다/~합니다/~거예요/~습니다 절대 금지
- 구어체 한국어 + 영어 금융 용어 자연스럽게 혼용 (레버설, 컨펌, 다이버전스, 숏스퀴즈, 캐피툴레이션, 풀백, 리테스트 등)
- 단순 수치 나열 금지, 각 지표의 의미와 맥락 설명
- 여러 지표 상관관계 분석 (VIX vs HYG, 달러 vs 금, 크립토 vs 나스닥 등)
- 수익률 커브 상태와 경기 사이클 시사점 반드시 언급
- 거래량 이상 시 특별히 언급
- 오늘 주요 뉴스와 가격 움직임의 인과관계 분석
- 200MA, 50MA 대비 현재 위치 → "위에 있으면 강세 구조 유지" / "아래 깨지면 위험" 식으로 의미 해석 필수
- 52주 고점 대비 위치로 현재 가격이 어느 사이클인지 맥락 제공
- BTC, ETH 각각 개별 코멘트 필수 (나스닥과의 상관관계, 디커플링 여부)
- TSLA, NVDA 각각 개별 코멘트 필수 (현재 레벨 vs MA, 지지/저항, 단기 모멘텀)
- AAPL, MSFT 중 오늘 움직임이 의미 있는 쪽 코멘트
- 공포탐욕지수 7일 추세 해석 — 방향성이 바뀌는 중인지, 극단값에서 반전 가능성 있는지
- [강세 시나리오] 구체적 조건 + "이 경우 SPY/QQQ 어느 레벨까지 열린다" 식으로 작성
- [약세 시나리오] 구체적 조건 + "이 경우 어느 레벨이 1차 지지, 거기서 반등 못 하면 어디까지"
- [다음 주 주목 이벤트] 어닝 일정 있으면 구체적으로 — "NVDA 실적 전 포지션 어떻게 관리할지"
- [투자 액션 제안] 현재 상황에서 관망/분할매수/헷지 중 어느 전략이 유리한지 한 줄로 명시
- 마지막: 투자 마인드셋 한 마디
- 길이: 1400~1800자
- 마크다운 문법(**, ##, -, * 등) 절대 사용 금지. 순수 텍스트로만 작성`;
}

function buildSaturdayPrompt(quotes, weekly, fg, today, news, prevBrief, nextWeekCalendar, earnings) {
  const fw = (sym) => {
    const w = weekly[sym];
    if (w == null) return 'N/A';
    const sign = w >= 0 ? '+' : '';
    return `${sign}${w.toFixed(2)}%`;
  };
  const f = (sym) => {
    const q = quotes[sym];
    if (!q) return 'N/A';
    const sign = q.changePct >= 0 ? '+' : '';
    const decimals = sym.includes('BTC') || sym.includes('ETH') ? 0 : 2;
    return `${q.price?.toFixed(decimals)} (${sign}${q.changePct?.toFixed(2)}%)`;
  };

  const fLevel = (sym) => {
    const q = quotes[sym];
    if (!q || !q.twoHundredDayAverage) return '';
    const ma200 = q.twoHundredDayAverage;
    const pct200 = ((q.price - ma200) / ma200 * 100).toFixed(1);
    const pct52h = q.fiftyTwoWeekHigh ? ((q.price - q.fiftyTwoWeekHigh) / q.fiftyTwoWeekHigh * 100).toFixed(1) : null;
    const h52str = pct52h ? ` | 52주고점대비 ${pct52h}%` : '';
    return ` [200MA ${ma200.toFixed(2)} (${pct200 >= 0 ? '+' : ''}${pct200}%)${h52str}]`;
  };

  const yc10w = weekly['^TNX'];
  const yc3mw = weekly['^IRX'];
  const ycWeeklyNote = (yc10w != null && yc3mw != null)
    ? `커브 변화: 3M ${yc3mw >= 0 ? '+' : ''}${yc3mw?.toFixed(2)}% / 10Y ${yc10w >= 0 ? '+' : ''}${yc10w?.toFixed(2)}%`
    : '';

  const sectorWeekly = Object.keys(SECTOR_LABELS).map(sym => {
    const w = weekly[sym];
    const sign = (w ?? 0) >= 0 ? '+' : '';
    return `  ${SECTOR_LABELS[sym]}: ${w != null ? sign + w.toFixed(2) + '%' : 'N/A'}`;
  }).join('\n');

  const newsSection = news.length > 0
    ? `\n[이번 주 주요 뉴스 헤드라인]\n${news.map((n, i) => `${i + 1}. ${n}`).join('\n')}`
    : '';

  const nextWeekSection = nextWeekCalendar?.length > 0
    ? `\n[다음 주 주요 경제 이벤트 (USD)]\n${nextWeekCalendar.map(e =>
        `  ${e.date} ${e.time} - ${e.title}${e.forecast ? ` | 예측: ${e.forecast}, 이전: ${e.previous}` : ''}`
      ).join('\n')}`
    : '';

  const earningsSection = earnings?.length > 0
    ? `\n[다음 주 주요 어닝 일정]\n  ${earnings.join(', ')}`
    : '';

  const prevSection = prevBrief
    ? `\n[지난 브리핑 (연속성 참고용)]\n${prevBrief.slice(0, 1000)}`
    : '';

  const fgTrend = fg.trend ? ` | 7일 추세: ${fg.trend} ${fg.trendDir}` : '';

  return `오늘 날짜: ${today} (토요일 — 미국 주식시장 휴장)

[이번 주 주간 등락 결산]
주요 지수: SPY ${fw('SPY')}${fLevel('SPY')} / QQQ ${fw('QQQ')}${fLevel('QQQ')} / IWM ${fw('IWM')} / DIA ${fw('DIA')}
변동성: VIX 주간 ${fw('^VIX')} | 공포탐욕지수 현재 ${fg.value} (${fg.value_classification})${fgTrend}
채권 주간: HYG ${fw('HYG')} / JNK ${fw('JNK')} / TLT ${fw('TLT')}
수익률 커브 주간: ${ycWeeklyNote}
매크로 주간: 달러(DXY) ${fw('DX-Y.NYB')} / 금 ${fw('GC=F')} / 오일(WTI) ${fw('CL=F')} / 10Y금리 ${fw('^TNX')}
크립토(주말 실시간): BTC ${f('BTC-USD')} (주간 ${fw('BTC-USD')}) / ETH ${f('ETH-USD')} (주간 ${fw('ETH-USD')})
주요 종목 주간: TSLA ${fw('TSLA')}${fLevel('TSLA')} / NVDA ${fw('NVDA')}${fLevel('NVDA')} / AAPL ${fw('AAPL')}${fLevel('AAPL')} / MSFT ${fw('MSFT')}${fLevel('MSFT')} / META ${fw('META')}
섹터 주간 등락:
${sectorWeekly}
${newsSection}
${nextWeekSection}
${earningsSection}
${prevSection}

위 데이터를 바탕으로 토요일 주간 결산 브리핑을 작성해주세요.

[스타일 가이드]
- 반드시 아래 네 줄로 시작할 것:
  첫째 줄: "[카지노 마켓] ${today} 주간 결산"
  둘째 줄: "[요약1] " + 이번 주 버티면서 실제로 느낀 것. 숫자 박고 감정 그대로. 비문/축약 OK. 15자 이내. (예: "주간 -3% ㅠ 겨우 버팀", "VIX 32 찍었다가 회복 ㄷㄷ", "이번 주 진짜 멘탈 탔음")
  셋째 줄: "[요약2] " + 이번 주 남들이 놓친 거 한 줄. 교과서 답 말고 진짜 시각으로. 20자 이내. (예: "기술주 빠지는 동안 에너지만 혼자 올랐음", "달러 강세인데 금도 같이 올라서 이상함")
  넷째 줄: "[요약3] " + 다음 주 어떻게 할 건지 개인 의견처럼. 15자 이내. (예: "FOMC 전까진 그냥 관망임", "200MA 지키면 비중 유지 예정")
  다섯째 줄부터 본문 시작
- 이번 주 전체 흐름과 핵심 테마 정리 — 한 주를 관통한 내러티브
- 주간 섹터 로테이션 심층 분석 — 자금이 어디로 몰렸고 왜 그런지
- 채권(HYG/JNK/TLT) 주간 변화 → 크레딧 시장이 리스크를 어떻게 평가하는지
- 수익률 커브 주간 변화 → 금리 기대가 어느 방향으로 이동했는지
- BTC/ETH 주말 실시간 동향 — 주식 대비 디커플링/커플링 여부
- 200MA 대비 SPY/QQQ 현재 위치 → 이번 주 주요 MA 돌파/이탈 여부 해석
- TSLA, NVDA 주간 성과 + 현재 기술적 레벨 의미
- [강세 시나리오] 다음 주 이어질 조건 + 목표 레벨
- [약세 시나리오] 반전 조건 + 지지 레벨
- [다음 주 주목 이벤트] 경제 지표 + 어닝 일정 → "어떤 수치가 나오면 어떻게 반응할지" 구체적으로
- [투자 액션 제안] 이번 주 흐름 바탕으로 다음 주 포지션 전략 한 줄 (관망/비중 유지/분할매수 타이밍 등)
- 마지막: 주말 투자 마인드셋 한 마디
- 길이: 1400~1800자
- 말투: 반드시 친한 친구에게 설명하듯 ~야, ~거야, ~거임, ~보임, ~함, ~잖아, ~인듯, ~같음 등 캐주얼 종결어미 사용. ~입니다/~합니다/~거예요/~습니다 절대 금지
- 구어체 한국어 + 영어 금융 용어 혼용
- 마크다운 문법(**, ##, -, * 등) 절대 사용 금지. 순수 텍스트로만 작성`;
}

function buildSundayPrompt(quotes, weekly, fg, today, news, nextWeekCalendar, prevBrief, earnings) {
  const fw = (sym) => {
    const w = weekly[sym];
    if (w == null) return 'N/A';
    const sign = w >= 0 ? '+' : '';
    return `${sign}${w.toFixed(2)}%`;
  };
  const f = (sym) => {
    const q = quotes[sym];
    if (!q) return 'N/A';
    const sign = q.changePct >= 0 ? '+' : '';
    const decimals = sym.includes('BTC') || sym.includes('ETH') ? 0 : 2;
    return `${q.price?.toFixed(decimals)} (${sign}${q.changePct?.toFixed(2)}%)`;
  };

  const fLevel = (sym) => {
    const q = quotes[sym];
    if (!q || !q.twoHundredDayAverage) return '';
    const ma200 = q.twoHundredDayAverage;
    const pct200 = ((q.price - ma200) / ma200 * 100).toFixed(1);
    const pct52h = q.fiftyTwoWeekHigh ? ((q.price - q.fiftyTwoWeekHigh) / q.fiftyTwoWeekHigh * 100).toFixed(1) : null;
    const h52str = pct52h ? ` | 52주고점대비 ${pct52h}%` : '';
    return ` [200MA ${ma200.toFixed(2)} (${pct200 >= 0 ? '+' : ''}${pct200}%)${h52str}]`;
  };

  const yc10 = quotes['^TNX']?.price;
  const yc3m = quotes['^IRX']?.price;
  const ycSpread = (yc10 && yc3m) ? (yc10 - yc3m).toFixed(3) : 'N/A';
  const ycLabel = ycSpread !== 'N/A' ? (parseFloat(ycSpread) < 0 ? ' [역전 중!]' : '') : '';

  const sectorWeekly = Object.keys(SECTOR_LABELS).map(sym => {
    const w = weekly[sym];
    const sign = (w ?? 0) >= 0 ? '+' : '';
    return `  ${SECTOR_LABELS[sym]}: ${w != null ? sign + w.toFixed(2) + '%' : 'N/A'}`;
  }).join('\n');

  const calendarSection = nextWeekCalendar.length > 0
    ? `\n[다음 주 주요 경제 이벤트 (USD)]\n${nextWeekCalendar.map(e =>
        `  ${e.date} ${e.time} - ${e.title}${e.forecast ? ` | 예측: ${e.forecast}, 이전: ${e.previous}` : ''}`
      ).join('\n')}`
    : '';

  const earningsSection = earnings?.length > 0
    ? `\n[다음 주 주요 어닝 일정]\n  ${earnings.join(', ')}`
    : '';

  const newsSection = news.length > 0
    ? `\n[최신 뉴스 헤드라인]\n${news.map((n, i) => `${i + 1}. ${n}`).join('\n')}`
    : '';

  const prevSection = prevBrief
    ? `\n[지난 브리핑 (연속성 참고용)]\n${prevBrief.slice(0, 1000)}`
    : '';

  const fgTrend = fg.trend ? ` | 7일 추세: ${fg.trend} ${fg.trendDir}` : '';

  return `오늘 날짜: ${today} (일요일 — 내일 월요일 장 시작 전날)

[현재 시장 상태]
주요 지수 주간: SPY ${fw('SPY')}${fLevel('SPY')} / QQQ ${fw('QQQ')}${fLevel('QQQ')} / IWM ${fw('IWM')}
공포탐욕지수: ${fg.value} (${fg.value_classification})${fgTrend}
채권 주간: HYG ${fw('HYG')} / JNK ${fw('JNK')} / TLT ${fw('TLT')}
수익률 커브: 3M ${quotes['^IRX']?.price?.toFixed(3) || 'N/A'}% / 10Y ${quotes['^TNX']?.price?.toFixed(3) || 'N/A'}% | 3M-10Y 스프레드: ${ycSpread}%${ycLabel}
매크로 주간: 달러(DXY) ${fw('DX-Y.NYB')} / 금 ${fw('GC=F')} / 오일(WTI) ${fw('CL=F')} / 10Y금리 ${fw('^TNX')}
크립토 실시간: BTC ${f('BTC-USD')} (주간 ${fw('BTC-USD')}) / ETH ${f('ETH-USD')} (주간 ${fw('ETH-USD')})
주요 종목 주간: TSLA ${fw('TSLA')}${fLevel('TSLA')} / NVDA ${fw('NVDA')}${fLevel('NVDA')} / AAPL ${fw('AAPL')}${fLevel('AAPL')} / MSFT ${fw('MSFT')}${fLevel('MSFT')}
섹터 주간 등락:
${sectorWeekly}
${calendarSection}
${earningsSection}
${newsSection}
${prevSection}

위 데이터를 바탕으로 일요일 다음 주 프리뷰 브리핑을 작성해주세요.

[스타일 가이드]
- 반드시 아래 네 줄로 시작할 것:
  첫째 줄: "[카지노 마켓] ${today} 다음 주 프리뷰"
  둘째 줄: "[요약1] " + 다음 주 앞두고 지금 느끼는 것. 숫자/이벤트 박고 감정 그대로. 비문/축약 OK. 15자 이내. (예: "FOMC 앞두고 아무것도 못 함", "어닝 3개 겹침 ㄷㄷ", "이번 주 털렸는데 다음 주도 무섭")
  셋째 줄: "[요약2] " + 다음 주 남들이 놓칠 핵심 변수 1개. 교과서 답 말고. 20자 이내. (예: "연준보다 달러 방향이 더 중요함", "어닝보다 가이던스가 진짜임", "지표보다 시장 반응 패턴이 중요")
  넷째 줄: "[요약3] " + 월요일 장 전 어떻게 할 건지 개인 의견처럼. 15자 이내. (예: "갭업이면 절반 팔 생각임", "200MA 위면 그냥 홀딩")
  다섯째 줄부터 본문 시작
- 이번 주 흐름 요약 → 다음 주로 이어지는 맥락 제공
- 다음 주 주요 경제 이벤트 각각의 시장 영향 전망 — "예측치보다 높으면/낮으면 어떻게 반응할지" 구체적으로
- 200MA, 50MA 대비 SPY/QQQ 현재 위치 → 월요일 갭업/갭다운 시 어느 레벨이 의미 있는지
- 채권(HYG/JNK) 주간 변화 → 다음 주 리스크 온/오프 방향성 예측
- BTC/ETH 일요일 실시간 동향 + 월요일 크립토 방향성 전망
- 섹터 로테이션 주간 데이터 기반 → 다음 주 어느 섹터가 유리할지
- [강세 시나리오] 월요일 갭업 조건 + 다음 주 목표 레벨
- [약세 시나리오] 월요일 갭다운 조건 + 핵심 지지 레벨 (여기 깨지면 어디까지)
- [다음 주 어닝] 실적 발표 예정 종목 → 포지션 관리 방법 구체적으로 (실적 전 매도/홀딩/진입 타이밍)
- [투자 액션 제안] 월요일 장 시작 전 체크리스트 형식으로 — 확인할 지표, 진입/관망 조건 명시
- 마지막: 월요일 장 전 마인드셋 한 마디
- 길이: 1400~1800자
- 말투: 반드시 친한 친구에게 설명하듯 ~야, ~거야, ~거임, ~보임, ~함, ~잖아, ~인듯, ~같음 등 캐주얼 종결어미 사용. ~입니다/~합니다/~거예요/~습니다 절대 금지
- 구어체 한국어 + 영어 금융 용어 혼용
- 마크다운 문법(**, ##, -, * 등) 절대 사용 금지. 순수 텍스트로만 작성`;
}

app.get('/api/brief', async (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const force = req.query.force === 'true';

  if (!force && dailyCache.date === today && dailyCache.brief) {
    return res.json({
      brief: dailyCache.brief,
      quotes: dailyCache.quotes,
      fearGreed: dailyCache.fearGreed,
      cached: true,
    });
  }

  try {
    const [quotes, fearGreed, news, calendar, earnings] = await Promise.all([
      fetchQuotes(),
      fetchFearGreed(),
      fetchNews(),
      fetchEconomicCalendar(),
      fetchEarningsNextWeek(),
    ]);

    const prevBrief = dailyCache.date !== today ? dailyCache.brief : dailyCache.prevBrief;
    const prompt = buildPrompt(quotes, fearGreed, today, news, calendar, prevBrief, earnings);

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: prompt }],
    });

    const rawBrief = msg.content[0].text;
    const briefLines = rawBrief.split('\n');
    const titleIdx = briefLines.findIndex(l => l.includes('미장 마감 브리핑'));
    if (titleIdx !== -1) briefLines[titleIdx] = `[카지노 마켓] ${today} 미장 마감 브리핑`;
    const brief = briefLines.join('\n');
    dailyCache = { date: today, brief, quotes, fearGreed, prevBrief };

    res.json({ brief, quotes, fearGreed, cached: false });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/quotes', async (req, res) => {
  try {
    const [quotes, fearGreed] = await Promise.all([fetchQuotes(), fetchFearGreed()]);
    res.json({ quotes, fearGreed });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3001;

// 트위터 자동 포스팅
const twitterClient = (process.env.X_API_KEY) ? new TwitterApi({
  appKey: process.env.X_API_KEY,
  appSecret: process.env.X_API_SECRET,
  accessToken: process.env.X_ACCESS_TOKEN,
  accessSecret: process.env.X_ACCESS_SECRET,
}) : null;

function generateTextImage(brief) {
  const W = 800;
  const FONT_SIZE = 15;
  const LINE_HEIGHT = 22;
  const PAD_X = 30;
  const PAD_Y = 30;
  const maxTextW = W - PAD_X * 2;

  // 텍스트를 줄바꿈 처리
  const tmpCanvas = createCanvas(W, 100);
  const tmpCtx = tmpCanvas.getContext('2d');
  tmpCtx.font = `${FONT_SIZE}px sans-serif`;

  const paragraphs = brief.split('\n');
  const wrappedLines = [];
  for (const para of paragraphs) {
    if (!para.trim()) { wrappedLines.push(''); continue; }
    let line = '';
    for (const char of para) {
      const test = line + char;
      if (tmpCtx.measureText(test).width > maxTextW) {
        wrappedLines.push(line);
        line = char;
      } else {
        line = test;
      }
    }
    if (line) wrappedLines.push(line);
  }

  const H = PAD_Y * 2 + wrappedLines.length * LINE_HEIGHT + 10;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = '#0f1117';
  ctx.fillRect(0, 0, W, H);

  ctx.fillStyle = '#e0e0e0';
  ctx.font = `${FONT_SIZE}px sans-serif`;

  wrappedLines.forEach((line, i) => {
    ctx.fillText(line, PAD_X, PAD_Y + i * LINE_HEIGHT + FONT_SIZE);
  });

  return canvas.toBuffer('image/png');
}

function generateMarketImage(quotes, fearGreed) {
  const W = 800, H = 520;
  const canvas = createCanvas(W, H);
  const ctx = canvas.getContext('2d');

  // 배경
  ctx.fillStyle = '#0f1117';
  ctx.fillRect(0, 0, W, H);

  // 헤더
  ctx.fillStyle = '#ffffff';
  ctx.font = 'bold 22px sans-serif';
  const today = new Date().toISOString().split('T')[0];
  ctx.fillText(`🎰 카지노마켓  ${today} 미장 마감`, 24, 40);
  ctx.fillStyle = '#444';
  ctx.fillRect(24, 52, W - 48, 1);

  // 지표 카드
  const mainSymbols = [
    { sym: 'SPY', label: 'SPY' },
    { sym: 'QQQ', label: 'QQQ' },
    { sym: 'IWM', label: 'IWM' },
    { sym: '^VIX', label: 'VIX' },
    { sym: 'BTC-USD', label: 'BTC' },
    { sym: 'GC=F', label: 'GOLD' },
  ];

  const cardW = 120, cardH = 70, cardGap = 12;
  const startX = 24, startY = 68;

  mainSymbols.forEach(({ sym, label }, i) => {
    const q = quotes?.[sym];
    const x = startX + i * (cardW + cardGap);
    const y = startY;
    const up = (q?.changePct ?? 0) >= 0;
    const cardColor = up ? '#0d2b1e' : '#2b0d0d';
    const textColor = up ? '#00c87a' : '#ff4d4d';

    ctx.fillStyle = cardColor;
    ctx.beginPath();
    ctx.roundRect(x, y, cardW, cardH, 8);
    ctx.fill();

    ctx.fillStyle = '#aaa';
    ctx.font = '12px sans-serif';
    ctx.fillText(label, x + 10, y + 20);

    ctx.fillStyle = '#fff';
    ctx.font = 'bold 16px sans-serif';
    const price = q ? (sym.includes('BTC') ? q.price.toLocaleString('en', { maximumFractionDigits: 0 }) : q.price.toFixed(2)) : 'N/A';
    ctx.fillText(price, x + 10, y + 42);

    ctx.fillStyle = textColor;
    ctx.font = 'bold 13px sans-serif';
    const sign = up ? '+' : '';
    const pct = q ? `${sign}${q.changePct.toFixed(2)}%` : '';
    ctx.fillText(pct, x + 10, y + 60);
  });

  // 구분선
  ctx.fillStyle = '#333';
  ctx.fillRect(24, 152, W - 48, 1);

  // 섹터 바차트
  ctx.fillStyle = '#888';
  ctx.font = '12px sans-serif';
  ctx.fillText('섹터별 등락', 24, 174);

  const sectors = Object.entries(SECTOR_LABELS).map(([sym, label]) => ({
    label,
    pct: quotes?.[sym]?.changePct ?? 0,
  })).sort((a, b) => b.pct - a.pct);

  const barAreaX = 24, barY = 185;
  const barMaxW = 340, barH = 22, barGap = 5;
  const maxAbs = Math.max(...sectors.map(s => Math.abs(s.pct)), 1);

  sectors.forEach(({ label, pct }, i) => {
    const y = barY + i * (barH + barGap);
    const up = pct >= 0;
    const barLen = Math.abs(pct) / maxAbs * barMaxW * 0.45;

    ctx.fillStyle = '#222';
    ctx.font = '11px sans-serif';
    ctx.fillStyle = '#ccc';
    ctx.fillText(label, barAreaX, y + 15);

    const barX = barAreaX + 90;
    ctx.fillStyle = up ? '#00c87a' : '#ff4d4d';
    ctx.fillRect(barX, y + 2, barLen, barH - 4);

    ctx.fillStyle = up ? '#00c87a' : '#ff4d4d';
    ctx.font = 'bold 11px sans-serif';
    const sign = up ? '+' : '';
    ctx.fillText(`${sign}${pct.toFixed(2)}%`, barX + barLen + 6, y + 15);
  });

  // 우측 추가 지표
  const rightX = 460;
  ctx.fillStyle = '#888';
  ctx.font = '12px sans-serif';
  ctx.fillText('추가 지표', rightX, 174);

  const extras = [
    { label: '달러(DXY)', sym: 'DX-Y.NYB' },
    { label: '10Y 금리', sym: '^TNX' },
    { label: 'ETH', sym: 'ETH-USD' },
    { label: 'TSLA', sym: 'TSLA' },
    { label: 'NVDA', sym: 'NVDA' },
    { label: '공포탐욕', sym: null },
  ];

  extras.forEach(({ label, sym }, i) => {
    const y = barY + i * (barH + barGap);
    const q = sym ? quotes?.[sym] : null;
    const up = sym ? (q?.changePct ?? 0) >= 0 : parseInt(fearGreed?.value ?? 50) >= 50;

    ctx.fillStyle = '#ccc';
    ctx.font = '11px sans-serif';
    ctx.fillText(label, rightX, y + 15);

    ctx.fillStyle = up ? '#00c87a' : '#ff4d4d';
    ctx.font = 'bold 11px sans-serif';
    let val = 'N/A';
    if (sym && q) {
      const sign = up ? '+' : '';
      val = `${q.price.toFixed(sym === 'ETH-USD' ? 0 : 2)}  ${sign}${q.changePct.toFixed(2)}%`;
    } else if (!sym && fearGreed?.value) {
      val = `${fearGreed.value} (${fearGreed.value_classification})`;
    }
    ctx.fillText(val, rightX + 80, y + 15);
  });

  return canvas.toBuffer('image/png');
}

async function generateEnglishImage(brief, dayType) {
  const headerLabels = { weekday: 'US Market Close', saturday: 'Weekly Wrap-Up', sunday: 'Week Ahead Preview' };
  const today = new Date().toISOString().split('T')[0];
  const header = `[CasinoMarket] ${today} ${headerLabels[dayType] || 'US Market'}`;

  let enBrief = '';
  try {
    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 4096,
      messages: [{
        role: 'user',
        content: `Translate and adapt the following Korean stock market briefing into English. Keep the same structure and length: start with the title line "${header}", then a one-line summary starting with "[Summary] ", then the full analysis in plain text (no markdown). Target 1200-1600 characters.\n\n${brief}`,
      }],
    });
    enBrief = msg.content[0].text.trim();
  } catch {
    enBrief = `${header}\n[Summary] US market briefing unavailable.`;
  }

  return generateTextImage(enBrief);
}

async function takeScreenshot() {
  const browser = await puppeteer.launch({
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu'],
    headless: true,
  });
  const page = await browser.newPage();
  await page.setViewport({ width: 390, height: 844, deviceScaleFactor: 1 });
  await page.goto(`https://market-brief.fly.dev`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForSelector('.brief-text', { timeout: 60000 });
  // 전체 페이지 캡처
  const screenshot = await page.screenshot({ type: 'png', fullPage: true });
  await browser.close();
  return screenshot;
}

function getDayType() {
  const d = new Date().getUTCDay();
  if (d === 6) return 'saturday';
  if (d === 0) return 'sunday';
  return 'weekday';
}

async function postDailyTweetWithRetry(dayType = 'weekday', maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      await postDailyTweet(dayType);
      return;
    } catch (e) {
      const isOverloaded = e.message?.includes('overloaded') || e.status === 529;
      if (attempt < maxRetries && isOverloaded) {
        console.log(`트윗 실패 (${attempt}/${maxRetries}), 1분 후 재시도...`);
        await new Promise(r => setTimeout(r, 60000));
      } else {
        console.error(`트윗 최종 실패 (${attempt}/${maxRetries}):`, e.message);
        return;
      }
    }
  }
}

const DAY_LABEL = { weekday: '평일 마감', saturday: '주간 결산', sunday: '다음 주 프리뷰' };

async function postDailyTweet(dayType = 'weekday') {
  if (!twitterClient) return console.log('트위터 키 없음, 스킵');
  try {
    console.log(`트윗 포스팅 시작... (${DAY_LABEL[dayType]})`);

    // 캐시 없으면 브리핑 먼저 생성 (주말은 항상 새로 생성)
    if (!dailyCache.brief || dayType === 'saturday' || dayType === 'sunday') {
      console.log('브리핑 캐시 없음, 생성 중...');
      const today = new Date().toISOString().split('T')[0];
      const [quotes, fearGreed, news] = await Promise.all([
        fetchQuotes(), fetchFearGreed(), fetchNews(),
      ]);
      const prevBrief = dailyCache.date !== today ? dailyCache.brief : dailyCache.prevBrief;

      let prompt;
      if (dayType === 'saturday') {
        const [weekly, nextWeekCalendar, earnings] = await Promise.all([
          fetchWeeklyChanges(), fetchNextWeekCalendar(), fetchEarningsNextWeek(),
        ]);
        prompt = buildSaturdayPrompt(quotes, weekly, fearGreed, today, news, prevBrief, nextWeekCalendar, earnings);
      } else if (dayType === 'sunday') {
        const [weekly, nextWeekCalendar, earnings] = await Promise.all([
          fetchWeeklyChanges(), fetchNextWeekCalendar(), fetchEarningsNextWeek(),
        ]);
        prompt = buildSundayPrompt(quotes, weekly, fearGreed, today, news, nextWeekCalendar, prevBrief, earnings);
      } else {
        const [calendar, earnings] = await Promise.all([
          fetchEconomicCalendar(), fetchEarningsNextWeek(),
        ]);
        prompt = buildPrompt(quotes, fearGreed, today, news, calendar, prevBrief, earnings);
      }

      const msg = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
      });
      const rawGenerated = msg.content[0].text;
      const genLines = rawGenerated.split('\n');
      const titleKeywords = { weekday: '미장 마감 브리핑', saturday: '주간 결산', sunday: '다음 주 프리뷰' };
      const titleKw = titleKeywords[dayType];
      const genTitleIdx = genLines.findIndex(l => l.includes(titleKw));
      if (genTitleIdx !== -1) genLines[genTitleIdx] = `[카지노 마켓] ${today} ${titleKw}`;
      const generatedBrief = genLines.join('\n');
      dailyCache = { date: today, brief: generatedBrief, quotes, fearGreed, prevBrief };
      console.log('브리핑 생성 완료');
    }

    const { brief, quotes } = dailyCache;

    const lines = brief.split('\n').filter(l => l.trim());
    const title = lines[0] || '';
    const spy = quotes?.['SPY'];
    const vix = quotes?.['^VIX'];
    const qqq = quotes?.['QQQ'];


    // 이미지 1: 지표 차트, 이미지 2: 브리핑 텍스트
    const mediaIds = [];
    try {
      // 차트 이미지 제거 — 브리핑 텍스트에 지표 포함됨

      // 2. Finviz S&P500 히트맵
      try {
        console.log('Finviz 히트맵 가져오는 중...');
        const heatmapRes = await axios.get(
          'https://finviz.com/map.ashx?t=sec&p=d',
          { responseType: 'arraybuffer', headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', 'Referer': 'https://finviz.com/' }, timeout: 10000 }
        );
        const heatmapId = await twitterClient.v1.uploadMedia(Buffer.from(heatmapRes.data), { mimeType: 'image/png' });
        mediaIds.push(heatmapId);
        console.log('히트맵 완료');
      } catch (hmErr) {
        console.error('히트맵 실패:', hmErr.message);
      }

      // 3. 브리핑 텍스트 (한글) — [요약X] 줄 제거 후 이미지 생성 (트윗 텍스트와 중복 방지)
      console.log('텍스트 이미지 생성 중...');
      const briefForImage = brief.split('\n').filter(l => !l.trimStart().startsWith('[요약')).join('\n');
      const textBuf = generateTextImage(briefForImage);
      const textId = await twitterClient.v1.uploadMedia(textBuf, { mimeType: 'image/png' });
      mediaIds.push(textId);
      console.log('텍스트 이미지 완료');

      // 4. 영어 요약 이미지 (4장 이하일 때만)
      if (mediaIds.length < 4) {
        try {
          console.log('영어 이미지 생성 중...');
          const enBuf = await generateEnglishImage(briefForImage, dayType);
          const enId = await twitterClient.v1.uploadMedia(enBuf, { mimeType: 'image/png' });
          mediaIds.push(enId);
          console.log('영어 이미지 완료');
        } catch (enErr) {
          console.error('영어 이미지 실패:', enErr.message);
        }
      }
    } catch (imgErr) {
      console.error('이미지 생성 실패:', imgErr.message);
    }

    // 단일 트윗: 제목 + 지표 + 이미지들
    const today = dailyCache.date || new Date().toISOString().split('T')[0];
    const dateStr = today.slice(5).replace('-', '/');
    const s1Line = lines.find(l => l.startsWith('[요약1]'));
    const s2Line = lines.find(l => l.startsWith('[요약2]'));
    const s3Line = lines.find(l => l.startsWith('[요약3]'));
    const s1 = s1Line ? s1Line.replace('[요약1]', '').trim() : '';
    const s2 = s2Line ? s2Line.replace('[요약2]', '').trim() : '';
    const s3 = s3Line ? s3Line.replace('[요약3]', '').trim() : '';
    const summary = [s1, s2, s3].filter(Boolean).join('\n');
    const tweetLabel = { weekday: '미장 마감', saturday: '주간 결산', sunday: '다음 주 프리뷰' }[dayType] || '미장 마감';

    const CTA_POOL = {
      weekday: [
        '오늘 어떻게 대응했어? 👇',
        '버텼어, 팔았어? 👇',
        '오늘 장 어떻게 봤어? 👇',
        '멘탈 괜찮아? 👇',
        '오늘 수익/손실 어땠어? 👇',
        '같은 생각이야? 👇',
      ],
      saturday: [
        '이번 주 어땠어? 👇',
        '이번 주 수익/손실 어땠어? 👇',
        '이번 주 버텼어? 👇',
        '한 주 마무리 어떻게 됐어? 👇',
      ],
      sunday: [
        '다음 주 전략 어떻게 잡아? 👇',
        '다음 주 어떻게 준비해? 👇',
        '다음 주 포지션 유지야, 변경이야? 👇',
        '다음 주 기대돼, 겁나? 👇',
      ],
    };
    const ctaPool = CTA_POOL[dayType] || CTA_POOL.weekday;
    const CTA = { [dayType]: ctaPool[Math.floor(Math.random() * ctaPool.length)] };
    const tweetText = `${summary}\n\n${CTA[dayType] || CTA.weekday}\n\n— 카지노마켓 ${dateStr} ${tweetLabel}`;
    const tweetPayload = { text: tweetText };
    if (mediaIds.length > 0) tweetPayload.media = { media_ids: mediaIds };
    await twitterClient.v2.tweet(tweetPayload);
    console.log('트윗 포스팅 완료');
  } catch (e) {
    console.error('트윗 포스팅 실패:', e.message);
    if (e.data) console.error('Twitter 에러 상세:', JSON.stringify(e.data));
    if (e.code) console.error('HTTP 코드:', e.code);
  }
}

// 평일 21:30 UTC (한국 06:30, 미국 ET 16:30) 미장 마감 브리핑
// 토요일 13:00 UTC (한국 22:00) 주간 결산
// 일요일 13:00 UTC (한국 22:00) 다음 주 프리뷰
let lastTweetDate = null;
setInterval(() => {
  const now = new Date();
  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();
  const today = now.toISOString().split('T')[0];
  const dayType = getDayType();

  const weekdayTime = dayType === 'weekday' && utcH === 21 && utcM === 30;
  const weekendTime = (dayType === 'saturday' || dayType === 'sunday') && utcH === 13 && utcM === 0;

  if ((weekdayTime || weekendTime) && lastTweetDate !== today) {
    lastTweetDate = today;
    postDailyTweetWithRetry(dayType);
  }
}, 60000);

// 수동 트윗 엔드포인트 (cron-job.org: 즉시 응답 후 백그라운드 처리)
app.get('/api/tweet-now', (req, res) => {
  const dayType = getDayType();
  res.json({ ok: true, message: `트윗 포스팅 시작됨 (${DAY_LABEL[dayType]})` });
  postDailyTweetWithRetry(dayType).catch(e => console.error('백그라운드 트윗 실패:', e.message));
});

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, 'dist')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
  });
}

app.listen(PORT, () => console.log(`서버 시작 :${PORT}`));
