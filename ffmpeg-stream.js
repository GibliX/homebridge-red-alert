/**
 * FFmpeg Camera Streaming for Red Alert Doorbell
 * Based on homebridge-videodoorbell implementation
 * Provides SRTP video streaming for HomeKit camera integration
 */

const spawn = require("child_process").spawn;
const crypto = require("crypto");
const ip = require("ip");

class FFMPEGStreamingDelegate {
  constructor(hap, cameraConfig, log, videoProcessor) {
    this.hap = hap;
    this.log = log;
    this.videoProcessor = videoProcessor || "ffmpeg";

    // Video configuration
    this.videoConfig = cameraConfig.videoConfig || {};
    this.source = this.videoConfig.source;
    this.stillImageSource = this.videoConfig.stillImageSource || this.source;
    this.maxWidth = this.videoConfig.maxWidth || 1280;
    this.maxHeight = this.videoConfig.maxHeight || 720;
    this.maxFPS = this.videoConfig.maxFPS || 30;
    this.maxBitrate = this.videoConfig.maxBitrate || 300;
    this.vcodec = this.videoConfig.vcodec || "libx264";
    this.packetSize = this.videoConfig.packetSize || 1316;

    // Audio configuration
    this.audio = this.videoConfig.audio !== false;
    this.acodec = this.videoConfig.acodec || "libfdk_aac";
    this.audioSampleRate = this.videoConfig.audioSampleRate || 16;
    this.audioBitrate = this.videoConfig.audioBitrate || 24;

    // Session management
    this.pendingSessions = {};
    this.ongoingSessions = {};

    // Services
    this.services = [];

    // Create StreamControllers
    const options = {
      proxy: false,
      srtp: true,
      video: {
        resolutions: [
          [1920, 1080, 30],
          [1280, 720, 30],
          [640, 480, 30],
          [640, 360, 30],
          [480, 360, 30],
          [480, 270, 30],
          [320, 240, 30],
          [320, 240, 15],
          [320, 180, 30],
        ],
        codec: {
          profiles: [0, 1, 2],
          levels: [0, 1, 2],
        },
      },
      audio: {
        codecs: [
          {
            type: "AAC-eld",
            samplerate: 16,
          },
        ],
      },
    };

    this.createCameraControlService();

    // Create two stream controllers for concurrent streaming
    const maxStreams = 2;
    for (let i = 0; i < maxStreams; i++) {
      const streamController = new hap.StreamController(i, options, this);
      this.services.push(streamController.service);
    }
  }

  createCameraControlService() {
    const controlService = new this.hap.Service.CameraControl();
    this.services.push(controlService);

    if (this.audio) {
      const microphoneService = new this.hap.Service.Microphone();
      this.services.push(microphoneService);
    }
  }

  handleSnapshotRequest(request, callback) {
    const resolution = `${request.width}x${request.height}`;
    this.log.debug(`Snapshot requested: ${resolution}`);

    const ffmpegArgs =
      `${this.stillImageSource} -t 1 -s ${resolution} -f image2 -`.split(" ");

    this.log.debug(`Snapshot command: ${this.videoProcessor} ${ffmpegArgs.join(" ")}`);

    const ffmpeg = spawn(this.videoProcessor, ffmpegArgs, {
      env: process.env,
    });

    let imageBuffer = Buffer.alloc(0);

    ffmpeg.stdout.on("data", (data) => {
      imageBuffer = Buffer.concat([imageBuffer, data]);
    });

    ffmpeg.stderr.on("data", (data) => {
      this.log.debug(`Snapshot stderr: ${data.toString()}`);
    });

    ffmpeg.on("close", (code) => {
      if (code === 0) {
        this.log.debug(`Snapshot captured: ${imageBuffer.length} bytes`);
        callback(undefined, imageBuffer);
      } else {
        this.log.error(`Snapshot failed with code ${code}`);
        callback(new Error(`FFmpeg exited with code ${code}`));
      }
    });

    ffmpeg.on("error", (error) => {
      this.log.error(`Snapshot error: ${error.message}`);
      callback(error);
    });
  }

