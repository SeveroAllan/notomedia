import { registroErroNoto } from '../observabilidade/erros.js';
import type { LeitorMensagemWhatsApp, ChaveMensagemLeitura } from './marcar-mensagem-lida.js';
import { traduzirFalhaEmissao } from '../worker/notificar-erro-medico.js';
import { montarBoasVindas } from '../onboarding/regras/decidir-proxima-acao.js';
import { createHmac } from 'node:crypto';
import type pg from 'pg';
import type { AppConfig } from '../config.js';
import type { EnviarPdfDanfse } from './enviar-pdf-danfse.js';
import type { EnviarMensagemPaciente } from './enviar-mensagem-paciente.js';
import { gerarVariantesTelefoneBrasileiro } from './variantes-telefone-brasileiro.js';

type AcaoMedico = 'perguntar_medico' | 'perguntar_pacote' | 'pedir_agenda' | 'falha_emissao' | 'nota_gerada' | 'instancia_indisponivel' | 'falha_entrega';
const textos: Record<AcaoMedico, string> = {
  perguntar_medico: 'Doutor(a), preciso que confira este comprovante e me oriente antes de emitir a nota.',
  perguntar_pacote: 'Doutor(a), o valor do comprovante corresponde a mais de uma consulta. É um pacote? Preciso da sua confirmação antes de emitir.',
  pedir_agenda: 'Doutor(a), preciso de acesso à sua agenda para conferir a consulta deste comprovante. Pode me orientar?',
  falha_emissao: traduzirFalhaEmissao(undefined),
  nota_gerada: 'Doutor(a), a nota de teste foi autorizada em homologação e não tem valor fiscal.',
  instancia_indisponivel: 'Doutor(a), a nota foi gerada, mas não consegui entregá-la. Confira se seu WhatsApp próprio está conectado e me oriente.',
  falha_entrega: 'Doutor(a), a nota foi gerada, mas houve uma falha ao preparar ou entregar o documento. Pode conferir? A nota será preservada sem nova emissão.'
};
const duvidas: Record<string, string> = {
  LEITURA_INDISPONIVEL: 'Não consegui ler o comprovante. Pode conferir e me orientar?',
  COMPROVANTE_ILEGIVEL: 'O comprovante está ilegível. Pode enviar uma imagem mais nítida?',
  NAO_COMPROVANTE: 'O arquivo recebido não foi reconhecido como comprovante. Pode conferir?',
  NOTA_FASE_INICIAL: 'Recebi um PDF de nota fiscal. Pode confirmar se ela já cobre a consulta correspondente?',
  CAMPO_OBRIGATORIO_AUSENTE: 'Faltam dados obrigatórios no comprovante. Pode conferir?',
  CONFIANCA_INSUFICIENTE: 'Não consegui ler todos os dados do comprovante com segurança. Pode conferir?',
  CADASTRO_INCOMPLETO: 'Faltam dados do paciente ou da consulta para emitir a nota. Pode conferir?',
  VALOR_DIVERGENTE: 'O valor do comprovante é diferente do valor da consulta. Pode conferir antes de emitir?',
  PDF_NAO_SUPORTADO: 'Não consigo ler este comprovante em PDF. Pode enviar uma imagem?',
  FONTE_INDISPONIVEL: 'Não consegui consultar sua agenda agora. Pode conferir o acesso e me orientar?',
  ACESSO_EXPIRADO: 'O acesso à sua agenda expirou. Pode reconectar para eu conferir a consulta?',
  VINCULO_TELEFONE_INDEFINIDO: 'Não consegui identificar um único paciente na agenda pelo telefone que enviou o comprovante. Pode confirmar quem é?',
  CONSULTA_AMBIGUA_OU_AUSENTE: 'Não encontrei uma única última consulta realizada sem nota para este telefone. Pode confirmar a consulta?',
  CONSULTA_APOS_PAGAMENTO: 'Recebi um comprovante, mas não encontrei nenhuma consulta realizada deste paciente até a data do pagamento. Pode conferir se a consulta aconteceu e está na agenda?',
  MULTIPLAS_CONSULTAS_SEM_NOTA: 'Encontrei mais de uma consulta realizada sem nota para este comprovante. Pode confirmar de qual consulta é?',
  COMPROVANTE_SEM_AUDITORIA_PRONTA: 'Não encontrei a conferência deste comprovante. Pode revisar antes de emitir?',
  CADASTRO_OU_CONSULTA_DIVERGENTE: 'Os dados mudaram depois da conferência do comprovante. Pode revisar?',
  PEDIDO_DIVERGENTE: 'O pedido está diferente da conferência do comprovante. Pode revisar?',
  EMISSAO_COMPROVANTE_BLOQUEADA: 'Este comprovante já tem uma emissão bloqueada ou com erro. Pode revisar como prosseguir?',
  AMBIENTE_NAO_HOMOLOGACAO: 'A emissão de teste exige ambiente de homologação. Pode conferir a configuração?',
  PERFIL_FISCAL_INCOMPLETO: 'Faltam dados fiscais para emitir a nota de teste. Pode conferir?',
  ENFILEIRAMENTO_COMPROVANTE_FALHOU: 'Não consegui registrar o pedido de emissão. Pode revisar antes de prosseguir?'
};

