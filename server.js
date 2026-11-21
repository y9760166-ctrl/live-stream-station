
require("dotenv").config();

const express = require("express");
const fs = require("fs");
const path = require("path");
const { spawn, execFile } = require("child_process");

const app = express();
const PORT = process.env.PORT || 3000;
const STREAM_URL = process.env.STREAM_URL || "";
const RECORDINGS_DIR = path.resolve("recordings");
const SEGMENT_MINUTES = 60;

fs.mkdirSync(RECORDINGS_DIR, { recursive: true });

let status = {
  status: "ממתין",
  message: "השרת הופעל"
};

function getRecordings() {
  return fs.readdirSync(RECORDINGS_DIR)
    .filter(file => file.endsWith(".ts"))
    .map(file => {
      const stat = fs.statSync(path.join(RECORDINGS_DIR, file));
      return {
        name: file,
        size: stat.size,
        modified: stat.mtime
      };
    })
    .sort((a, b) => b.modified - a.modified);
}

app.use(express.static(path.join(__dirname, "public")));

app.get("/api/status", (req, res) => {
  res.json({
    ...status,
    sourceConfigured: Boolean(STREAM_URL),
    recordings: getRecordings()
  });
});

function startRecorder() {
  if (!STREAM_URL) {
    status = {
      status: "חסר מקור שידור",
      message: "יש להגדיר STREAM_URL"
    };
    return;
  }

  execFile("ffmpeg", ["-version"], error => {
    if (error) {
      status = {
        status: "FFmpeg לא מותקן",
        message: "השרת זקוק ל-FFmpeg"
      };
      return;
    }

    const output = path.join(
      RECORDINGS_DIR,
      "recording-%Y%m%d-%H%M%S.ts"
    );

    const args = [
      "-hide_banner",
      "-loglevel", "warning",
      "-reconnect", "1",
      "-reconnect_streamed", "1",
      "-reconnect_delay_max", "10",
      "-i", STREAM_URL,
      "-map", "0",
      "-c", "copy",
      "-f", "segment",
      "-segment_time", String(SEGMENT_MINUTES * 60),
      "-reset_timestamps", "1",
      "-strftime", "1",
      output
    ];

    const recorder = spawn("ffmpeg", args);

    status = {
      status: "מקליט",
      message: "ההקלטה פועלת",
      startedAt: new Date().toISOString()
    };

    recorder.stderr.on("data", data => {
      status.message = String(data).trim().slice(-300);
    });

    recorder.on("close", code => {
      status = {
        status: "ההקלטה נעצרה",
        message: "FFmpeg הסתיים בקוד " + code
      };
    });
  });
}

app.listen(PORT, () => {
  console.log("Server started on port " + PORT);
  startRecorder();
});
