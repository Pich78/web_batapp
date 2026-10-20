/* BatApp WAV encoder.
 *
 * The browser decodes the verified Ogg Vorbis transfer with
 * AudioContext.decodeAudioData(). This file only writes a standard 16-bit
 * PCM RIFF/WAVE container around the resulting samples. It is used by the
 * modern player on HTTP(S); file:// keeps direct Ogg playback because local
 * bytes cannot be read reliably for decoding.
 *
 * Exposes window.BatappWav as a classic script. No modules, no build step.
 */
(function (global) {
  "use strict";

  var CHUNK_FRAMES = 32768;

  function writeAscii(view, offset, text) {
    for (var index = 0; index < text.length; index += 1) {
      view.setUint8(offset + index, text.charCodeAt(index));
    }
  }

  function makeHeader(sampleRate, channels, dataSize) {
    var blockAlign = channels * 2;
    var header = new ArrayBuffer(44);
    var view = new DataView(header);
    writeAscii(view, 0, "RIFF");
    view.setUint32(4, 36 + dataSize, true);
    writeAscii(view, 8, "WAVE");
    writeAscii(view, 12, "fmt ");
    view.setUint32(16, 16, true);                 // PCM fmt chunk size
    view.setUint16(20, 1, true);                  // PCM
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * blockAlign, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, 16, true);                 // bits per sample
    writeAscii(view, 36, "data");
    view.setUint32(40, dataSize, true);
    return header;
  }

  function nextTask() {
    return new Promise(function (resolve) {
      setTimeout(resolve, 0);
    });
  }

  function abortError() {
    try {
      return new DOMException("The operation was aborted.", "AbortError");
    } catch (error) {
      var fallback = new Error("The operation was aborted.");
      fallback.name = "AbortError";
      return fallback;
    }
  }

  async function encode(audioBuffer, options) {
    options = options || {};
    var signal = options.signal;
    var shouldStop = options.shouldStop;

    function stopped() {
      if (signal && signal.aborted) return true;
      if (typeof shouldStop !== "function") return false;
      try { return !!shouldStop(); } catch (error) { return false; }
    }

    if (stopped()) throw abortError();
    if (!audioBuffer || !audioBuffer.length) {
      throw new Error("Cannot encode an empty audio buffer.");
    }
    var channels = Math.min(audioBuffer.numberOfChannels, 2);
    if (channels < 1) throw new Error("Audio buffer has no channels.");
    var sampleRate = audioBuffer.sampleRate;
    var frames = audioBuffer.length;
    var blockAlign = channels * 2;
    var dataSize = frames * blockAlign;
    var parts = [makeHeader(sampleRate, channels, dataSize)];
    var channelData = [];
    for (var channel = 0; channel < channels; channel += 1) {
      channelData.push(audioBuffer.getChannelData(channel));
    }

    for (var start = 0; start < frames; start += CHUNK_FRAMES) {
      if (stopped()) {
        parts.length = 0;
        throw abortError();
      }
      var end = Math.min(start + CHUNK_FRAMES, frames);
      var chunk = new ArrayBuffer((end - start) * blockAlign);
      var view = new DataView(chunk);
      var offset = 0;
      for (var frame = start; frame < end; frame += 1) {
        for (var current = 0; current < channels; current += 1) {
          var sample = channelData[current][frame];
          if (sample > 1) sample = 1;
          else if (sample < -1) sample = -1;
          view.setInt16(offset, Math.round(sample < 0 ? sample * 0x8000 : sample * 0x7fff), true);
          offset += 2;
        }
      }
      parts.push(chunk);
      // Keep the loading UI responsive while encoding long clips.
      if (parts.length % 8 === 0) {
        await nextTask();
        if (stopped()) {
          parts.length = 0;
          throw abortError();
        }
      }
    }

    await nextTask();
    if (stopped()) {
      parts.length = 0;
      throw abortError();
    }
    var blob = new Blob(parts, { type: "audio/wav" });
    parts.length = 0;
    return {
      blob: blob,
      bytes: 44 + dataSize,
      duration: frames / sampleRate,
      frames: frames,
      sampleRate: sampleRate,
      channels: channels,
      bitsPerSample: 16
    };
  }

  global.BatappWav = {
    encode: encode
  };
})(window);