function montarPerguntaMultiplasConsultas(detalhe: { pacienteNome: string | null; valorCentavos: number | null; consultas: { dataHora: string }[] }): string {
  const nome = detalhe.pacienteNome?.trim() || 'o paciente';
  const valor = Number.isSafeInteger(detalhe.valorCentavos) ? `R$ ${((detalhe.valorCentavos as number) / 100).toFixed(2).replace('.', ',')}` : 'valor não identificado';
  const datas = detalhe.consultas.map(c => {
    const d = new Date(c.dataHora);
    return Number.isFinite(d.getTime()) ? d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : c.dataHora;
  });
  return `Doutor(a), ${nome} enviou um comprovante de ${valor}. Encontrei ${detalhe.consultas.length} consultas realizadas sem nota até a data do pagamento (${datas.join(', ')}). Quer que eu emita para a consulta mais recente (${datas[0]}) ou para uma das anteriores?`;
}

function montarAvisoNotaFaseInicial(nota: { numeroNota: string | null; dataEmissao: string | null; valorCentavos: number | null; nomeTomador: string | null }): string {
  const partes = [
    nota.numeroNota ? `nº ${nota.numeroNota}` : null,
    Number.isSafeInteger(nota.valorCentavos) ? `R$ ${((nota.valorCentavos as number) / 100).toFixed(2).replace('.', ',')}` : null,
    nota.dataEmissao ? `emissão ${nota.dataEmissao.split('-').reverse().join('/')}` : null,
    nota.nomeTomador ? `tomador ${nota.nomeTomador}` : null
  ].filter(Boolean).join(', ');
  return `Doutor(a), recebi um PDF de nota fiscal${partes ? ` (${partes})` : ''}. Como está na fase inicial, vou considerar que essa nota já foi emitida fora do Noto e não vou emitir outra para a consulta correspondente. Se não for isso, me avise?`;
}

export class ComunicacaoHomologacao {
  constructor(private readonly pool: pg.Pool, private readonly config: AppConfig,
    private readonly transporte: EnviarMensagemPaciente & Partial<LeitorMensagemWhatsApp>, private readonly log: (texto: string) => void = console.info) {}

  async medico(entrada: { medicoId: string; acao: AcaoMedico; chave: string; motivo?: string;
    detalhe?: { pacienteNome: string | null; valorCentavos: number | null; consultas: { dataHora: string }[] };
    detalheNota?: { numeroNota: string | null; dataEmissao: string | null; valorCentavos: number | null; nomeTomador: string | null } }): Promise<'simulado' | 'enviado' | 'erro' | 'repetido'> {
    const { medicoId, acao, chave, motivo, detalhe, detalheNota } = entrada;
    if (!this.config.envioMedicoRealAtivo) return this.simular(acao);
    try {
      const { rows } = await this.pool.query(`select u.telefone, pf.ambiente from medicos m
        join usuarios u on u.id = m.usuario_id left join medico_perfil_fiscal pf on pf.medico_id = m.id where m.id = $1`, [medicoId]);
      const destino = rows[0];
      if (!this.permitido(this.config.envioMedicoRealAtivo, destino?.ambiente, destino?.telefone)) return this.simular(acao);
      const texto = acao === 'falha_emissao' ? traduzirFalhaEmissao(motivo) : acao === 'falha_entrega' ? traduzirFalhaEmissao('FALHA_ENTREGA_PDF') : acao === 'instancia_indisponivel' ? traduzirFalhaEmissao('INSTANCIA_INDISPONIVEL') : acao === 'perguntar_medico' && motivo === 'MULTIPLAS_CONSULTAS_SEM_NOTA' && detalhe
        ? montarPerguntaMultiplasConsultas(detalhe)
        : acao === 'perguntar_medico' && motivo === 'NOTA_FASE_INICIAL' && detalheNota
          ? montarAvisoNotaFaseInicial(detalheNota)
          : acao === 'perguntar_medico' && motivo && Object.hasOwn(duvidas, motivo) ? `Doutor(a), ${duvidas[motivo]}` : textos[acao];
      return await this.enviarUnico(medicoId, acao, chave, async () => (await this.transporte.enviarTexto({
        instanciaNome: this.config.evolutionAssistantInstanceName, contatoTelefone: destino.telefone, texto
      })).sucesso);
    } catch { this.log('COMUNICACAO_HOMOLOGACAO_FALHOU'); return 'erro'; }
  }

