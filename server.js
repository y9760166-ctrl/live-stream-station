
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
const CHECK_INTERVAL = 30 * 1000;
const STOP_AFTER_MISSES = 3;
const SEGMENT_MINUTES = 60;

fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

let recorder = null;
let checking = false;
let lastSignature = null;
let missedChecks = 0;

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

      return {
        name,
        size: stat.size,
        modified: stat.mtime
      };
    })
    .sort((a, b) => b.modified - a.modified);
}

async function checkStream() {
  if (checking) return;
  checking = true;

  try {
    const response = await fetch(STREAM_URL, {
      signal: AbortSignal.timeout(15000),
      headers: {
        "User-Agent": "Mozilla/5.0"
      }
    });

    if (!response.ok) {
      throw new Error("HTTP " + response.status);
    }

    const playlist = await response.text();

    if (!playlist.includes("#EXTM3U")) {
      throw new Error("המקור אינו רשימת HLS תקינה");
    }

    const segments = playlist
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(line => line && !line.startsWith("#"));

    if (segments.length === 0) {
      throw new Error("אין מקטעי שידור");
    }

    const signature = segments.slice(-3).join("|");
    status.lastCheck = new Date().toISOString();

    if (signature !== lastSignature) {
      lastSignature = signature;
      missedChecks = 0;

      if (!recorder) {
        startRecording();
      } else {
        status = {
          state: "מקליט",
          message: "השידור פעיל וההקלטה נמשכת",
          lastCheck: status.lastCheck
        };
      }
    } else {
      missedChecks++;

      if (recorder && missedChecks >= STOP_AFTER_MISSES) {
        stopRecording();
      } else if (!recorder) {
        status = {
          state: "ממתין",
          message: "ממתין למקטעי שידור חדשים",
          lastCheck: status.lastCheck
        };
      }
    }

  } catch (error) {
    missedChecks++;

    status.lastCheck = new Date().toISOString();
    status.message = "בדיקת מקור: " + error.message;

    if (recorder && missedChecks >= STOP_AFTER_MISSES) {
      stopRecording();
    } else if (!recorder) {
      status.state = "ממתין";
    }

  } finally {
    checking = false;
  }
}

function startRecording() {
  if (recorder) return;

  const output = path.join(
    RECORDINGS_DIR,
    "recording-%Y%m%d-%H%M%S.ts"
  );

  const args = [
    "-hide_banner",
    "-loglevel", "warning",
    "-i", STREAM_URL,
    "-map", "0",
    "-c", "copy",
    "-f", "segment",
    "-segment_time", String(SEGMENT_MINUTES * 60),
    "-reset_timestamps", "1",
    "-strftime", "1",
    output
  ];

  recorder = spawn("ffmpeg", args);

  status = {
    state: "מקליט",
    message: "זוהה שידור חדש – ההקלטה התחילה",
    lastCheck: new Date().toISOString()
  };

  recorder.on("error", error => {
    status = {
      state: "שגיאה",
      message: "שגיאת FFmpeg: " + error.message,
      lastCheck: new Date().toISOString()
    };
    recorder = null;
  });

  recorder.on("close", code => {
    recorder = null;

    if (status.state !== "ממתין") {
      status = {
        state: "ממתין",
        message: "ההקלטה הסתיימה. ממתין לשידור הבא. קוד: " + code,
        lastCheck: new Date().toISOString()
      };
    }
  });
}

function stopRecording() {
  if (!recorder) return;

  status = {
    state: "ממתין",
    message: "השידור הסתיים – עוצר את ההקלטה",
    lastCheck: new Date().toISOString()
  };

  recorder.kill("SIGINT");
  recorder = null;
  lastSignature = null;
  missedChecks = 0;
}

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/status", (req, res) => {
  res.json({
    ...status,
    recording: Boolean(recorder),
    sourceConfigured: Boolean(STREAM_URL),
    recordings: getRecordings()
  });
});

app.get("/api/recordings/:name", (req, res) => {
  const name = path.basename(req.params.name);

  if (!name.endsWith(".ts")) {
    return res.sendStatus(400);
  }

  const file = path.join(RECORDINGS_DIR, name);

  if (!fs.existsSync(file)) {
    return res.sendStatus(404);
  }

  res.download(file);
});

app.listen(PORT, () => {
  console.log("Server started on port " + PORT);

  checkStream();
  setInterval(checkStream, CHECK_INTERVAL);
});
