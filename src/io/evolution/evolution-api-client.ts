import type { TransporteReacao } from '../../whatsapp/reagir-mensagem.js';
import type { TransporteDigitacao, ParametrosDigitacao, SessaoDigitacao } from '../../whatsapp/indicar-digitacao.js';
import type { LeitorMensagemWhatsApp, ParamsLeitura } from '../../whatsapp/marcar-mensagem-lida.js';
/**
 * Cliente HTTP para a Evolution API na VPS Hostinger (Easypanel).
 * Implementa envio de mensagens de texto e envio de DANFSe (PDF) via WhatsApp
 * para as portas `EnviarOtpWhatsapp`, `EnviarMensagemPaciente` e `EnviarPdfDanfse`.
 */

import type {
  EnviarOtpWhatsapp,
  EnviarOtpParams,
  ResultadoEnvioOtp
} from '../../otp/enviar-otp-whatsapp.js';
import { formatarMensagemOtp } from '../../otp/enviar-otp-whatsapp.js';
import type {
  EnviarMensagemPaciente,
  EnviarMensagemPacienteParams,
  ResultadoEnvioMensagemPaciente
} from '../../whatsapp/enviar-mensagem-paciente.js';
import type {
  EnviarPdfDanfse,
  EnviarPdfDanfseParams,
  ResultadoEnvioPdf
} from '../../whatsapp/enviar-pdf-danfse.js';