  async medicoPermitido(medicoId: string): Promise<boolean> {
    if (!this.config.envioMedicoRealAtivo) return false;
    const { rows } = await this.pool.query(`select u.telefone, pf.ambiente from medicos m
      join usuarios u on u.id = m.usuario_id left join medico_perfil_fiscal pf on pf.medico_id = m.id where m.id = $1`, [medicoId]);
    return this.permitido(this.config.envioMedicoRealAtivo, rows[0]?.ambiente, rows[0]?.telefone);
  }

  async marcarLida(medicoId: string, chave: ChaveMensagemLeitura): Promise<'simulado' | 'enviado' | 'erro' | 'repetido'> {
    if (!this.config.conversaLivreAtiva || !this.config.envioMedicoRealAtivo) return this.simular('mensagem_lida');
    if (!chave.id || chave.fromMe || !/^\d+@(s\.whatsapp\.net|lid)$/.test(chave.remoteJid)) return 'erro';
    try {
      if (!await this.medicoPermitido(medicoId)) return this.simular('mensagem_lida');
      const resultado = await this.enviarUnico(medicoId, 'mensagem_lida', JSON.stringify([chave.remoteJid, chave.id]), async () =>
        (await this.transporte.marcarLida?.({ instanciaNome: this.config.evolutionAssistantInstanceName,
          mensagemId: chave.id, contatoTelefone: chave.remoteJid.split('@')[0], chaveMensagem: chave }))?.sucesso === true);
      if (resultado === 'erro') this.log(registroErroNoto('LEITURA_MENSAGEM_FALHOU', 'tecnico', { medicoId, etapa: 'leitura' }));
      return resultado;
    } catch { this.log(registroErroNoto('LEITURA_MENSAGEM_FALHOU', 'tecnico', { medicoId, etapa: 'leitura' })); return 'erro'; }
  }

  async confirmarEmissao(entrada: { medicoId: string; solicitacaoId: string; chaveDisparo?: string; paciente: string; dataEnvioPagamento: string; dataConsulta: string }):
    Promise<{ resultado: 'simulado' | 'enviado' | 'erro' | 'repetido'; chaveMensagem?: string }> {
    if (!this.config.envioMedicoRealAtivo) return { resultado: this.simular('confirmar_emissao') };
    try {
      const { rows } = await this.pool.query(`select u.telefone, pf.ambiente from medicos m
        join usuarios u on u.id = m.usuario_id left join medico_perfil_fiscal pf on pf.medico_id = m.id where m.id = $1`, [entrada.medicoId]);
      const destino = rows[0];
      if (!this.permitido(this.config.envioMedicoRealAtivo, destino?.ambiente, destino?.telefone)) return { resultado: this.simular('confirmar_emissao') };
      const envio = new Date(entrada.dataEnvioPagamento), consulta = new Date(entrada.dataConsulta);
      if (!Number.isFinite(envio.getTime()) || !Number.isFinite(consulta.getTime()) || !entrada.paciente.trim()) return { resultado: 'erro' };
      const data = (d: Date) => d.toLocaleDateString('pt-BR', { timeZone: 'America/Sao_Paulo' });
      const texto = `Pronto para emitir a nota do ${entrada.paciente.trim().slice(0, 100)}, que enviou o pagamento em ${data(envio)} da consulta de ${data(consulta)}. Posso emitir?`;
      let chaveMensagem: string | undefined;
      const resultado = await this.enviarUnico(entrada.medicoId, 'confirmar_emissao', entrada.chaveDisparo ?? entrada.solicitacaoId, async () => {
        const r = await this.transporte.enviarTexto({ instanciaNome: this.config.evolutionAssistantInstanceName, contatoTelefone: destino.telefone, texto });
        chaveMensagem = r.mensagemId;
        return r.sucesso && !!chaveMensagem;
      });
      return { resultado, ...(resultado === 'enviado' ? { chaveMensagem } : {}) };
    } catch { this.log('CONFIRMACAO_EMISSAO_ENVIO_FALHOU'); return { resultado: 'erro' }; }
  }

