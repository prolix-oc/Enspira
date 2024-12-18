// === audio-manager.js ===
import axios from "axios";
import Speaker from "speaker";
import { Transform } from "stream";
import * as portAudio from "naudiodon";

export class AudioPlayer {
  constructor() {
    this.currentStream = null;
    this.speaker = null;
    this.currentDevice = null;

    try {
    } catch (error) {}
  }

  findDeviceByName(deviceName) {
    const devices = this.getAudioDevices();

    // Find exact or partial match
    const matchingDevice = devices.find((dev) =>
      dev.name.toLowerCase().includes(deviceName.toLowerCase()),
    );

    if (!matchingDevice) {
      throw new Error(`No device found matching the name: ${deviceName}`);
    }

    return matchingDevice;
  }

  getAudioDevices() {
    try {
      const allDevices = portAudio.getDevices();
      return allDevices
        .filter((device) => device.maxOutputChannels > 0)
        .map((device) => ({
          id: device.id,
          name: device.name,
          maxOutputChannels: device.maxOutputChannels,
          defaultSampleRate: device.defaultSampleRate,
        }));
    } catch (error) {
      return [];
    }
  }

  // Modified to use device name or ID
  async playAudioOnDevice(url, deviceNameOrId) {
    let targetDevice;

    if (typeof deviceNameOrId === "string") {
      targetDevice = this.findDeviceByName(deviceNameOrId);
    } else if (typeof deviceNameOrId === "number") {
      const devices = this.getAudioDevices();
      targetDevice = devices.find((dev) => dev.id === deviceNameOrId);
      if (!targetDevice) {
        throw new Error(`No audio device found with ID: ${deviceNameOrId}`);
      }
    } else {
      throw new Error(
        "Device must be specified by name (string) or ID (number)",
      );
    }

    return this.playAudio(url, targetDevice.id);
  }

  stopPlayback() {
    if (this.currentStream) {
      this.currentStream.unpipe();
      this.currentStream.destroy();
    }
    if (this.speaker) {
      this.speaker.end();
    }
    this.currentStream = null;
    this.speaker = null;
  }

  async playAudio(url, deviceId) {
    try {
      this.stopPlayback();

      // Fetch file audio info
      const speakerConfig = {
        channels: 1,
        bitDepth: 16,
        sampleRate: 48000,
        device: deviceId,
      };

      this.speaker = new Speaker(speakerConfig);

      const audioTransform = new Transform({
        transform(chunk, encoding, callback) {
          callback(null, chunk);
        },
      });

      const response = await axios({
        method: "get",
        url: url,
        responseType: "stream",
      });

      this.currentStream = response.data;

      this.currentStream.pipe(audioTransform).pipe(this.speaker);

      this.currentStream.on("error", (error) => {
        this.stopPlayback();
      });

      this.speaker.on("error", (error) => {
        this.stopPlayback();
      });
    } catch (error) {
      this.stopPlayback();
      throw error;
    }
  }

  // New method to get current device info
  getCurrentDevice() {
    return this.currentDevice;
  }
}

export const audioPlayer = new AudioPlayer();
export default audioPlayer;
