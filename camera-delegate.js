/**
 * Camera Streaming Delegate for Red Alert Doorbell
 * Provides dynamic image switching based on alert state
 */

const { spawn } = require("child_process");
const path = require("path");

class RedAlertCameraDelegate {
  constructor(hap, config, log, plugin) {
    this.hap = hap;
    this.log = log;
    this.plugin = plugin;
    this.videoProcessor = config.videoProcessor || "ffmpeg";

    // Image paths for different states
    this.mediaPath = config.mediaPath || path.join(__dirname, "media");
    this.idleImage = path.join(this.mediaPath, "idle.png");
    this.alertImage = path.join(this.mediaPath, "alert-still.png");
    this.preAlertImage = path.join(this.mediaPath, "pre-alert.png");

    // Current state
    this.currentState = "idle"; // idle, pre-alert, alert

    // Session management
    this.pendingSessions = new Map();
    this.ongoingSessions = new Map();

    // Controller will be set by platform
    this.controller = null;
  }

  setCurrentState(state) {
    this.log.info(`Camera state changed: ${this.currentState} -> ${state}`);
    this.currentState = state;
  }

  getCurrentImage() {
    switch (this.currentState) {
      case "alert":
        return this.alertImage;
      case "pre-alert":
        return this.preAlertImage;
      default:
        return this.idleImage;
    }
  }

  // Called by HomeKit to get camera snapshots
  handleSnapshotRequest(request, callback) {
    const width = request.width || 1280;
    const height = request.height || 720;
    const currentImage = this.getCurrentImage();

    this.log.debug(`Snapshot requested: ${width}x${height}, state: ${this.currentState}`);

    const ffmpegArgs = [
      "-i", currentImage,
      "-vf", `scale=${width}:${height}`,
      "-frames:v", "1",
      "-f", "image2",
      "-"
    ];

    const ffmpeg = spawn(this.videoProcessor, ffmpegArgs, {
      env: process.env,
    });

    let imageBuffer = Buffer.alloc(0);

    ffmpeg.stdout.on("data", (data) => {
      imageBuffer = Buffer.concat([imageBuffer, data]);
    });

    ffmpeg.stderr.on("data", (data) => {
      this.log.debug(`Snapshot ffmpeg: ${data.toString()}`);
    });

    ffmpeg.on("close", (code) => {
      if (code === 0 && imageBuffer.length > 0) {
        this.log.debug(`Snapshot captured: ${imageBuffer.length} bytes`);
        callback(undefined, imageBuffer);
      } else {
        this.log.warn(`Snapshot failed with code ${code}, using fallback`);
        callback(new Error("Snapshot failed"));
      }
    });

    ffmpeg.on("error", (error) => {
      this.log.error(`Snapshot error: ${error.message}`);
      callback(error);
    });
  }

  // Prepare stream session
  prepareStream(request, callback) {
    const sessionId = request.sessionID;
    const targetAddress = request.targetAddress;

    const sessionInfo = {
      address: targetAddress,
      videoPort: request.video.port,
      videoSRTP: Buffer.concat([
        request.video.srtp_key,
        request.video.srtp_salt,
      ]),
      videoSSRC: this.hap.CameraController.generateSynchronisationSource(),
    };

    this.pendingSessions.set(sessionId, sessionInfo);

    const response = {
      video: {
        port: request.video.port,
        ssrc: sessionInfo.videoSSRC,
        srtp_key: request.video.srtp_key,
        srtp_salt: request.video.srtp_salt,
      },
    };

    callback(undefined, response);
  }

  // Handle stream start/stop
  handleStreamRequest(request, callback) {
    const sessionId = request.sessionID;

    switch (request.type) {
      case this.hap.StreamRequestTypes.START:
        this.startStream(sessionId, request, callback);
        break;
      case this.hap.StreamRequestTypes.STOP:
        this.stopStream(sessionId, callback);
        break;
      case this.hap.StreamRequestTypes.RECONFIGURE:
        callback();
        break;
    }
  }

  startStream(sessionId, request, callback) {
    const sessionInfo = this.pendingSessions.get(sessionId);
    if (!sessionInfo) {
      this.log.error("No pending session for stream start");
      callback(new Error("No pending session"));
      return;
    }

    const width = request.video.width;
    const height = request.video.height;
    const fps = Math.min(request.video.fps, 30);
    const bitrate = Math.min(request.video.max_bit_rate, 1000);
    const currentImage = this.getCurrentImage();

    this.log.info(`Starting stream: ${width}x${height}@${fps}fps, state: ${this.currentState}`);

    const ffmpegArgs = [
      "-loop", "1",
      "-i", currentImage,
      "-vf", `scale=${width}:${height}`,
      "-vcodec", "libx264",
      "-pix_fmt", "yuv420p",
      "-r", fps.toString(),
      "-tune", "stillimage",
      "-preset", "ultrafast",
      "-b:v", `${bitrate}k`,
      "-bufsize", `${bitrate * 2}k`,
      "-maxrate", `${bitrate}k`,
      "-payload_type", "99",
      "-ssrc", sessionInfo.videoSSRC.toString(),
      "-f", "rtp",
      "-srtp_out_suite", "AES_CM_128_HMAC_SHA1_80",
      "-srtp_out_params", sessionInfo.videoSRTP.toString("base64"),
      `srtp://${sessionInfo.address}:${sessionInfo.videoPort}?rtcpport=${sessionInfo.videoPort}&pkt_size=1316`,
    ];

    this.log.debug(`FFmpeg: ${this.videoProcessor} ${ffmpegArgs.join(" ")}`);

    const ffmpeg = spawn(this.videoProcessor, ffmpegArgs, {
      env: process.env,
    });

    ffmpeg.stderr.on("data", (data) => {
      this.log.debug(`Stream: ${data.toString()}`);
    });

    ffmpeg.on("error", (error) => {
      this.log.error(`Stream error: ${error.message}`);
    });

    ffmpeg.on("close", (code) => {
      if (code && code !== 255) {
        this.log.warn(`Stream ended with code ${code}`);
      }
      this.ongoingSessions.delete(sessionId);
    });

    this.ongoingSessions.set(sessionId, ffmpeg);
    this.pendingSessions.delete(sessionId);
    callback();
  }

  stopStream(sessionId, callback) {
    const ffmpeg = this.ongoingSessions.get(sessionId);
    if (ffmpeg) {
      ffmpeg.kill("SIGKILL");
      this.ongoingSessions.delete(sessionId);
    }
    callback();
  }
}

module.exports = { RedAlertCameraDelegate };
