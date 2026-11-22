/**
 * Resolve uma mensagem de mídia (áudio, imagem ou PDF) recebida no webhook do
 * agente: baixa o arquivo pela porta de mídia, transcreve áudio ou extrai dados
 * de comprovante de pagamento e aciona o processador de comprovante quando aplicável.
 */

import type { ChaveMensagemRecebida } from '../agente/webhook.js';
import type { TipoMidiaMensagem } from '../agente/baloes.js';
import {
  decodificarBase64Midia,
  type DadosComprovanteExtraido,
  type MidiaBaixada
} from './midia-tipos.js';

export interface ResolverMidiaDeps {
  baixarMidia?: (instancia: string, mensagemId: string) => Promise<{ base64?: string; mimetype?: string } | null>;
  transcreverAudio?: (midia: MidiaBaixada) => Promise<{ ok: true; texto: string } | { ok: false; motivo: string }>;
  lerComprovante?: (midia: MidiaBaixada) => Promise<{ ok: true; dados: DadosComprovanteExtraido } | { ok: false; motivo: string }>;
  processarComprovanteMedico?: (entrada: {
    contaId: string;
    comprovante: DadosComprovanteExtraido;
    mensagemId: string;
    chaveMensagem: ChaveMensagemRecebida;
  }) => Promise<Record<string, unknown>>;
}

export interface ResultadoResolucaoMidia {
  textoEfetivo: string;
  comprovanteRecebidoNoTurno?: Record<string, unknown>;
  respostaDiretaErro?: string;
}

export async function resolverMidiaMensagemAgente(entrada: {
  instancia: string;
  contaId: string | null;
  chaveMensagem: ChaveMensagemRecebida;
  tipoMidia: TipoMidiaMensagem;
  textoOriginal: string;
  mimetypeHint?: string;
  nomeArquivo?: string;
}, deps: ResolverMidiaDeps): Promise<ResultadoResolucaoMidia> {
  const { tipoMidia, textoOriginal } = entrada;
  if (tipoMidia === 'texto' || !deps.baixarMidia) {
    return { textoEfetivo: textoOriginal };
  }

  if (tipoMidia === 'audio') {
    if (!deps.transcreverAudio) return { textoEfetivo: textoOriginal };
    const bruto = await deps.baixarMidia(entrada.instancia, entrada.chaveMensagem.id).catch(() => null);
    const dec = decodificarBase64Midia(bruto?.base64, bruto?.mimetype || entrada.mimetypeHint || 'audio/ogg');
    if (!dec.ok || dec.tipo !== 'audio') {
      return {
        textoEfetivo: '',
        respostaDiretaErro: 'Não consegui baixar esse áudio agora. Pode mandar por texto ou gravar de novo?'
      };
    }
    const trans = await deps.transcreverAudio(dec.midia).catch(() => ({ ok: false as const, motivo: 'ERRO' }));
    if (!trans.ok || !trans.texto.trim()) {
      return {
        textoEfetivo: '',
        respostaDiretaErro: 'Não consegui entender esse áudio direitinho. Pode me mandar por texto ou gravar novamente?'
      };
    }
    return { textoEfetivo: trans.texto.trim() };
  }

  if ((tipoMidia === 'imagem' || tipoMidia === 'documento') && deps.lerComprovante) {
    const bruto = await deps.baixarMidia(entrada.instancia, entrada.chaveMensagem.id).catch(() => null);
    const dec = decodificarBase64Midia(
      bruto?.base64,
      bruto?.mimetype || entrada.mimetypeHint || (tipoMidia === 'imagem' ? 'image/jpeg' : 'application/pdf')
    );
    if (!dec.ok || (dec.tipo !== 'imagem' && dec.tipo !== 'pdf')) {
      return { textoEfetivo: textoOriginal };
    }
    if (entrada.nomeArquivo) dec.midia.nomeArquivo = entrada.nomeArquivo;

    const leitura = await deps.lerComprovante(dec.midia).catch(() => ({ ok: false as const, motivo: 'ERRO' }));
    if (leitura.ok && leitura.dados.ehComprovante) {
      const resultadoCaso = entrada.contaId && deps.processarComprovanteMedico
        ? await deps.processarComprovanteMedico({
            contaId: entrada.contaId,
            comprovante: leitura.dados,
            mensagemId: entrada.chaveMensagem.id,
            chaveMensagem: entrada.chaveMensagem
          }).catch(() => undefined)
        : undefined;
      return {
        textoEfetivo: textoOriginal.trim() || '[Comprovante de pagamento enviado pelo médico]',
        comprovanteRecebidoNoTurno: {
          ehComprovante: true,
          valorCentavos: leitura.dados.valorCentavos,
          dataPagamento: leitura.dados.dataPagamento,
          nomePagador: leitura.dados.nomePagador,
          meioPagamento: leitura.dados.meioPagamento,
          possuiCpfNoComprovante: Boolean(leitura.dados.cpfPagador),
          ...(resultadoCaso ? { resultadoProcessamento: resultadoCaso } : {})
        }
      };
    }

    return {
      textoEfetivo: textoOriginal.trim() || '[Arquivo enviado pelo médico sem texto]',
      comprovanteRecebidoNoTurno: {
        ehComprovante: false,
        resumoCurto: leitura.ok ? (leitura.dados.resumoCurto ?? null) : null
      }
    };
  }

  return { textoEfetivo: textoOriginal };
}
