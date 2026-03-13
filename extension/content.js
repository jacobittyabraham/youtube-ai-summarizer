async function expandDescription() {
  // The transcript button is hidden until the description is expanded
  const allButtons = [...document.querySelectorAll("button, tp-yt-paper-button")];
  const moreBtn = allButtons.find(b => {
    const text = (b.innerText || b.textContent || "").toLowerCase().trim();
    return text === "more" || text === "...more" || text === "show more";
  });
  if (moreBtn) {
    moreBtn.click();
    await new Promise(r => setTimeout(r, 600));
  }
}

async function openTranscriptPanel() {
  // If transcript segments are already visible, nothing to do
  if (document.querySelectorAll("ytd-transcript-segment-renderer").length > 0) return;

  // Expand description first so the transcript button becomes visible
  await expandDescription();

  // Retry for up to 8s in case YouTube is still rendering
  const deadline = Date.now() + 8000;
  while (Date.now() < deadline) {
    const btn = [...document.querySelectorAll("button, tp-yt-paper-button")].find(b =>
      (b.innerText || b.textContent || "").toLowerCase().includes("transcript")
    );
    if (btn) {
      btn.click();
      return;
    }
    await new Promise(r => setTimeout(r, 400));
  }
}


async function waitForTranscript(timeout = 20000) {
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

  let transcript = [];
  segments.forEach(seg => {
    let text = seg.innerText;
    text = text.replace(/\d+:\d+/g, "").replace(/\s+/g, " ").trim();
    if (text.length > 0) transcript.push(text);
  });

  return transcript.join(" ");
}


chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === "getTranscript") {
    (async () => {
      try {
        await openTranscriptPanel();
        const loaded = await waitForTranscript();

        if (!loaded) {
          sendResponse({
            success: false,
            error: "Transcript could not load. Make sure the video has captions and try again."
          });
          return;
        }

        const transcript = extractTranscript();
        if (!transcript) {
          sendResponse({ success: false, error: "Transcript not found." });
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