export class EvolutionApiClient
  implements EnviarOtpWhatsapp, EnviarMensagemPaciente, EnviarPdfDanfse, LeitorMensagemWhatsApp, TransporteDigitacao
{
  constructor(
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly instanciaOficialNome: string,
    private readonly instanciaSomenteOtp?: string
  ) {}

  async marcarLida(params: ParamsLeitura): Promise<{ sucesso: boolean; erro?: string }> {
    const chave = params.chaveMensagem;
    if (params.instanciaNome === (this.instanciaSomenteOtp || this.instanciaOficialNome) || !chave || chave.fromMe ||
        !params.instanciaNome || !chave.id || chave.id !== params.mensagemId || !/^\d+@(s\.whatsapp\.net|lid)$/.test(chave.remoteJid))
      return { sucesso: false, erro: 'LEITURA_NAO_PERMITIDA' };
    try {
      const resp = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/markMessageAsRead/${encodeURIComponent(params.instanciaNome)}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3000),
        headers: { 'Content-Type': 'application/json', apikey: this.apiKey },
        body: JSON.stringify({ readMessages: [{ id: chave.id, remoteJid: chave.remoteJid, fromMe: false }] })
      });
      await resp.body?.cancel().catch(() => {});
      return resp.ok ? { sucesso: true } : { sucesso: false, erro: `EVOLUTION_HTTP_${resp.status}` };
    } catch { return { sucesso: false, erro: 'EVOLUTION_LEITURA_INDISPONIVEL' }; }
  }

  async enviarReacao(params: Parameters<TransporteReacao['enviarReacao']>[0]): Promise<{ sucesso: boolean }> {
    const { chave, instanciaNome, reacao } = params;
    if (instanciaNome === (this.instanciaSomenteOtp || this.instanciaOficialNome) || !instanciaNome || !chave.id || chave.fromMe || !/^\d+@(s\.whatsapp\.net|lid)$/.test(chave.remoteJid)) return { sucesso: false };
    try {
      const r = await fetch(`${this.baseUrl.replace(/\/$/, '')}/message/sendReaction/${encodeURIComponent(instanciaNome)}`, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3000),
        headers: { 'Content-Type': 'application/json', apikey: this.apiKey },
        body: JSON.stringify({ key: { id: chave.id, remoteJid: chave.remoteJid, fromMe: false }, reaction: reacao })
      });
      await r.body?.cancel().catch(() => {});
      return { sucesso: r.ok };
    } catch { return { sucesso: false }; }
  }

  async iniciarDigitacao(params: ParametrosDigitacao): Promise<SessaoDigitacao | null> {
    if (!params.instanciaNome || !params.contatoTelefone || params.instanciaNome === this.instanciaSomenteOtp) return null;
    const destino = this.normalizarDestinoPresenca(params.contatoTelefone);
    if (!destino) return null;

    let ativo = true;
    const ciclo = async () => {
      while (ativo) {
        const sucesso = await this.enviarPresenca(params.instanciaNome, destino, 'composing', 20_000);
        if (!sucesso || !ativo) break;
      }
    };
    void ciclo().catch(() => {});

    let encerrada = false;
    return {
      parar: async () => {
        if (encerrada) return;
        encerrada = true;
        ativo = false;
        await this.enviarPresenca(params.instanciaNome, destino, 'paused', 1);
      }
    };
  }

  /** Consulta somente a identidade da própria instância assistente para o botão de retorno. */
  async obterTelefoneInstancia(): Promise<string | null> {
    try {
      const r = await fetch(`${this.baseUrl.replace(/\/$/, '')}/instance/fetchInstances?instanceName=${encodeURIComponent(this.instanciaOficialNome)}`, {
        headers: { apikey: this.apiKey }, redirect: 'error', signal: AbortSignal.timeout(3000)
      });
      if (!r.ok) { await r.body?.cancel().catch(() => {}); return null; }
      const dados = await r.json() as unknown;
      if (!Array.isArray(dados)) return null;
      for (const item of dados) {
        const i = item?.instance ?? item;
        if ((i?.name ?? i?.instanceName) !== this.instanciaOficialNome) continue;
        const jid = i?.ownerJid;
        if (typeof jid === 'string' && /^\d{10,15}@s\.whatsapp\.net$/.test(jid)) return jid.split('@')[0];
      }
      return null;
    } catch { return null; }
  }

  async obterBase64MensagemMidia(
    instancia: string,
    mensagemId: string
  ): Promise<{ base64?: string; mimetype?: string } | null> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/chat/getBase64FromMediaMessage/${encodeURIComponent(instancia)}`;
    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: this.apiKey
        },
        body: JSON.stringify({
          message: {
            key: {
              id: mensagemId
            }
          },
          convertToMp4: false
        }),
        signal: AbortSignal.timeout(15_000)
      });
      if (!resp.ok) return null;
      const dados = (await resp.json()) as any;
      return {
        base64: dados.base64,
        mimetype: dados.mimetype
      };
    } catch {
      return null;
    }
  }

  async enviar(params: EnviarOtpParams): Promise<ResultadoEnvioOtp> {
    const texto = formatarMensagemOtp(params.codigo);
    const resultadoBotao = await this.enviarOtpComBotao(params.telefone, params.codigo, texto);
    if (resultadoBotao.sucesso) {
      return resultadoBotao;
    }

    console.warn(`[Evolution] OTP interativo indisponível: ${resultadoBotao.erro}`);
    return this.enviarTextoGenerico(this.instanciaOficialNome, params.telefone, texto);
  }

  async enviarTexto(params: EnviarMensagemPacienteParams): Promise<ResultadoEnvioMensagemPaciente> {
    if(params.instanciaNome===this.instanciaSomenteOtp)return {sucesso:false,erro:'CANAL_OFICIAL_SOMENTE_OTP'};
    return this.enviarTextoGenerico(params.instanciaNome, params.contatoTelefone, params.texto);
  }

  async enviarPdf(params: EnviarPdfDanfseParams): Promise<ResultadoEnvioPdf> {
    if(params.instanciaNome===this.instanciaSomenteOtp)return {sucesso:false,erro:'CANAL_OFICIAL_SOMENTE_OTP'};
    const url = `${this.baseUrl.replace(/\/$/, '')}/message/sendMedia/${params.instanciaNome}`;
    try {
      const telLimpo = params.contatoTelefone.replace(/\D/g, '');
      const telNormalizado =
        telLimpo.length === 10 || telLimpo.length === 11 ? `55${telLimpo}` : telLimpo;

      let mediaPayload = params.pdfPathOuUrl;
      if (mediaPayload.startsWith('data:')) {
        const idx = mediaPayload.indexOf('base64,');
        if (idx !== -1) {
          mediaPayload = mediaPayload.slice(idx + 7);
        }
      }

      const resp = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(60_000),
        headers: {
          'Content-Type': 'application/json',
          apikey: this.apiKey
        },
        body: JSON.stringify({
          number: telNormalizado,
          mediatype: 'document',
          mimetype: 'application/pdf',
          media: mediaPayload,
          fileName: params.nomeArquivo,
          caption: params.legenda || 'Segue sua Nota Fiscal de Serviços (NFS-e).'
        })
      });


      if (!resp.ok) {
        const txt = await resp.text();
        return { sucesso: false, erro: `HTTP ${resp.status}: ${txt}` };
      }

      const json: any = await resp.json();
      return { sucesso: true, mensagemId: json?.key?.id };
    } catch (err: any) {
      return { sucesso: false, erro: err.message || 'Erro de conexão com Evolution API' };
    }
  }

  private async enviarOtpComBotao(
    telefone: string,
    codigo: string,
    textoFallback: string
  ): Promise<ResultadoEnvioOtp> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/message/sendButtons/${this.instanciaOficialNome}`;
    try {
      const resp = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
        headers: {
          'Content-Type': 'application/json',
          apikey: this.apiKey
        },
        body: JSON.stringify({
          number: this.normalizarTelefone(telefone),
          // Enviar vazio evita que versões da Evolution exibam campos ausentes como "undefined".
          title: '',
          description: textoFallback,
          footer: '',
          buttons: [{
            type: 'copy',
            displayText: 'Copiar código',
            copyCode: codigo
          }]
        })
      });

      if (!resp.ok) {
        const txt = await resp.text();
        return { sucesso: false, erro: `HTTP ${resp.status}: ${txt}` };
      }
      return { sucesso: true };
    } catch (err: any) {
      return { sucesso: false, erro: err.message || 'Erro de conexão com Evolution API' };
    }
  }

  private async enviarTextoGenerico(
    instancia: string,
    telefone: string,
    texto: string
  ): Promise<ResultadoEnvioMensagemPaciente> {
    const url = `${this.baseUrl.replace(/\/$/, '')}/message/sendText/${instancia}`;
    try {
      const resp = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
        headers: {
          'Content-Type': 'application/json',
          apikey: this.apiKey
        },
        body: JSON.stringify({
          number: this.normalizarTelefone(telefone),
          text: texto
        })
      });

      if (!resp.ok) {
        const txt = await resp.text();
        return { sucesso: false, erro: `HTTP ${resp.status}: ${txt}` };
      }

      const json: any = await resp.json();
      return { sucesso: true, mensagemId: json?.key?.id };
    } catch (err: any) {
      return { sucesso: false, erro: err.message || 'Erro de conexão com Evolution API' };
    }
  }

  private async enviarPresenca(
    instancia: string,
    destino: string,
    presence: 'composing' | 'paused',
    delay: number
  ): Promise<boolean> {
    try {
      const resp = await fetch(`${this.baseUrl.replace(/\/$/, '')}/chat/sendPresence/${encodeURIComponent(instancia)}`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(25_000),
        headers: {
          'Content-Type': 'application/json',
          apikey: this.apiKey
        },
        body: JSON.stringify({ number: destino, presence, delay })
      });
      await resp.body?.cancel().catch(() => {});
      return resp.ok;
    } catch {
      return false;
    }
  }

  private normalizarDestinoPresenca(contato: string): string | null {
    const destino = contato.trim();
    if (/^\d+@lid$/.test(destino)) return destino;
    if (/^\d+@s\.whatsapp\.net$/.test(destino)) return destino.split('@')[0] || null;
    const normalizado = this.normalizarTelefone(destino);
    return /^\d{10,15}$/.test(normalizado) ? normalizado : null;
  }

  private normalizarTelefone(telefone: string): string {
    const telLimpo = telefone.replace(/\D/g, '');
    return telLimpo.length === 10 || telLimpo.length === 11 ? `55${telLimpo}` : telLimpo;
  }
}
