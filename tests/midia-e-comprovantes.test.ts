import { describe, expect, it, vi } from 'vitest';
import express from 'express';
import type pg from 'pg';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { ScriptedModel, assistantMessage } from '@openai/agents/testing';
import {
  classificarMimetypeMidia,
  decodificarBase64Midia,
  LIMITE_BYTES_MIDIA
} from '../src/midia/midia-tipos.js';
import { extrairTextoPdf } from '../src/midia/extrair-texto-pdf.js';
import { extrairCpfValidoDaMensagem, mascararCpfParaChat } from '../src/emissao/extrair-cpf-mensagem.js';
import { criarRouterWebhookAgente } from '../src/agente/webhook.js';
import { criarRouterWebhookPareamento, type MensagemPacienteConsultorio } from '../src/whatsapp/webhook-pareamento.js';

describe('mídia do WhatsApp (áudio, imagem e PDF de comprovantes)', () => {
  it('valida mimetypes permitidos, decodifica base64 e respeita limite de tamanho', () => {
    expect(classificarMimetypeMidia('audio/ogg; codecs=opus')).toBe('audio');
    expect(classificarMimetypeMidia('image/jpeg')).toBe('imagem');
    expect(classificarMimetypeMidia('application/pdf')).toBe('pdf');
    expect(classificarMimetypeMidia('application/x-msdownload')).toBeNull();

    const ok = decodificarBase64Midia(
      `data:image/png;base64,${Buffer.from('fake-png').toString('base64')}`,
      undefined
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(ok.tipo).toBe('imagem');

    const grande = Buffer.alloc(LIMITE_BYTES_MIDIA + 10).toString('base64');
    const excedido = decodificarBase64Midia(grande, 'application/pdf');
    expect(excedido).toEqual({ ok: false, motivo: 'MIDIA_ACIMA_DO_LIMITE' });
  });

  it('extrai texto legível de um PDF real de comprovante gerado com pdf-lib', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([400, 300]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.drawText('Comprovante PIX Valor R$ 350,00 Pagador Maria Silva Data 18/11/2026', { x: 20, y: 200, size: 12, font });
    const pdfBytes = Buffer.from(await doc.save());

    const texto = await extrairTextoPdf(pdfBytes);
    expect(texto).toContain('Comprovante PIX');
    expect(texto).toContain('350,00');
    expect(texto).toContain('Maria Silva');
  });

  it('extrai apenas CPFs válidos (módulo 11) e mascara com segurança', () => {
    expect(extrairCpfValidoDaMensagem('Oi, meu CPF é 529.982.247-25')).toBe('52998224725');
    expect(extrairCpfValidoDaMensagem('cpf 111.111.111-11')).toBeNull();
    expect(extrairCpfValidoDaMensagem('cpf 529.982.247-99')).toBeNull();
    expect(mascararCpfParaChat('52998224725')).toBe('***.982.247-**');
  });

  it('no webhook do Noto transcreve áudio sem legenda reagindo 👂 e lê comprovante sem legenda reagindo 👀 -> ✅', async () => {
    const poolFalso = {
      query: vi.fn(async (sql: string) => {
        if (sql.includes('from usuarios')) return { rows: [{ conta_id: 'conta-midia-1' }] };
        if (sql.includes('from medicos')) return { rows: [{ id: 'med-1', nome_completo: 'Alice Xavier' }] };
        if (sql.includes('from noto_agent_conversas')) return { rows: [{ estado: {} }] };
        if (sql.includes('insert into noto_agent_mensagens')) return { rows: [{ mensagem_id: 'm1' }] };
        return { rows: [] };
      })
    } as unknown as pg.Pool;

    const enviadas: string[] = [];
    const reacoes: string[] = [];
    const transcreverAudio = vi.fn().mockResolvedValue({ ok: true as const, texto: 'Qual foi o último atendimento de novembro?' });
    const lerComprovante = vi.fn().mockResolvedValue({
      ok: true as const,
      dados: {
        ehComprovante: true,
        confianca: 'alta' as const,
        valorCentavos: 35000,
        dataPagamento: '2026-11-20',
        nomePagador: 'Maria Silva',
        cpfPagador: null,
        meioPagamento: 'pix' as const,
        identificadorTransacao: 'E2E12345'
      }
    });
    const processarComprovanteMedico = vi.fn().mockResolvedValue({
      ok: true,
      acao: 'aguardar_prontidao_fiscal',
      motivo: 'CERTIFICADO_A1_PENDENTE'
    });

    const modelo = new ScriptedModel([
      [assistantMessage('O último atendimento de novembro foi Maria Silva.')],
      [assistantMessage('Vi o comprovante de R$ 350 da Maria Silva e deixei o rascunho pronto. Assim que você enviar o Certificado A1, já consigo transmitir.')]
    ]);

    const app = express();
    app.use(express.json());
    app.use('/webhook', criarRouterWebhookAgente({
      pool: poolFalso,
      ativo: true,
      envioAtivo: true,
      segredo: 'segredo-midia',
      instancia: 'instancia_teste_noto',
      allowlist: ['555199990001'],
      modeloTeste: modelo,
      persistirConversa: true,
      reacoesSeletivas: true,
      consultarStatus: async () => ({ tribemd: { salvo: true, conectada: true }, amplimed: { salvo: false, conectada: false } }),
      enviar: async (_tel, txt) => { enviadas.push(txt); return true; },
      reagir: async (_chave, emoji) => { reacoes.push(emoji); return true; },
      baixarMidia: async (_inst, id) => id === 'msg-audio-1'
        ? { base64: Buffer.from('ogg-bytes').toString('base64'), mimetype: 'audio/ogg; codecs=opus' }
        : { base64: Buffer.from('jpg-bytes').toString('base64'), mimetype: 'image/jpeg' },
      transcreverAudio,
      lerComprovante,
      processarComprovanteMedico
    }));

    const server = app.listen(0);
    const { port } = server.address() as { port: number };
    try {
      const rAudio = await fetch(`http://127.0.0.1:${port}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-webhook-secret': 'segredo-midia' },
        body: JSON.stringify({
          instance: 'instancia_teste_noto',
          event: 'messages.upsert',
          data: {
            key: { id: 'msg-audio-1', remoteJid: '555199990001@s.whatsapp.net', fromMe: false },
            message: { audioMessage: { mimetype: 'audio/ogg; codecs=opus' } }
          }
        })
      });
      expect(rAudio.status).toBe(200);
      expect(transcreverAudio).toHaveBeenCalledTimes(1);
      expect(reacoes).toContain('👂');

      const rImg = await fetch(`http://127.0.0.1:${port}/webhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-webhook-secret': 'segredo-midia' },
        body: JSON.stringify({
          instance: 'instancia_teste_noto',
          event: 'messages.upsert',
          data: {
            key: { id: 'msg-img-1', remoteJid: '555199990001@s.whatsapp.net', fromMe: false },
            message: { imageMessage: { mimetype: 'image/jpeg' } }
          }
        })
      });
      expect(rImg.status).toBe(200);
      expect(lerComprovante).toHaveBeenCalledTimes(1);
      expect(processarComprovanteMedico).toHaveBeenCalledTimes(1);
      expect(reacoes.slice(-2)).toEqual(['👀', '✅']);
      expect(JSON.stringify(modelo.calls[1]?.request.input)).toContain('comprovanteRecebidoNoTurno');
    } finally {
      server.close();
    }
  });

  it('no webhook de pareamento do consultório encaminha apenas mensagens privadas de pacientes (ignora grupos e fromMe)', async () => {
    const recebidas: MensagemPacienteConsultorio[] = [];
    const app = express();
    app.use(express.json());
    app.use('/pareamento', criarRouterWebhookPareamento({
      pool: { query: vi.fn() } as unknown as Pick<pg.Pool, 'query'>,
      segredo: 'segredo-par',
      aoReceberMensagemPaciente: async msg => { recebidas.push(msg); }
    }));

    const server = app.listen(0);
    const { port } = server.address() as { port: number };
    try {
      const post = (body: object) => fetch(`http://127.0.0.1:${port}/pareamento`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-webhook-secret': 'segredo-par' },
        body: JSON.stringify(body)
      });

      // Grupo deve ser ignorado.
      await post({
        instance: 'medico_1234567890ab',
        event: 'messages.upsert',
        data: { key: { id: 'g1', remoteJid: '120363@g.us', fromMe: false }, message: { imageMessage: { mimetype: 'image/jpeg' } } }
      });
      // fromMe deve ser ignorado.
      await post({
        instance: 'medico_1234567890ab',
        event: 'messages.upsert',
        data: { key: { id: 'm1', remoteJid: '5551999998888@s.whatsapp.net', fromMe: true }, message: { conversation: 'oi' } }
      });
      // Paciente privado com comprovante deve ser encaminhado.
      const r = await post({
        instance: 'medico_1234567890ab',
        event: 'messages.upsert',
        data: { key: { id: 'p1', remoteJid: '5551999998888@s.whatsapp.net', fromMe: false }, message: { imageMessage: { mimetype: 'image/jpeg' } } }
      });
      expect(r.status).toBe(204);
      await vi.waitFor(() => expect(recebidas).toHaveLength(1));
      expect(recebidas[0]).toMatchObject({
        instancia: 'medico_1234567890ab',
        mensagemId: 'p1',
        telefoneRemetente: '5551999998888',
        tipoMidia: 'imagem'
      });
    } finally {
      server.close();
    }
  });
});
