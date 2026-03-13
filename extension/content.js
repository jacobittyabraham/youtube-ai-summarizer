// Primary method: fetch full transcript from YouTube's caption API
// Works for any video length — bypasses virtual scrolling in the DOM
async function fetchTranscriptFromAPI() {
  try {
    const playerResponse = window.ytInitialPlayerResponse;
    if (!playerResponse) return null;

    const captionTracks =
      playerResponse?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    if (!captionTracks || captionTracks.length === 0) return null;

    // Prefer manual English track, then auto-generated English, then first available
    const track =
      captionTracks.find(t => t.languageCode === "en" && !t.kind) ||
      captionTracks.find(t => t.languageCode === "en") ||
      captionTracks[0];

    const response = await fetch(track.baseUrl + "&fmt=json3");
    if (!response.ok) return null;

    const data = await response.json();
    if (!data.events) return null;

    const lines = data.events
      .filter(e => e.segs && e.tStartMs !== undefined)
      .map(e => {
        const totalSecs = Math.floor(e.tStartMs / 1000);
        const mins = Math.floor(totalSecs / 60);
        const secs = String(totalSecs % 60).padStart(2, "0");
        const text = e.segs
          .map(s => s.utf8 || "")
          .join("")
          .replace(/\n/g, " ")
          .trim();
        return text ? `[${mins}:${secs}] ${text}` : null;
      })
      .filter(Boolean);

    return lines.length > 0 ? lines.join(" ") : null;
  } catch {
    return null;
  }
}


// Fallback method: scrape transcript from the DOM panel
async function fetchTranscriptFromDOM() {
  await openTranscriptPanel();
  const loaded = await waitForTranscript();
  if (!loaded) return null;
  return extractTranscript();
}

async function openTranscriptPanel() {
  if (document.querySelectorAll("ytd-transcript-segment-renderer").length > 0) return;

  // Expand description first — transcript button is hidden when collapsed
  const allButtons = [...document.querySelectorAll("button, tp-yt-paper-button")];
  const moreBtn = allButtons.find(b => {
    const text = (b.innerText || b.textContent || "").toLowerCase().trim();
    return text === "more" || text === "...more" || text === "show more";
  });
  if (moreBtn) {
    moreBtn.click();
    await new Promise(r => setTimeout(r, 600));
  }

  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const btn = [...document.querySelectorAll("button, tp-yt-paper-button")].find(b =>
      (b.innerText || b.textContent || "").toLowerCase().includes("transcript")
    );
    if (btn) { btn.click(); return; }
    await new Promise(r => setTimeout(r, 400));
  }
}

async function waitForTranscript(timeout = 15000) {
  return new Promise(resolve => {
    const start = Date.now();
    const interval = setInterval(() => {
      if (document.querySelectorAll("ytd-transcript-segment-renderer").length > 0) {
        clearInterval(interval);
        resolve(true);
      }
      if (Date.now() - start > timeout) {
        clearInterval(interval);
        resolve(false);
      }
    }, 300);
  });
}

function extractTranscript() {
  const segments = document.querySelectorAll("ytd-transcript-segment-renderer");
  if (!segments.length) return null;
  return [...segments]
    .map(seg => seg.innerText.replace(/\d+:\d+/g, "").replace(/\s+/g, " ").trim())
    .filter(t => t.length > 0)
    .join(" ");
}


chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "getTranscript") {
    (async () => {
      try {
        // Try fast API method first
        let transcript = await fetchTranscriptFromAPI();

        // Fall back to DOM scraping if API method fails
        if (!transcript) {
          transcript = await fetchTranscriptFromDOM();
        }

        if (!transcript) {
          sendResponse({
            success: false,
            error: "Transcript not available. Make sure the video has captions enabled."
          });
          return;
        }

        sendResponse({ success: true, transcript });
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }
});
