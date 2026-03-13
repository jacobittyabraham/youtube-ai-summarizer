async function openTranscriptPanel() {
  // If transcript segments are already visible, no need to click anything
  if (document.querySelectorAll("ytd-transcript-segment-renderer").length > 0) return;

  // Retry for up to 5s in case the button hasn't rendered yet
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const btn = [...document.querySelectorAll("button")].find(b =>
      b.innerText.toLowerCase().includes("transcript")
    );
    if (btn) {
      btn.click();
      return;
    }
    await new Promise(r => setTimeout(r, 400));
  }
}


async function waitForTranscript(timeout = 12000) {

  return new Promise(resolve => {

    const start = Date.now();

    const interval = setInterval(() => {

      const segments = document.querySelectorAll(
        "ytd-transcript-segment-renderer"
      );

      if (segments.length > 0) {
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

  const segments = document.querySelectorAll(
    "ytd-transcript-segment-renderer"
  );

  if (!segments.length) return null;

  let transcript = [];

  segments.forEach(seg => {

    let text = seg.innerText;

    text = text.replace(/\d+:\d+/g, "");
    text = text.replace(/\s+/g, " ").trim();

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
          sendResponse({
            success: false,
            error: "Transcript not found."
          });
          return;
        }

        sendResponse({
          success: true,
          transcript
        });

      } catch (err) {

        sendResponse({
          success: false,
          error: err.message
        });

      }

    })();

    return true;

  }

});
