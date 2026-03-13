// Backend URL: use your deployed server or leave as localhost for development
const API_BASE = "https://youtube-ai-summarizer-jsfz.onrender.com";

const summarizeBtn = document.getElementById("summarizeBtn");
const resultDiv = document.getElementById("result");

const COOLDOWN_SECONDS = 20;
let cooldownTimer = null;

function getVideoIdFromUrl(url) {
  try {
    const u = new URL(url);
    return u.searchParams.get("v");
  } catch {
    return null;
  }
}

function startCooldown() {
  let remaining = COOLDOWN_SECONDS;
  summarizeBtn.disabled = true;
  summarizeBtn.textContent = `Wait ${remaining}s...`;

  if (cooldownTimer) clearInterval(cooldownTimer);
  cooldownTimer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(cooldownTimer);
      cooldownTimer = null;
      summarizeBtn.disabled = false;
      summarizeBtn.textContent = "Summarize Video";
      return;
    }
    summarizeBtn.textContent = `Wait ${remaining}s...`;
  }, 1000);
}

summarizeBtn.addEventListener("click", async () => {
  resultDiv.innerText = "Extracting transcript...";
  summarizeBtn.disabled = true;

  const [tab] = await chrome.tabs.query({
    active: true,
    currentWindow: true,
  });

  try {
    chrome.tabs.sendMessage(
      tab.id,
      { action: "getTranscript" },
      async (response) => {
        if (chrome.runtime.lastError) {
          resultDiv.innerText = "Please refresh the YouTube page and try again.";
          summarizeBtn.disabled = false;
          return;
        }

        if (!response || response.success === false) {
          resultDiv.innerText = response?.error || "Transcript could not be extracted.";
          summarizeBtn.disabled = false;
          return;
        }

        const transcript = response.transcript;
        if (!transcript || transcript.length < 20) {
          resultDiv.innerText = "Transcript is too short or unavailable.";
          summarizeBtn.disabled = false;
          return;
        }

        resultDiv.innerText = "⏳ Generating AI summary...";

        // Trim to ~100k chars to avoid payload size limits
        const trimmed = transcript.slice(0, 100000);
        const videoId = getVideoIdFromUrl(tab.url);
        startCooldown();
        const summary = await summarizeTranscript(trimmed, videoId);
        resultDiv.innerText = summary;
      }
    );
  } catch (error) {
    resultDiv.innerText = "Extension error: " + error.message;
    summarizeBtn.disabled = false;
  }
});

async function summarizeTranscript(transcript, videoId) {
  try {
    const res = await fetch(`${API_BASE}/summarize-transcript`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ transcript, videoId }),
    });

    const text = await res.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      return (
        "Backend returned an error page instead of JSON. " +
        "Make sure the server is running: cd backend && node server.js"
      );
    }

    if (data.success && data.summary) {
      return data.cached ? `${data.summary}\n\n(used cached summary)` : data.summary;
    }

    const msg = data.error || "Unknown error";
    if (res.status === 429) {
      return "⚠️ " + msg + "\n\n(Gemini free tier: ~15 requests/minute.)";
    }
    if (res.status === 503) {
      return "⚠️ " + msg;
    }
    if (res.status === 403) {
      return "⚠️ " + msg + "\n\nCheck backend GEMINI_API_KEY and quota.";
    }
    return "Error: " + msg;
  } catch (err) {
    const isCorsOrNetwork =
      err.message.includes("Failed to fetch") ||
      err.message.includes("NetworkError") ||
      err.message.includes("CORS");
    if (isCorsOrNetwork) {
      return (
        "Cannot reach the backend. Make sure the server is running at " +
        API_BASE +
        " and CORS is enabled. For production, set API_BASE to your deployed URL."
      );
    }
    return "Network error: " + err.message;
  }
}
