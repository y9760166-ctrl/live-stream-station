require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;

const STREAM_URL =
  process.env.STREAM_URL ||
  "https://contact.gostreaming.tv/Con-9/tracks-v3a1/mono.ts.m3u8";

const RECORDINGS_DIR = path.resolve("recordings");
const CHECK_INTERVAL = 15 * 1000;
const STOP_AFTER_MISSES = 3;
const SEGMENT_MINUTES = 60;

fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

let recorder = null;
let checking = false;
let lastSignature = null;
let missedChecks = 0;
let stoppingRecorder = false;

let status = {
  state: "ממתין",
  message: "ממתין לזיהוי שידור",
  lastCheck: null
};

function getRecordings() {
  return fs.readdirSync(RECORDINGS_DIR)
    .filter(name => name.endsWith(".ts"))
    .map(name => {
      const file = path.join(RECORDINGS_DIR, name);
      const stat = fs.statSync(file);
      return { name, size: stat.size, modified: stat.mtime };
    })
    .sort((a, b) => b.modified - a.modified);
}

async function readActivePlaylist() {
  const response = await fetch(STREAM_URL, {
    signal: AbortSignal.timeout(15000),
    headers: { "User-Agent": "Mozilla/5.0" }
  });

  if (!response.ok) {
    throw new Error("HTTP " + response.status);
  }

  const playlist = await response.text();

  if (!playlist.includes("#EXTM3U")) {
    throw new Error("המקור אינו רשימת HLS תקינה");
  }

  if (playlist.includes("#EXT-X-ENDLIST")) {
    throw new Error("רשימת השידור הסתיימה");
  }

  const lines = playlist
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);

  const segments = lines.filter(line => !line.startsWith("#"));

  if (segments.length === 0) {
    throw new Error("אין מקטעי שידור ברשימה");
  }

  const lastSegmentUrl = new URL(segments[segments.length - 1], STREAM_URL).toString();

  // בדיקה שהמקטע האחרון אכן נגיש, ולא רק שקיימת רשימת M3U8 ישנה.
  const probe = await fetch(lastSegmentUrl, {
    method: "GET",
    signal: AbortSignal.timeout(12000),
    headers: {
      "User-Agent": "Mozilla/5.0",
      "Range": "bytes=0-0"
    }
  });

  if (!probe.ok && probe.status !== 206) {
    throw new Error("מקטע השידור אינו נגיש: HTTP " + probe.status);
  }

  if (probe.body) {
    await probe.body.cancel().catch(() => {});
  }

  const sequenceLine = lines.find(line => line.startsWith("#EXT-X-MEDIA-SEQUENCE:")) || "";
  const sequence = sequenceLine.split(":")[1] || "";
  return sequence + "|" + lastSegmentUrl;
}

async function checkStream() {
  if (checking) return;
  checking = true;

  try {
    const signature = await readActivePlaylist();
    status.lastCheck = new Date().toISOString();

    if (signature !== lastSignature) {
      lastSignature = signature;
      missedChecks = 0;

      if (!recorder) {
        startRecording();
      } else if (!stoppingRecorder) {
        status = {
          state: "מקליט",
          message: "השידור פעיל ומקטעים חדשים מתקבלים",
          lastCheck: status.lastCheck
        };
      }
    } else {
      missedChecks++;

      if (recorder && missedChecks >= STOP_AFTER_MISSES) {
        stopRecording("לא התקבלו מקטעים חדשים במשך שלוש בדיקות");
      } else if (!recorder) {
        status = {
          state: "ממתין",
          message: "רשימת השידור לא התקדמה; ממתין לשידור פעיל",
          lastCheck: status.lastCheck
        };
      }
    }
  } catch (error) {
    missedChecks++;
    status.lastCheck = new Date().toISOString();

    if (recorder && missedChecks >= STOP_AFTER_MISSES) {
      stopRecording("המקור אינו זמין: " + error.message);
    } else if (!recorder) {
      status = {
        state: "ממתין",
        message: "המקור אינו זמין כרגע: " + error.message,
        lastCheck: status.lastCheck
      };
    }
  } finally {
    checking = false;
  }
}

function startRecording() {
  if (recorder) return;

  const output = path.join(RECORDINGS_DIR, "recording-%Y%m%d-%H%M%S.ts");
  const args = [
    "-hide_banner",
    "-loglevel", "warning",
    "-rw_timeout", "15000000",
    "-i", STREAM_URL,
    "-map", "0",
    "-c", "copy",
    "-f", "segment",
    "-segment_time", String(SEGMENT_MINUTES * 60),
    "-reset_timestamps", "1",
    "-strftime", "1",
    output
  ];

  let child;

  try {
    child = spawn("ffmpeg", args);
    recorder = child;
    stoppingRecorder = false;

    status = {
      state: "מקליט",
      message: "זוהה שידור פעיל – FFmpeg הופעל",
      lastCheck: new Date().toISOString()
    };

    child.on("error", error => {
      if (recorder === child) recorder = null;
      stoppingRecorder = false;
      status = {
        state: "שגיאה",
        message: "לא ניתן להפעיל FFmpeg: " + error.message,
        lastCheck: new Date().toISOString()
      };
    });

    child.on("close", code => {
      if (recorder === child) recorder = null;
      stoppingRecorder = false;

      status = {
        state: "ממתין",
        message: "תהליך ההקלטה הסתיים (קוד " + code + "). ממתין לשידור הבא.",
        lastCheck: new Date().toISOString()
      };
    });
  } catch (error) {
    recorder = null;
    status = {
      state: "שגיאה",
      message: "שגיאה בהפעלת ההקלטה: " + error.message,
      lastCheck: new Date().toISOString()
    };
  }
}

function stopRecording(reason) {
  if (!recorder || stoppingRecorder) return;

  stoppingRecorder = true;
  status = {
    state: "ממתין",
    message: reason + " – עוצר את ההקלטה",
    lastCheck: new Date().toISOString()
  };

  recorder.kill("SIGINT");
  lastSignature = null;
  missedChecks = 0;
}

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/status", (req, res) => {
  res.json({
    ...status,
    recording: Boolean(recorder) && !stoppingRecorder,
    sourceConfigured: Boolean(STREAM_URL),
    recordings: getRecordings()
  });
});

app.get("/api/recordings/:name", (req, res) => {
  const name = path.basename(req.params.name);

  if (!name.endsWith(".ts")) return res.sendStatus(400);

  const file = path.join(RECORDINGS_DIR, name);
  if (!fs.existsSync(file)) return res.sendStatus(404);

  res.download(file);
});

app.listen(PORT, () => {
  console.log("Server started on port " + PORT);
  checkStream();
  setInterval(checkStream, CHECK_INTERVAL);
});
