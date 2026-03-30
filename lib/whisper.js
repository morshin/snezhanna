'use strict';

const axios = require('axios');
const FormData = require('form-data');

async function transcribe(audioBuffer, filename = 'voice.ogg', language = 'ru') {
  const form = new FormData();
  form.append('file', audioBuffer, {
    filename,
    contentType: 'audio/ogg'
  });
  form.append('model', 'whisper-1');
  if (language) form.append('language', language);

  const res = await axios.post(
    'https://api.openai.com/v1/audio/transcriptions',
    form,
    {
      headers: {
        ...form.getHeaders(),
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      }
    }
  );
  return res.data.text;
}

async function tts(text, voice = 'nova') {
  const res = await axios.post(
    'https://api.openai.com/v1/audio/speech',
    { model: 'tts-1', input: text, voice },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: 'arraybuffer'
    }
  );
  return Buffer.from(res.data);
}

module.exports = { transcribe, tts };
