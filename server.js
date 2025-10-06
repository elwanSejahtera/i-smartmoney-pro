// server.js
import express from "express";
import axios from "axios";
import cors from "cors";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;
const TWELVE_API_KEY = process.env.TWELVE_API_KEY;
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || "";
const NEWSAPI_KEY = process.env.NEWSAPI_KEY || ""; // optional, for news

// Setup OpenAI client (if key available)
let openaiClient = null;
if (OPENAI_API_KEY) {
  openaiClient = new OpenAI({ apiKey: OPENAI_API_KEY });
}

// ---------- Utilities: EMA, SMA, simple SMC detectors ----------
function ema(values, period) {
  if (!values || values.length < period) return null;
  const k = 2 / (period + 1);
  let emaArr = [];
  // start with SMA for first value
  const sma = values.slice(0, period).reduce((a,b)=>a+b,0)/period;
  emaArr[period-1] = sma;
  for (let i = period; i < values.length; i++) {
    emaArr[i] = (values[i] - emaArr[i-1]) * k + emaArr[i-1];
  }
  // return last ema
  return emaArr[values.length-1] ?? sma;
}

function simpleMomentum(closes) {
  if (!closes || closes.length < 2) return 0;
  const last = closes[0];
  const prev = closes[1];
  return last - prev;
}

// Detect basic order-block-like zones (very simple heuristic)
function detectOrderBlocks(candles) {
  // find recent bullish and bearish engulfing like swing zones
  const zones = [];
  for (let i = 2; i < Math.min(candles.length, 30); i++) {
    const c = candles[i-2], p = candles[i-1], n = candles[i];
    // bullish swing (low reversal)
    if (n.close > n.open && n.low < p.low && p.low <= c.low) {
      zones.push({type:'demand', low: n.low, high: n.close, idx: i});
    }
    // bearish swing (high reversal)
    if (n.open > n.close && n.high > p.high && p.high >= c.high) {
      zones.push({type:'supply', low: n.close, high: n.high, idx: i});
    }
  }
  return zones.slice(0,5);
}

// Fair Value Gap simple detect (gap between candles)
function detectFVG(candles) {
  const fvg = [];
  for (let i = 0; i < candles.length-2; i++) {
    const a = candles[i+2], b = candles[i+1], c = candles[i];
    // bearish gap
    if (a.high < c.low) {
      fvg.push({type:'bearish', top:c.low, bottom:a.high, i});
    }
    // bullish gap
    if (a.low > c.high) {
      fvg.push({type:'bullish', top:a.low, bottom:c.high, i});
    }
  }
  return fvg.slice(0,5);
}

// ---------- TwelveData fetch ----------
app.get("/api/ohlc", async (req, res) => {
  try {
    const symbol = req.query.symbol || "XAU/USD";
    const interval = req.query.interval || "1h";
    const outputsize = req.query.outputsize || 50;
    const url = `https://api.twelvedata.com/time_series`;
    const r = await axios.get(url, {
      params: { symbol, interval, apikey: TWELVE_API_KEY, outputsize }
    });
    return res.json(r.data);
  } catch (err) {
    console.error("TwelveData error:", err?.response?.data || err.message);
    return res.status(500).json({ error: "Failed to fetch market data" });
  }
});

// ---------- News fetch (NewsAPI) ----------
app.get("/api/news", async (req, res) => {
  try {
    if (!NEWSAPI_KEY) return res.status(400).json({ error: "NEWSAPI_KEY not set" });
    const q = req.query.q || "gold OR XAU OR gold price";
    const url = `https://newsapi.org/v2/everything`;
    const r = await axios.get(url, {
      params: { q, language: "en", sortBy: "publishedAt", pageSize: 10, apiKey: NEWSAPI_KEY }
    });
    return res.json(r.data);
  } catch (err) {
    console.error("NewsAPI error:", err?.response?.data || err.message);
    return res.status(500).json({ error: "Failed to fetch news" });
  }
});

