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
  implements EnviarOtpWhatsapp, EnviarMensagemPaciente, EnviarPdfDanfse, LeitorMensagemWhatsApp
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


  /** Indicador visual, nunca confirmação de ação. Falha de presença não impede atendimento. */
  async enviarPresenca(instanciaNome: string, telefone: string, presenca: 'composing' | 'paused'): Promise<boolean> {
    if (!this.destinoDoAssistenteValido(instanciaNome, telefone)) return false;
    try {
      const resposta = await fetch(
        this.baseUrl.replace(/\/$/, '') + '/chat/sendPresence/' + encodeURIComponent(instanciaNome), {
          method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3000),
          headers: { 'Content-Type': 'application/json', apikey: this.apiKey },
          body: JSON.stringify({ number: telefone.replace(/\D/g, ''), presence: presenca, delay: presenca === 'composing' ? 1800 : 0 })
        });
      await resposta.body?.cancel().catch(() => {});
      return resposta.ok;
    } catch { return false; }
  }

  /** Reage somente ao ID real da mensagem recebida. */
  async reagirMensagem(instanciaNome: string, chave: { id: string; remoteJid: string; fromMe: boolean }, emoji: string): Promise<boolean> {
    if (!chave || chave.fromMe || !/^[A-Za-z0-9_-]{5,150}$/.test(chave.id) ||
        !/^\d{10,13}@s\.whatsapp\.net$/.test(chave.remoteJid) ||
        !this.destinoDoAssistenteValido(instanciaNome, chave.remoteJid.split('@')[0] ?? '') ||
        !['👍', '❤️', '🔎', '👀', '✅'].includes(emoji)) return false;
    try {
      const url = this.baseUrl.replace(/\/$/, '') + '/message/sendReaction/' + encodeURIComponent(instanciaNome);
      const key = { id: chave.id, remoteJid: chave.remoteJid, fromMe: false };
      const postar = (corpo: object) => fetch(url, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(3000),
        headers: { 'Content-Type': 'application/json', apikey: this.apiKey },
        body: JSON.stringify(corpo)
      });
      let resposta = await postar({ key, reaction: emoji });
      const formatoAlternativo = resposta.status === 400 || resposta.status === 422;
      await resposta.body?.cancel().catch(() => {});
      if (formatoAlternativo) {
        // Duas variantes publicadas da Evolution; só tenta outra se a primeira foi rejeitada.
        resposta = await postar({ reactionKey: key, reactionMessage: emoji });
        await resposta.body?.cancel().catch(() => {});
      }
      return resposta.ok;
    } catch { return false; }
  }

  private destinoDoAssistenteValido(instancia: string, telefone: string): boolean {
    return !!instancia && instancia !== (this.instanciaSomenteOtp || this.instanciaOficialNome) &&
      /^\d{10,13}$/.test(telefone.replace(/\D/g, ''));
  }

  /** Mídia recebida é sensível: baixar com limite estrito, sem gravar ou logar. */
  async obterBase64MensagemMidia(
    instancia: string,
    mensagemId: string
  ): Promise<{ base64?: string; mimetype?: string } | null> {
    if(!/^medico_[a-f0-9]{12}$/i.test(instancia) ||
      !/^[A-Za-z0-9_-]{5,150}$/.test(mensagemId))return null;
    const url = `${this.baseUrl.replace(/\/$/, '')}/chat/getBase64FromMediaMessage/${encodeURIComponent(instancia)}`;
    const MAX_JSON_BYTES=4_200_000;
    try {
      const resp = await fetch(url, {
        method: 'POST',redirect:'error',
        headers: {'Content-Type': 'application/json',apikey:this.apiKey},
        body: JSON.stringify({message:{key:{id:mensagemId}},convertToMp4:false}),
        signal: AbortSignal.timeout(15_000)
      });
      const informado=Number(resp.headers.get('content-length')??'0');
      if(!resp.ok || !resp.body || informado>MAX_JSON_BYTES){
        await resp.body?.cancel().catch(()=>{});
        return null;
      }
      const partes:Buffer[]=[];
      let bytes=0;
      const leitor=resp.body.getReader();
      try{
        while(true){
          const r=await leitor.read();
          if(r.done)break;
          bytes+=r.value.byteLength;
          if(bytes>MAX_JSON_BYTES)return null;
          partes.push(Buffer.from(r.value));
        }
      }finally{await leitor.cancel().catch(()=>{});}
      const envelope=JSON.parse(Buffer.concat(partes,bytes).toString('utf8'));
      const dados=envelope?.data?.base64 ? envelope.data : envelope;
      let base64=typeof dados?.base64==='string'?dados.base64:'';
      let mimetype=typeof dados?.mimetype==='string'?dados.mimetype:undefined;
      const prefixo=/^data:(image\\/(?:jpeg|png)|application\\/pdf);base64,/i.exec(base64);
      if(prefixo){
        mimetype=mimetype??prefixo[1]!.toLowerCase();
        base64=base64.slice(prefixo[0].length);
      }
      return base64 ? {base64,...(mimetype?{mimetype}:{})} : null;
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
    return this.enviarTextoGenerico(params.instanciaNome, params.contatoTelefone, params.texto, params.linkPreview);
  }

  async enviarPdf(params: EnviarPdfDanfseParams): Promise<ResultadoEnvioPdf> {
    return this.enviarDocumento(params, 'application/pdf');
  }

  async enviarDocumento(params: EnviarPdfDanfseParams, mimetype: 'application/pdf'|'application/xml'): Promise<ResultadoEnvioPdf> {
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
          mimetype,
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
    texto: string,
    linkPreview?: boolean
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
          text: texto,
          ...(linkPreview === undefined ? {} : { linkPreview })
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

  private normalizarTelefone(telefone: string): string {
    const telLimpo = telefone.replace(/\D/g, '');
    return telLimpo.length === 10 || telLimpo.length === 11 ? `55${telLimpo}` : telLimpo;
  }
}
