/**
 * Adaptador OpenAI para identificar e extrair dados estruturados de comprovantes
 * de pagamento (imagem ou PDF). Usa texto nativo do PDF primeiro (mais rápido e
 * barato) e recorre à visão computacional quando for imagem ou PDF sem texto.
 */

import OpenAI from 'openai';
import { z } from 'zod';
import { validarCpf } from '../paciente/validar-cpf.js';
import { extrairTextoPdf } from './extrair-texto-pdf.js';
import {
  classificarMimetypeMidia,
  type DadosComprovanteExtraido,
  type MidiaBaixada,
  type PortaLerComprovante
} from './midia-tipos.js';

const comprovanteSchema = z.object({
  ehComprovante: z.boolean(),
  confianca: z.enum(['alta', 'media', 'baixa']).default('baixa'),
  valorCentavos: z.number().int().positive().nullable().optional(),
  dataPagamento: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  nomePagador: z.string().trim().min(2).max(160).nullable().optional(),
  cpfPagador: z.string().trim().max(30).nullable().optional(),
  meioPagamento: z.enum(['pix', 'ted', 'cartao', 'boleto', 'dinheiro', 'outro']).nullable().optional(),
  identificadorTransacao: z.string().trim().max(120).nullable().optional(),
  resumoCurto: z.string().trim().max(220).nullable().optional()
});

const PROMPT_EXTRATOR_COMPROVANTE = [
  'Você analisa arquivos recebidos no WhatsApp de um consultório médico brasileiro.',
  'Decida se o arquivo é realmente um comprovante de pagamento (Pix, TED, cartão, recibo bancário).',
  'Se for exame médico, receita, foto pessoal, figurinha, boleto em aberto (sem quitação) ou documento não legível, retorne ehComprovante=false.',
  'Responda APENAS com um JSON válido com os campos:',
  '{"ehComprovante":boolean,"confianca":"alta"|"media"|"baixa","valorCentavos":number|null,"dataPagamento":"YYYY-MM-DD"|null,"nomePagador":string|null,"cpfPagador":string|null,"meioPagamento":"pix"|"ted"|"cartao"|"boleto"|"dinheiro"|"outro"|null,"identificadorTransacao":string|null,"resumoCurto":string|null}',
  'Regras: valorCentavos em centavos inteiros (R$ 350,00 -> 35000). nomePagador é quem PAGOU (origem/pagador, nunca o médico/clínica recebedora). cpfPagador apenas se os 11 dígitos completos aparecerem visíveis (se estiver mascarado com asteriscos ***, retorne null). identificadorTransacao é o ID E2E do Pix ou código de autenticação se visível.'
].join('\n');

function normalizarResultado(bruto: unknown): DadosComprovanteExtraido | null {
  const parsed = comprovanteSchema.safeParse(bruto);
  if (!parsed.success) return null;
  const d = parsed.data;
  const cpfLimpo = d.cpfPagador ? d.cpfPagador.replace(/\D/g, '') : '';
  const cpfValido = cpfLimpo.length === 11 && validarCpf(cpfLimpo) ? cpfLimpo : null;
  const valorOk = typeof d.valorCentavos === 'number' && d.valorCentavos > 0 ? d.valorCentavos : null;
  return {
    ehComprovante: d.ehComprovante && valorOk !== null,
    confianca: d.confianca,
    valorCentavos: valorOk,
    dataPagamento: d.dataPagamento ?? null,
    nomePagador: d.nomePagador ?? null,
    cpfPagador: cpfValido,
    meioPagamento: d.meioPagamento ?? null,
    identificadorTransacao: d.identificadorTransacao ?? null,
    resumoCurto: d.resumoCurto ?? null
  };
}

export function criarLeitorComprovanteOpenAi(
  apiKey: string,
  modelo = 'gpt-4.1-mini'
): PortaLerComprovante {
  const client = new OpenAI({ apiKey, maxRetries: 1, timeout: 20_000 });

  return {
    async ler(midia: MidiaBaixada) {
      const tipo = classificarMimetypeMidia(midia.mimetype);
      if (tipo !== 'imagem' && tipo !== 'pdf') {
        return { ok: false, motivo: 'TIPO_NAO_COMPROVANTE' };
      }

      try {
        let textoSaida = '';
        if (tipo === 'pdf') {
          const textoPdf = await extrairTextoPdf(midia.buffer);
          if (textoPdf.length >= 25) {
            const resp = await client.chat.completions.create({
              model: modelo,
              temperature: 0,
              response_format: { type: 'json_object' },
              messages: [
                { role: 'system', content: PROMPT_EXTRATOR_COMPROVANTE },
                { role: 'user', content: `Texto extraído do PDF:\n${textoPdf}` }
              ]
            });
            textoSaida = resp.choices[0]?.message?.content ?? '';
          } else {
            // PDF escaneado sem camada de texto: envia como arquivo PDF via Responses API.
            const resp = await client.responses.create({
              model: modelo,
              input: [
                {
                  role: 'user',
                  content: [
                    { type: 'input_text', text: PROMPT_EXTRATOR_COMPROVANTE },
                    {
                      type: 'input_file',
                      filename: midia.nomeArquivo || 'comprovante.pdf',
                      file_data: `data:application/pdf;base64,${midia.buffer.toString('base64')}`
                    }
                  ]
                }
              ]
            });
            textoSaida = resp.output_text ?? '';
          }
        } else {
          const mimeLimpo = midia.mimetype.split(';')[0]?.trim() || 'image/jpeg';
          const resp = await client.chat.completions.create({
            model: modelo,
            temperature: 0,
            response_format: { type: 'json_object' },
            messages: [
              { role: 'system', content: PROMPT_EXTRATOR_COMPROVANTE },
              {
                role: 'user',
                content: [
                  { type: 'text', text: 'Analise esta imagem e devolva apenas o JSON especificado.' },
                  { type: 'image_url', image_url: { url: `data:${mimeLimpo};base64,${midia.buffer.toString('base64')}` } }
                ]
              }
            ]
          });
          textoSaida = resp.choices[0]?.message?.content ?? '';
        }

        const limpo = textoSaida.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
        const dados = normalizarResultado(JSON.parse(limpo));
        if (!dados) return { ok: false, motivo: 'FORMATO_COMPROVANTE_INVALIDO' };
        return { ok: true, dados };
      } catch {
        return { ok: false, motivo: 'LEITURA_COMPROVANTE_INDISPONIVEL' };
      }
    }
  };
}
