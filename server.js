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

const SYSTEM_PROMPT = `당신은 월스트리트 10년 경력의 퀀트 트레이더 겸 매크로 분석가입니다. 헤지펀드에서 일하다 독립해 개인 투자자들을 위한 날카로운 시장 분석을 제공하고 있습니다. 당신의 분석은 단순한 수치 해설이 아닌, 시장 참여자들의 심리, 자금 흐름, 그리고 숨겨진 패턴을 읽어내는 것으로 유명합니다. 항상 데이터에 기반하되, 그 이면의 "왜?"를 파고드는 스타일로 분석합니다. 한국 개인 투자자들이 쉽게 이해할 수 있도록 구어체로 풀어쓰되, 전문성을 잃지 않습니다.`;

async function fetchOneQuote(symbol) {
  const encoded = encodeURIComponent(symbol);
  const { data } = await axios.get(
    `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1d&range=2d`,
    { headers: { 'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36' } }
  );
  const meta = data.chart.result[0].meta;
  const price = meta.regularMarketPrice;
  const prev = meta.chartPreviousClose || meta.previousClose;
  const changePct = prev ? ((price - prev) / prev) * 100 : 0;
  const volume = meta.regularMarketVolume || null;
  const avgVolume = meta.averageDailyVolume3Month || null;
  const volRatio = (volume && avgVolume) ? volume / avgVolume : null;
  return { price, changePct, change: price - (prev || price), volume, avgVolume, volRatio };
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

async function fetchFearGreed() {
  try {
    const { data } = await axios.get('https://api.alternative.me/fng/?limit=1');
    return data.data[0];
  } catch {
    return { value: 'N/A', value_classification: 'Unknown' };
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

function buildPrompt(quotes, fg, today, news, calendar, prevBrief) {
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

  const prevSection = prevBrief
    ? `\n[전날 브리핑 (연속성 참고용 - 직접 인용하지 말 것)]\n${prevBrief.slice(0, 600)}`
    : '';

  return `오늘 날짜: ${today}

[오늘의 미장 데이터]
주요 지수: SPY ${f('SPY')}${volNote('SPY')} / QQQ ${f('QQQ')}${volNote('QQQ')} / IWM ${f('IWM')} / DIA ${f('DIA')}
변동성: VIX ${f('^VIX')} | 공포탐욕지수 ${fg.value} (${fg.value_classification})
채권: HYG ${f('HYG')} / JNK ${f('JNK')} / TLT ${f('TLT')}
수익률 커브: 3개월 ${fYield('^IRX')} / 5년 ${fYield('^FVX')} / 10년 ${fYield('^TNX')} | 3M-10Y 스프레드: ${ycSpread}%${ycLabel}
매크로: 달러(DXY) ${f('DX-Y.NYB')} / 금 ${f('GC=F')} / 오일(WTI) ${f('CL=F')}
크립토: BTC ${f('BTC-USD')} / ETH ${f('ETH-USD')}
주요종목: TSLA ${f('TSLA')}${volNote('TSLA')} / NVDA ${f('NVDA')}${volNote('NVDA')} / AAPL ${f('AAPL')} / MSFT ${f('MSFT')} / META ${f('META')}
섹터별 등락:
${sectorLines}
${newsSection}
${calendarSection}
${prevSection}

위 데이터를 바탕으로 오늘의 미장 마감 브리핑을 작성해주세요.

[스타일 가이드]
- 반드시 아래 두 줄로 시작할 것:
  첫째 줄: "[카지노 마켓] ${today} 미장 마감 브리핑"
  둘째 줄: "[요약] " + 오늘 장의 핵심을 구어체로 40자 이내 한 문장 (예: "FOMC 충격 후폭풍, VIX +12% 공포 확산")
  셋째 줄부터 본문 시작
- 구어체 한국어 + 영어 금융 용어 자연스럽게 혼용 (레버설, 컨펌, 다이버전스, 숏스퀴즈, 캐피툴레이션, 풀백, 리테스트 등)
- 단순 수치 나열 금지, 각 지표의 의미와 맥락 설명
- 여러 지표 상관관계 분석 (VIX vs HYG, 달러 vs 금, 크립토 vs 나스닥 등)
- 수익률 커브 상태와 경기 사이클 시사점 반드시 언급
- 거래량 이상 시 특별히 언급
- 오늘 주요 뉴스와 가격 움직임의 인과관계 분석
- 이번 주 남은 주요 이벤트가 시장에 미칠 영향 전망
- 오늘 장에서 특이한 점, 눈에 띄는 섹터 로테이션 언급
- BTC, ETH 각각 개별 코멘트 필수 (나스닥과의 상관관계, 디커플링 여부, 크립토 고유 내러티브)
- 테슬라, 엔비디아 각각 개별 코멘트 필수 (현재 레벨, 지지/저항, 단기 모멘텀)
- 강세 시나리오 / 약세 시나리오 2가지 간략히 제시
- 마지막: 투자 마인드셋 한 마디
- 길이: 1200~1600자
- 문체: "~것 같음", "~보임", "~예상", "명심!" 자연스럽게 사용
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
    const [quotes, fearGreed, news, calendar] = await Promise.all([
      fetchQuotes(),
      fetchFearGreed(),
      fetchNews(),
      fetchEconomicCalendar(),
    ]);

    const prevBrief = dailyCache.date !== today ? dailyCache.brief : dailyCache.prevBrief;
    const prompt = buildPrompt(quotes, fearGreed, today, news, calendar, prevBrief);

    const msg = await anthropic.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: 2048,
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

async function postDailyTweet() {
  if (!twitterClient) return console.log('트위터 키 없음, 스킵');
  try {
    console.log('트윗 포스팅 시작...');

    // 캐시 없으면 브리핑 먼저 생성
    if (!dailyCache.brief) {
      console.log('브리핑 캐시 없음, 생성 중...');
      const today = new Date().toISOString().split('T')[0];
      const [quotes, fearGreed, news, calendar] = await Promise.all([
        fetchQuotes(), fetchFearGreed(), fetchNews(), fetchEconomicCalendar(),
      ]);
      const prevBrief = dailyCache.date !== today ? dailyCache.brief : dailyCache.prevBrief;
      const prompt = buildPrompt(quotes, fearGreed, today, news, calendar, prevBrief);
      const msg = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 2048,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: prompt }],
      });
      const rawGenerated = msg.content[0].text;
      const genLines = rawGenerated.split('\n');
      const genTitleIdx = genLines.findIndex(l => l.includes('미장 마감 브리핑'));
      if (genTitleIdx !== -1) genLines[genTitleIdx] = `[카지노 마켓] ${today} 미장 마감 브리핑`;
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
    const spyStr = spy ? `SPY ${spy.changePct >= 0 ? '+' : ''}${spy.changePct.toFixed(2)}%` : '';
    const qqqStr = qqq ? `QQQ ${qqq.changePct >= 0 ? '+' : ''}${qqq.changePct.toFixed(2)}%` : '';
    const vixStr = vix ? `VIX ${vix.price.toFixed(1)}` : '';

    // 이미지 1: 지표 차트, 이미지 2: 브리핑 텍스트
    const mediaIds = [];
    try {
      // 1. 지표 차트
      console.log('차트 이미지 생성 중...');
      const chartBuf = generateMarketImage(quotes, dailyCache.fearGreed);
      const chartId = await twitterClient.v1.uploadMedia(chartBuf, { mimeType: 'image/png' });
      mediaIds.push(chartId);
      console.log('차트 이미지 완료');

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

      // 3. 브리핑 텍스트
      console.log('텍스트 이미지 생성 중...');
      const textBuf = generateTextImage(brief);
      const textId = await twitterClient.v1.uploadMedia(textBuf, { mimeType: 'image/png' });
      mediaIds.push(textId);
      console.log('텍스트 이미지 완료');
    } catch (imgErr) {
      console.error('이미지 생성 실패:', imgErr.message);
    }

    // 단일 트윗: 제목 + 지표 + 두 이미지
    const today = dailyCache.date || new Date().toISOString().split('T')[0];
    const dateStr = today.slice(5).replace('-', '/');
    const summaryLine = lines.find(l => l.startsWith('[요약]'));
    const summary = summaryLine ? summaryLine.replace('[요약]', '').trim() : '';
    const tweetText = `카지노마켓 ${dateStr} 미장 마감\n\n"${summary}"\n\n${spyStr} | ${qqqStr} | ${vixStr}\n\n#미국주식 #미장 #카지노마켓 #나스닥`;
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

// 매일 21:30 UTC (한국 06:30, 미국 ET 16:30) 자동 포스팅
let lastTweetDate = null;
setInterval(() => {
  const now = new Date();
  const utcH = now.getUTCHours();
  const utcM = now.getUTCMinutes();
  const today = now.toISOString().split('T')[0];
  const utcDay = now.getUTCDay(); // 0=일, 6=토
  if (utcH === 21 && utcM === 30 && lastTweetDate !== today && utcDay !== 0 && utcDay !== 6) {
    lastTweetDate = today;
    postDailyTweet();
  }
}, 60000);

// 수동 트윗 엔드포인트 (cron-job.org: 즉시 응답 후 백그라운드 처리)
app.get('/api/tweet-now', (req, res) => {
  res.json({ ok: true, message: '트윗 포스팅 시작됨 (백그라운드)' });
  postDailyTweet().catch(e => console.error('백그라운드 트윗 실패:', e.message));
});

if (process.env.NODE_ENV === 'production') {
  app.use(express.static(path.join(__dirname, 'dist')));
  app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, 'dist', 'index.html'));
  });
}

app.listen(PORT, () => console.log(`서버 시작 :${PORT}`));