// ---------- Local analyzer fallback ----------
function localAnalyze(candles, pair="XAU/USD") {
  // candles expected array with newest first: values[0] newest
  const closes = candles.map(c=>parseFloat(c.close));
  const highs = candles.map(c=>parseFloat(c.high));
  const lows = candles.map(c=>parseFloat(c.low));

  const ema9 = ema(closes, 9);
  const ema20 = ema(closes, 20);
  const momentum = simpleMomentum(closes);

  const orderBlocks = detectOrderBlocks(candles);
  const fvg = detectFVG(candles);

  // bias logic simple
  let bias = "Neutral";
  if (ema9 && ema20) {
    bias = ema9 > ema20 ? "Bullish" : "Bearish";
  } else {
    bias = momentum > 0 ? "Bullish" : (momentum < 0 ? "Bearish" : "Neutral");
  }

  // pick simple levels
  const lastPrice = closes[0];
  const recommended = {
    entry: lastPrice,
    tp1: (lastPrice * (bias==="Bullish" ? 1.003 : 0.997)).toFixed(4),
    tp2: (lastPrice * (bias==="Bullish" ? 1.007 : 0.993)).toFixed(4),
    sl: (lastPrice * (bias==="Bullish" ? 0.995 : 1.005)).toFixed(4)
  };

  return {
    pair,
    bias,
    ema9,
    ema20,
    momentum: Number(momentum.toFixed(4)),
    orderBlocks,
    fvg,
    recommended,
    reasoning: `Local-rule: EMA9 ${ema9? `=${ema9.toFixed(2)}` : "n/a"} vs EMA20 ${ema20?`=${ema20.toFixed(2)}`:"n/a"}; momentum=${momentum.toFixed(2)}`
  };
}

// ---------- analyze endpoint: tries OpenAI, fallback local ----------
app.post("/analyze", async (req, res) => {
  try {
    const body = req.body || {};
    const pair = body.pair || "XAU/USD";
    let candles = body.ohlc;
    // If no OHLC provided, try to fetch from TwelveData (1h by default)
    if (!candles) {
      const td = await axios.get("https://api.twelvedata.com/time_series", {
        params: { symbol: pair, interval: body.interval || "1h", apikey: TWELVE_API_KEY, outputsize: 50 }
      });
      candles = td.data.values;
    }
    if (!candles || !candles.length) return res.status(400).json({ error: "No candle data available" });

    // Try OpenAI reasoning if client available
    if (openaiClient) {
      try {
        // Compose short prompt with essential data (keep tokens small)
        const closes = candles.slice(0, 30).map(c=>c.close).join(", ");
        const prompt = `You are a concise Smart Money Concepts market analyst for ${pair}.
Candles (most recent first): ${closes}
Provide short JSON with:
- bias ("Bullish"/"Bearish"/"Neutral")
- short reasoning (1-2 sentences)
- order_blocks (if any, short)
- recommended (entry,tp1,tp2,sl numeric)
Return ONLY valid JSON.`;

        // Use responses.create (new OpenAI SDK) or fallback chat
        const resp = await openaiClient.responses.create({
          model: "gpt-5-mini",
          input: prompt,
          max_output_tokens: 400
        });

        // Parse assistant output (some models return text in resp.output_text)
        const aiText = resp.output_text || (resp.output && resp.output[0] && resp.output[0].content && resp.output[0].content[0].text) || JSON.stringify(resp);
        // Try to parse JSON in aiText
        const jsonStart = aiText.indexOf("{");
        const jsonStr = jsonStart >= 0 ? aiText.slice(jsonStart) : aiText;
        let parsed = null;
        try { parsed = JSON.parse(jsonStr); } catch(e) { /* ignore parse error */ }

        if (parsed) {
          return res.json({ status:"success", source:"openai", analysis: parsed });
        } else {
          // If not JSON, return text plus local analysis
          const local = localAnalyze(candles, pair);
          return res.json({ status:"success", source:"openai_text", ai_text: aiText, local });
        }
      } catch (aiErr) {
        // If AI gives quota error or network issue, fallback to local
        console.error("OpenAI error:", aiErr?.response?.data || aiErr.message);
        const local = localAnalyze(candles, pair);
        return res.json({ status:"success", source:"local_fallback", analysis: local, note: "OpenAI failed or quota exceeded" });
      }
    } else {
      // No OpenAI key configured -> local analysis
      const local = localAnalyze(candles, pair);
      return res.json({ status:"success", source:"local", analysis: local });
    }
  } catch (err) {
    console.error("Analyze error:", err?.response?.data || err.message);
    return res.status(500).json({ error: "Server analyze error" });
  }
});

// Basic health
app.get("/", (req, res) => {
  res.send("AI SmartMoney Analyzer Pro — server live");
});

app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
