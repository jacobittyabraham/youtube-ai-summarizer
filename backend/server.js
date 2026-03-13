const path = require("path");
require("dotenv").config({ path: path.join(__dirname, ".env"), override: true });

const express = require("express");
const cors = require("cors");
const { Innertube } = require("youtubei.js");
const crypto = require("crypto");
const OpenAI = require("openai");

const app = express();
const PORT = process.env.PORT || 3000;

const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

// Cache: 6 hours per video/transcript
const SUMMARY_CACHE_TTL_MS = Number(process.env.SUMMARY_CACHE_TTL_MS || 6 * 60 * 60 * 1000);
const summaryCache = new Map();
const inFlight = new Map();

// Groq free tier: 30 RPM — throttle to 1 request per 2s to stay safe
const MIN_INTERVAL_MS = Number(process.env.MIN_INTERVAL_MS || 2000);
let lastRequestAt = 0;

function cacheGet(key) {
  const item = summaryCache.get(key);
  if (!item) return null;
  if (Date.now() > item.expiresAt) { summaryCache.delete(key); return null; }
  return item.summary;
}

function cacheSet(key, summary) {
  summaryCache.set(key, { summary, expiresAt: Date.now() + SUMMARY_CACHE_TTL_MS });
}

function stableKey({ videoId, transcript }) {
  if (videoId && typeof videoId === "string" && videoId.trim()) return `video:${videoId.trim()}`;
  return `tx:${crypto.createHash("sha256").update(transcript, "utf8").digest("hex")}`;
}

app.use(cors());
app.use(express.json({ limit: "2mb" }));

app.get("/", (req, res) => {
  res.send("YouTube AI Summarizer backend running");
});

app.get("/debug", (req, res) => {
  res.json({
    pid: process.pid,
    hasGroqKey: !!process.env.GROQ_API_KEY,
    groqKeyLength: process.env.GROQ_API_KEY ? process.env.GROQ_API_KEY.length : 0,
    groqModel: GROQ_MODEL,
  });
});

// Fetch transcript by video ID
app.post("/summarize", async (req, res) => {
  const { videoId } = req.body;
  if (!videoId) return res.status(400).json({ error: "videoId required" });

  try {
    const youtube = await Innertube.create();
    const info = await youtube.getInfo(videoId);

    if (!info?.captions) return res.json({ transcript: "No captions found for this video." });

    const transcriptInfo = await info.getTranscript();
    const segments = transcriptInfo?.transcript?.content?.body?.initial_segments || [];
    const text = segments.filter(s => s.snippet).map(s => s.snippet.toString()).join(" ");

    if (!text.trim()) return res.json({ transcript: "No transcript text available." });

    res.json({ transcript: text.slice(0, 12000) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Transcript fetch failed", details: err.message });
  }
});

// Summarize transcript using Groq (free tier, 30 RPM)
app.post("/summarize-transcript", async (req, res) => {
  const { transcript, videoId } = req.body;

  if (!transcript || typeof transcript !== "string") {
    return res.status(400).json({ success: false, error: "Transcript text is required." });
  }

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      success: false,
      error: "Server is not configured. Set GROQ_API_KEY in environment.",
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

  // Throttle
  const sinceLast = Date.now() - lastRequestAt;
  if (sinceLast < MIN_INTERVAL_MS) {
    const waitSec = Math.ceil((MIN_INTERVAL_MS - sinceLast) / 1000);
    res.setHeader("Retry-After", String(waitSec));
    return res.status(429).json({
      success: false,
      error: `Please wait ${waitSec}s and try again.`,
      retryAfter: true,
    });
  }

  // De-dupe concurrent requests
  const existing = inFlight.get(key);
  if (existing) {
    res.setHeader("X-Cache", "WAIT");
    const result = await existing;
    if (result.success) return res.json({ success: true, summary: result.summary, cached: true });
    return res.status(result.status || 500).json({ success: false, error: result.error });
  }

  const prompt = `Summarize this YouTube transcript. The transcript includes real timestamps in [MM:SS] format.

Return:
Summary:
• bullet points

Key Takeaways:
• bullet points

Important Moments:
• use the real [MM:SS] timestamps from the transcript

Transcript:
${trimmedTranscript}`;

  try {
    const promise = (async () => {
      lastRequestAt = Date.now();
      const groq = new OpenAI({ apiKey, baseURL: "https://api.groq.com/openai/v1" });

      const completion = await groq.chat.completions.create({
        model: GROQ_MODEL,
        messages: [{ role: "user", content: prompt }],
        max_tokens: 2048,
        temperature: 0.3,
      });

      const text = completion.choices[0]?.message?.content;
      if (!text) return { success: false, status: 502, error: "No summary was generated." };

      return { success: true, summary: text };
    })();

    inFlight.set(key, promise);
    const result = await promise;
    inFlight.delete(key);

    if (!result.success) {
      return res.status(result.status || 500).json({ success: false, error: result.error });
    }

    cacheSet(key, result.summary);
    res.setHeader("X-Cache", "MISS");
    res.json({ success: true, summary: result.summary, cached: false });
  } catch (err) {
    inFlight.delete(key);
    console.error("Summarize error:", err);

    if (err.status === 429) {
      return res.status(429).json({ success: false, error: "Rate limit reached. Please wait a moment and try again." });
    }
    res.status(500).json({ success: false, error: err.message || "Failed to call Groq API." });
  }
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log("Groq API key:", process.env.GROQ_API_KEY ? "loaded" : "NOT SET");
});