  async boasVindas(entrada: { medicoId: string; nomeMedico?: string; ultimaNota: Parameters<typeof montarBoasVindas>[1];
    aoEnviar?: (telefone: string, baloes: string[]) => Promise<void> }): Promise<'simulado' | 'enviado' | 'erro' | 'repetido'> {
    const { medicoId, nomeMedico, ultimaNota } = entrada;
    if (!nomeMedico?.trim()) return 'erro';
    if (!this.config.envioMedicoRealAtivo) return this.simular('boas_vindas');
    try {
      const { rows } = await this.pool.query(`select u.telefone, pf.ambiente from medicos m
        join usuarios u on u.id = m.usuario_id left join medico_perfil_fiscal pf on pf.medico_id = m.id where m.id = $1`, [medicoId]);
      const destino = rows[0];
      if (!this.permitido(this.config.envioMedicoRealAtivo, destino?.ambiente, destino?.telefone)) return this.simular('boas_vindas');
      const baloes = montarBoasVindas(nomeMedico, ultimaNota);
      const resultado = await this.enviarUnico(medicoId, 'boas_vindas', 'unica', async () => {
        for (const texto of baloes) {
          const envio = await this.transporte.enviarTexto({ instanciaNome: this.config.evolutionAssistantInstanceName,
            contatoTelefone: destino.telefone, texto });
          if (!envio.sucesso) return false;
        }
        return true;
      });
      if (resultado === 'enviado') await entrada.aoEnviar?.(destino.telefone, baloes);
      return resultado;
    } catch { this.log('COMUNICACAO_HOMOLOGACAO_FALHOU'); return 'erro'; }
  }

  async conversa(entrada: { medicoId: string; chave: string; fala: string[] }): Promise<'simulado' | 'enviado' | 'erro' | 'repetido'> {
    const { medicoId, chave, fala } = entrada;
    if (!fala.length || fala.length > 3 || fala.some(texto => !texto.trim() || texto.length > 500)) return 'erro';
    if (!this.config.envioMedicoRealAtivo) return this.simular('conversa_livre');
    try {
      const { rows } = await this.pool.query(`select u.telefone, pf.ambiente from medicos m
        join usuarios u on u.id = m.usuario_id left join medico_perfil_fiscal pf on pf.medico_id = m.id where m.id = $1`, [medicoId]);
      const destino = rows[0];
      if (!this.permitido(this.config.envioMedicoRealAtivo, destino?.ambiente, destino?.telefone)) return this.simular('conversa_livre');
      return await this.enviarUnico(medicoId, 'conversa_livre', chave, async () => {
        for (const texto of fala) {
          const resultado = await this.transporte.enviarTexto({ instanciaNome: this.config.evolutionAssistantInstanceName,
            contatoTelefone: destino.telefone, texto });
          if (!resultado.sucesso) return false;
        }
        return true;
      });
    } catch { this.log('COMUNICACAO_HOMOLOGACAO_FALHOU'); return 'erro'; }
  }

  async cofre(medicoId: string, texto: string): Promise<'simulado' | 'enviado' | 'erro'> {
    if (!this.config.envioMedicoRealAtivo) return this.simular('cofre');
    try {
      const destino = (await this.pool.query(`select u.telefone, pf.ambiente from medicos m
        join usuarios u on u.id=m.usuario_id left join medico_perfil_fiscal pf on pf.medico_id=m.id
        where m.id=$1 and u.ativo=true`, [medicoId])).rows[0];
      if (!this.permitido(this.config.envioMedicoRealAtivo, destino?.ambiente, destino?.telefone)) return this.simular('cofre');
      // Não gravar o texto: ele pode conter um link de uso único.
      const resultado = await this.transporte.enviarTexto({ instanciaNome: this.config.evolutionAssistantInstanceName,
        contatoTelefone: destino.telefone, texto });
      return resultado.sucesso ? 'enviado' : 'erro';
    } catch { this.log('COFRE_ENVIO_FALHOU'); return 'erro'; }
  }

