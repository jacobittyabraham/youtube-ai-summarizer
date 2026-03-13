const path = require("path");
const fs = require("fs");

// Always load GEMINI_API_KEY from .env file (same folder as this script)
function loadEnvKey() {
  const envPath = path.join(__dirname, ".env");
  try {
    const envContent = fs.readFileSync(envPath, "utf8");
    const match = envContent.match(/GEMINI_API_KEY\s*=\s*([^\s#]+)/);
    if (match) {
      const val = match[1].trim().replace(/^["']|["']$/g, "");
      if (val.length > 10) {
        process.env.GEMINI_API_KEY = val;
      }
    }
  } catch (e) {
    console.error("Could not load .env from", envPath, e.message);
  }
}
loadEnvKey();

// Load rest of .env (override: true so .env wins over existing empty vars)
const envPath = path.join(__dirname, ".env");
require("dotenv").config({ path: envPath, override: true });
require("dotenv").config({ path: path.join(process.cwd(), ".env"), override: true });

const express = require("express");
const cors = require("cors");
const { Innertube } = require("youtubei.js");
const crypto = require("crypto");

const app = express();
const PORT = process.env.PORT || 3000;

// Free-tier-friendly model: 15 RPM, 1000 RPD (higher daily limit)
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-2.0-flash";

// Simple in-memory cache to reduce Gemini calls (helps free-tier limits)
// Key: videoId (preferred) or transcript hash
const SUMMARY_CACHE_TTL_MS = Number(process.env.SUMMARY_CACHE_TTL_MS || 6 * 60 * 60 * 1000); // 6 hours
const summaryCache = new Map(); // key -> { summary, expiresAt }
const inFlight = new Map(); // key -> Promise<{success, summary} | {success:false, status, error}>

// Simple rate limit guard (prevents this backend from exceeding free-tier RPM).
// NOTE: This does NOT increase your Gemini quota; it just avoids self-inflicted bursts.
const MIN_GEMINI_INTERVAL_MS = Number(process.env.MIN_GEMINI_INTERVAL_MS || 5000); // 5s => 12 RPM
let lastGeminiRequestAt = 0;

function cacheGet(key) {
  const item = summaryCache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiresAt) {
    summaryCache.delete(key);
    return null;
  }
  return item.summary;
}

function cacheSet(key, summary) {
  summaryCache.set(key, { summary, expiresAt: Date.now() + SUMMARY_CACHE_TTL_MS });
}

function stableKey({ videoId, transcript }) {
  if (videoId && typeof videoId === "string" && videoId.trim()) return `video:${videoId.trim()}`;
  const hash = crypto.createHash("sha256").update(transcript, "utf8").digest("hex");
  return `tx:${hash}`;
}

app.use(cors());
// Transcripts can be large; default 100kb is too small
app.use(express.json({ limit: "2mb" }));

app.get("/", (req, res) => {
  res.send("YouTube AI Summarizer backend running");
});

// Debug endpoint to verify which process is serving requests
app.get("/debug", (req, res) => {
  res.json({
    pid: process.pid,
    cwd: process.cwd(),
    envPath: path.join(__dirname, ".env"),
    hasGeminiKey: !!process.env.GEMINI_API_KEY,
    geminiKeyLength: process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.length : 0,
    geminiModel: GEMINI_MODEL,
  });
});

// Fetch transcript by video ID (alternative to extension scraping)
app.post("/summarize", async (req, res) => {
  const { videoId } = req.body;

  if (!videoId) {
    return res.status(400).json({ error: "videoId required" });
  }

  console.log("Video ID:", videoId);

  try {
    const youtube = await Innertube.create();
    const info = await youtube.getInfo(videoId);

    if (!info?.captions) {
      return res.json({
        transcript: "No captions found for this video.",
      });
    }

    const transcriptInfo = await info.getTranscript();
    const segments = transcriptInfo?.transcript?.content?.body?.initial_segments || [];
    const text = segments
      .filter((s) => s.snippet)
      .map((s) => s.snippet.toString())
      .join(" ");

    if (!text.trim()) {
      return res.json({ transcript: "No transcript text available." });
    }

    console.log("Transcript characters:", text.length);

    res.json({
      transcript: text.slice(0, 12000),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      error: "Transcript fetch failed",
      details: err.message,
    });
  }
});

// Summarize transcript using Gemini (API key stays on server)
app.post("/summarize-transcript", async (req, res) => {
  const { transcript, videoId } = req.body;

  if (!transcript || typeof transcript !== "string") {
    return res.status(400).json({
      success: false,
      error: "Transcript text is required.",
    });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    console.error("GEMINI_API_KEY is not set");
    return res.status(500).json({
      success: false,
      error: "Server is not configured with Gemini API key. Set GEMINI_API_KEY in environment.",
    });
  }

  const trimmedTranscript = transcript.slice(0, 120000);
  const key = stableKey({ videoId, transcript: trimmedTranscript });

  // Cache hit
  const cached = cacheGet(key);
  if (cached) {
    res.setHeader("X-Cache", "HIT");
    return res.json({ success: true, summary: cached, cached: true });
  }

  // Backend-side throttle to avoid burst requests (helps with free-tier RPM)
  const now = Date.now();
  const sinceLast = now - lastGeminiRequestAt;
  if (sinceLast < MIN_GEMINI_INTERVAL_MS) {
    const waitMs = MIN_GEMINI_INTERVAL_MS - sinceLast;
    const waitSec = Math.ceil(waitMs / 1000);
    res.setHeader("Retry-After", String(waitSec));
    return res.status(429).json({
      success: false,
      error: `Backend throttle: please wait ${waitSec}s and try again (to avoid Gemini free-tier RPM).`,
      retryAfter: true,
    });
  }

  // De-dupe concurrent requests for same key
  const existing = inFlight.get(key);
  if (existing) {
    res.setHeader("X-Cache", "WAIT");
    const result = await existing;
    if (result.success) return res.json({ success: true, summary: result.summary, cached: true });
    return res.status(result.status || 500).json({ success: false, error: result.error || "Failed to summarize." });
  }

  const prompt = `Summarize this YouTube transcript.

Return:
Summary:
• bullet points

Key Takeaways:
• bullet points

Important Moments:
• timestamps if possible

Transcript:
${trimmedTranscript}`;

  try {
    const promise = (async () => {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
      lastGeminiRequestAt = Date.now();
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            maxOutputTokens: 2048,
            temperature: 0.3,
          },
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        const msg = data?.error?.message || response.statusText;
        const code = data?.error?.code;

        if (response.status === 429) {
          return {
            success: false,
            status: 429,
            error: "Rate limit reached. Gemini free tier allows ~15 requests/minute. Please wait a minute and try again.",
          };
        }
        if (response.status === 503) {
          return {
            success: false,
            status: 503,
            error: "Gemini service is temporarily unavailable. Please try again in a moment.",
          };
        }
        if (response.status === 403 && (code === 403 || /quota|billing|disabled/i.test(String(msg)))) {
          return {
            success: false,
            status: 403,
            error: "API quota exceeded or key invalid. Check your Gemini API key and quota in Google AI Studio.",
          };
        }

        return { success: false, status: response.status, error: msg || "Gemini API request failed." };
      }

      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) {
        return { success: false, status: 502, error: "No summary was generated. The model may have blocked the response." };
      }

      return { success: true, summary: text };
    })();

    inFlight.set(key, promise);
    const result = await promise;
    inFlight.delete(key);

    if (!result.success) {
      return res.status(result.status || 500).json({ success: false, error: result.error || "Failed to summarize." });
    }

    cacheSet(key, result.summary);
    res.setHeader("X-Cache", "MISS");
    res.json({ success: true, summary: result.summary, cached: false });
  } catch (err) {
    inFlight.delete(key);
    console.error("Summarize error:", err);
    res.status(500).json({
      success: false,
      error: err.message || "Failed to call Gemini API.",
    });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT} (pid ${process.pid})`);
  const key = process.env.GEMINI_API_KEY;
  console.log(".env path:", path.join(__dirname, ".env"));
  console.log(
    "Gemini API key:",
    key ? `loaded (${key.length} chars)` : "NOT SET - check backend/.env has GEMINI_API_KEY=your_key"
  );
});
