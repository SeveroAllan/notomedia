/**
 * Adaptador OpenAI para transcrever mensagens de áudio do WhatsApp em português.
 * Isolado de webhooks e regras de negócio para permitir substituição do provedor
 * e testes sem chamadas de rede.
 */

import OpenAI, { toFile } from 'openai';
import type { MidiaBaixada, PortaTranscreverAudio } from './midia-tipos.js';

function extensaoPorMime(mimetype: string): string {
  const base = mimetype.split(';')[0]?.trim().toLowerCase() ?? '';
  if (base.includes('ogg') || base.includes('opus')) return 'ogg';
  if (base.includes('mpeg') || base.includes('mp3')) return 'mp3';
  if (base.includes('mp4') || base.includes('m4a')) return 'm4a';
  if (base.includes('wav')) return 'wav';
  if (base.includes('webm')) return 'webm';
  return 'ogg';
}

export function criarTranscritorAudioOpenAi(
  apiKey: string,
  modelo = 'gpt-4o-mini-transcribe'
): PortaTranscreverAudio {
  const client = new OpenAI({ apiKey, maxRetries: 1, timeout: 15_000 });

  return {
    async transcrever(midia: MidiaBaixada) {
      if (!midia.buffer.length) return { ok: false, motivo: 'AUDIO_VAZIO' };
      const ext = extensaoPorMime(midia.mimetype);
      const mimeLimpo = midia.mimetype.split(';')[0]?.trim() || 'audio/ogg';
      try {
        const arquivo = await toFile(midia.buffer, `audio.${ext}`, { type: mimeLimpo });
        const resp = await client.audio.transcriptions.create({
          file: arquivo,
          model: modelo,
          language: 'pt'
        });
        const texto = String(resp.text ?? '').trim();
        if (!texto) return { ok: false, motivo: 'TRANSCRICAO_VAZIA' };
        return { ok: true, texto: texto.slice(0, 1500) };
      } catch {
        // Fallback para whisper-1 caso o modelo principal esteja indisponível na conta.
        if (modelo !== 'whisper-1') {
          try {
            const arquivo = await toFile(midia.buffer, `audio.${ext}`, { type: mimeLimpo });
            const resp = await client.audio.transcriptions.create({
              file: arquivo,
              model: 'whisper-1',
              language: 'pt'
            });
            const texto = String(resp.text ?? '').trim();
            if (texto) return { ok: true, texto: texto.slice(0, 1500) };
          } catch { /* Cai no retorno padrão de indisponibilidade. */ }
        }
        return { ok: false, motivo: 'TRANSCRICAO_INDISPONIVEL' };
      }
    }
  };
}
