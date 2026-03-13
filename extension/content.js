async function openTranscriptPanel() {

  const buttons = [...document.querySelectorAll("button")];

  const transcriptButton = buttons.find(btn =>
    btn.innerText.toLowerCase().includes("transcript")
  );

  if (transcriptButton) {
    transcriptButton.click();
  }

}


async function waitForTranscript(timeout = 5000) {

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
            error: "Transcript could not load."
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