  prepareStream(request, callback) {
    const sessionId = request.sessionID;
    const targetAddress = request.targetAddress;

    // Generate session info
    const sessionInfo = {
      address: targetAddress,
      videoPort: request.video.port,
      videoCryptoSuite: request.video.srtpCryptoSuite,
      videoSRTP: Buffer.concat([
        request.video.srtp_key,
        request.video.srtp_salt,
      ]),
      videoSSRC: this.hap.CameraController.generateSynchronisationSource(),
    };

    if (request.audio) {
      sessionInfo.audioPort = request.audio.port;
      sessionInfo.audioCryptoSuite = request.audio.srtpCryptoSuite;
      sessionInfo.audioSRTP = Buffer.concat([
        request.audio.srtp_key,
        request.audio.srtp_salt,
      ]);
      sessionInfo.audioSSRC = this.hap.CameraController.generateSynchronisationSource();
    }

    this.pendingSessions[sessionId] = sessionInfo;

    const response = {
      video: {
        port: request.video.port,
        ssrc: sessionInfo.videoSSRC,
        srtp_key: request.video.srtp_key,
        srtp_salt: request.video.srtp_salt,
      },
    };

    if (request.audio) {
      response.audio = {
        port: request.audio.port,
        ssrc: sessionInfo.audioSSRC,
        srtp_key: request.audio.srtp_key,
        srtp_salt: request.audio.srtp_salt,
      };
    }

    callback(response);
  }

  handleStreamRequest(request, callback) {
    const sessionId = request.sessionID;

    if (request.type === "start") {
      const sessionInfo = this.pendingSessions[sessionId];
      if (!sessionInfo) {
        this.log.error("No pending session found for stream start");
        callback(new Error("No pending session"));
        return;
      }

      const width = request.video.width;
      const height = request.video.height;
      const fps = Math.min(request.video.fps, this.maxFPS);
      const bitrate = Math.min(request.video.max_bit_rate, this.maxBitrate);

      this.log.info(
        `Starting stream: ${width}x${height}@${fps}fps, ${bitrate}kbps`
      );

      // Build FFmpeg command
      let ffmpegArgs = this.source.split(" ");

      // Video encoding
      ffmpegArgs.push(
        "-map", "0:v",
        "-vcodec", this.vcodec,
        "-pix_fmt", "yuv420p",
        "-r", fps.toString(),
        "-f", "rawvideo",
        "-tune", "zerolatency",
        "-vf", `scale=${width}:${height}`,
        "-b:v", `${bitrate}k`,
        "-bufsize", `${bitrate * 2}k`,
        "-maxrate", `${bitrate}k`,
        "-payload_type", "99"
      );

      // Video SRTP output
      ffmpegArgs.push(
        "-ssrc", sessionInfo.videoSSRC.toString(),
        "-f", "rtp",
        "-srtp_out_suite", "AES_CM_128_HMAC_SHA1_80",
        "-srtp_out_params", sessionInfo.videoSRTP.toString("base64"),
        `srtp://${sessionInfo.address}:${sessionInfo.videoPort}?rtcpport=${sessionInfo.videoPort}&localrtcpport=${sessionInfo.videoPort}&pkt_size=${this.packetSize}`
      );

      // Audio (if enabled)
      if (this.audio && sessionInfo.audioPort) {
        ffmpegArgs.push(
          "-map", "0:a",
          "-acodec", "libfdk_aac",
          "-profile:a", "aac_eld",
          "-flags", "+global_header",
          "-f", "null",
          "-ar", `${this.audioSampleRate}k`,
          "-b:a", `${this.audioBitrate}k`,
          "-ac", "1",
          "-payload_type", "110",
          "-ssrc", sessionInfo.audioSSRC.toString(),
          "-f", "rtp",
          "-srtp_out_suite", "AES_CM_128_HMAC_SHA1_80",
          "-srtp_out_params", sessionInfo.audioSRTP.toString("base64"),
          `srtp://${sessionInfo.address}:${sessionInfo.audioPort}?rtcpport=${sessionInfo.audioPort}&localrtcpport=${sessionInfo.audioPort}&pkt_size=188`
        );
      }

      this.log.debug(`FFmpeg command: ${this.videoProcessor} ${ffmpegArgs.join(" ")}`);

      const ffmpeg = spawn(this.videoProcessor, ffmpegArgs, {
        env: process.env,
      });

      ffmpeg.stderr.on("data", (data) => {
        this.log.debug(`FFmpeg: ${data.toString()}`);
      });

      ffmpeg.on("error", (error) => {
        this.log.error(`FFmpeg error: ${error.message}`);
      });

      ffmpeg.on("close", (code) => {
        if (code !== 0 && code !== 255) {
          this.log.error(`FFmpeg exited with code ${code}`);
        }
        delete this.ongoingSessions[sessionId];
      });

      this.ongoingSessions[sessionId] = ffmpeg;
      delete this.pendingSessions[sessionId];

      callback();
    } else if (request.type === "stop") {
      const ffmpeg = this.ongoingSessions[sessionId];
      if (ffmpeg) {
        ffmpeg.kill("SIGKILL");
        delete this.ongoingSessions[sessionId];
      }
      callback();
    } else {
      // reconfigure - just acknowledge
      callback();
    }
  }
}

module.exports = { FFMPEGStreamingDelegate };