  async paciente(entrada: { medicoId: string; solicitacaoId: string }, transporte: EnviarPdfDanfse): Promise<'simulado' | 'enviado' | 'erro' | 'repetido'> {
    if (!this.config.envioPacienteRealAtivo) return this.simular('nota_paciente');
    const { medicoId, solicitacaoId } = entrada;
    try {
      const { rows } = await this.pool.query(`select nf.id as nota_fiscal_id, nf.pdf_storage_path,
        p.telefone as contato_telefone, pf.ambiente, wi.nome_instancia,
        wi.medico_id as instancia_medico_id, wi.status as instancia_status
        from notas_fiscais nf join solicitacoes_nota sn on sn.id = nf.solicitacao_id
        join public.noto_emissoes_comprovantes ec on ec.nota_fiscal_id = nf.id and ec.estado = 'nota_gerada'
        join pacientes p on p.id = sn.paciente_id and p.medico_id = sn.medico_id
        join medico_perfil_fiscal pf on pf.medico_id = sn.medico_id
        left join lateral (select nome_instancia, medico_id, status from whatsapp_instancias
          where medico_id = sn.medico_id and oficial = false and status = 'conectado'
            and nome_instancia <> $3 and nome_instancia <> $4 order by criado_em desc limit 1) wi on true
        where sn.id = $1 and sn.medico_id = $2 and nf.medico_id = $2 and nf.status = 'autorizada'`,
        [solicitacaoId, medicoId, this.config.evolutionOfficialInstanceName, this.config.evolutionAssistantInstanceName]);
      const nota = rows[0];
      if (!nota || !this.permitido(this.config.envioPacienteRealAtivo, nota.ambiente, nota.contato_telefone)) return this.simular('nota_paciente');
      const propria = nota.nome_instancia && nota.instancia_medico_id === medicoId && nota.instancia_status === 'conectado' &&
        ![this.config.evolutionOfficialInstanceName, this.config.evolutionAssistantInstanceName].includes(nota.nome_instancia);
      if (!propria || !nota.pdf_storage_path) {
        await this.medico({ medicoId, acao: propria ? 'falha_entrega' : 'instancia_indisponivel', chave: nota.nota_fiscal_id });
        return 'erro';
      }
      const resultado = await this.enviarUnico(medicoId, 'nota_paciente', nota.nota_fiscal_id, async () => (await transporte.enviarPdf({
        instanciaNome: nota.nome_instancia, contatoTelefone: nota.contato_telefone, pdfPathOuUrl: nota.pdf_storage_path,
        nomeArquivo: 'DANFSe.pdf', legenda: 'Segue sua nota enviada pelo consultório. Documento de homologação, sem valor fiscal.'
      })).sucesso);
      if (resultado === 'erro') await this.medico({ medicoId, acao: 'falha_entrega', chave: nota.nota_fiscal_id });
      return resultado;
    } catch { this.log('ENTREGA_COMPROVANTE_FALHOU'); return 'erro'; }
  }

  private permitido(ativo: boolean | undefined, ambiente: unknown, telefone: unknown): boolean {
    if (!ativo || ambiente !== 'homologacao' || typeof telefone !== 'string') return false;
    const variantes = gerarVariantesTelefoneBrasileiro(telefone);
    return /^\d{10,13}$/.test(telefone.replace(/\D/g, '')) && (this.config.envioRealAllowlist ?? []).some(t => gerarVariantesTelefoneBrasileiro(t).some(v => variantes.includes(v)));
  }
  private simular(acao: string): 'simulado' { this.log(`enviaria ${acao}`); return 'simulado'; }

  private async enviarUnico(medicoId: string, acao: string, chave: string, enviar: () => Promise<boolean>): Promise<'enviado' | 'erro' | 'repetido'> {
    const hash = createHmac('sha256', this.config.appPepper).update(JSON.stringify([medicoId, acao, chave])).digest('hex');
    // A reserva permanece consumida mesmo se o transporte ou a confirmação falhar.
    const { rows } = await this.pool.query(`insert into public.noto_envios_homologacao (medico_id, acao, chave, estado)
      values ($1, $2, $3, 'reservado') on conflict (medico_id, acao, chave) do nothing returning id`, [medicoId, acao, hash]);
    if (!rows[0]) return 'repetido';
    let sucesso = false;
    try { sucesso = await enviar(); } catch { /* Entrega incerta não autoriza repetição. */ }
    await this.pool.query('update public.noto_envios_homologacao set estado = $2 where id = $1', [rows[0].id, sucesso ? 'enviado' : 'erro']);
    return sucesso ? 'enviado' : 'erro';
  }
}
