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
  falha_emissao: 'Doutor(a), não consegui concluir a emissão da nota. Pode revisar os dados fiscais e me orientar? Não vou tentar emitir novamente sozinho.',
  nota_gerada: 'Doutor(a), a nota de teste foi autorizada em homologação e não tem valor fiscal.',
  instancia_indisponivel: 'Doutor(a), a nota foi gerada, mas não consegui entregá-la. Confira se seu WhatsApp próprio está conectado e me oriente.',
  falha_entrega: 'Doutor(a), a nota foi gerada, mas houve uma falha ao preparar ou entregar o documento. Pode conferir? A nota será preservada sem nova emissão.'
};
const duvidas: Record<string, string> = {
  LEITURA_INDISPONIVEL: 'Não consegui ler o comprovante. Pode conferir e me orientar?',
  COMPROVANTE_ILEGIVEL: 'O comprovante está ilegível. Pode enviar uma imagem mais nítida?',
  NAO_COMPROVANTE: 'O arquivo recebido não foi reconhecido como comprovante. Pode conferir?',
  CAMPO_OBRIGATORIO_AUSENTE: 'Faltam dados obrigatórios no comprovante. Pode conferir?',
  CONFIANCA_INSUFICIENTE: 'Não consegui ler todos os dados do comprovante com segurança. Pode conferir?',
  CADASTRO_INCOMPLETO: 'Faltam dados do paciente ou da consulta para emitir a nota. Pode conferir?',
  VALOR_DIVERGENTE: 'O valor do comprovante é diferente do valor da consulta. Pode conferir antes de emitir?',
  PDF_NAO_SUPORTADO: 'Não consigo ler este comprovante em PDF. Pode enviar uma imagem?',
  FONTE_INDISPONIVEL: 'Não consegui consultar sua agenda agora. Pode conferir o acesso e me orientar?',
  ACESSO_EXPIRADO: 'O acesso à sua agenda expirou. Pode reconectar para eu conferir a consulta?',
  VINCULO_TELEFONE_INDEFINIDO: 'Não consegui identificar um único paciente na agenda pelo telefone que enviou o comprovante. Pode confirmar quem é?',
  CONSULTA_AMBIGUA_OU_AUSENTE: 'Não encontrei uma única última consulta realizada sem nota para este telefone. Pode confirmar a consulta?',
  COMPROVANTE_SEM_AUDITORIA_PRONTA: 'Não encontrei a conferência deste comprovante. Pode revisar antes de emitir?',
  CADASTRO_OU_CONSULTA_DIVERGENTE: 'Os dados mudaram depois da conferência do comprovante. Pode revisar?',
  PEDIDO_DIVERGENTE: 'O pedido está diferente da conferência do comprovante. Pode revisar?',
  EMISSAO_COMPROVANTE_BLOQUEADA: 'Este comprovante já tem uma emissão bloqueada ou com erro. Pode revisar como prosseguir?',
  AMBIENTE_NAO_HOMOLOGACAO: 'A emissão de teste exige ambiente de homologação. Pode conferir a configuração?',
  PERFIL_FISCAL_INCOMPLETO: 'Faltam dados fiscais para emitir a nota de teste. Pode conferir?',
  ENFILEIRAMENTO_COMPROVANTE_FALHOU: 'Não consegui registrar o pedido de emissão. Pode revisar antes de prosseguir?'
};

export class ComunicacaoHomologacao {
  constructor(private readonly pool: pg.Pool, private readonly config: AppConfig,
    private readonly transporte: EnviarMensagemPaciente, private readonly log: (texto: string) => void = console.info) {}

  async medico(entrada: { medicoId: string; acao: AcaoMedico; chave: string; motivo?: string }): Promise<'simulado' | 'enviado' | 'erro' | 'repetido'> {
    const { medicoId, acao, chave, motivo } = entrada;
    if (!this.config.envioMedicoRealAtivo) return this.simular(acao);
    try {
      const { rows } = await this.pool.query(`select u.telefone, pf.ambiente from medicos m
        join usuarios u on u.id = m.usuario_id left join medico_perfil_fiscal pf on pf.medico_id = m.id where m.id = $1`, [medicoId]);
      const destino = rows[0];
      if (!this.permitido(this.config.envioMedicoRealAtivo, destino?.ambiente, destino?.telefone)) return this.simular(acao);
      const texto = acao === 'perguntar_medico' && motivo && Object.hasOwn(duvidas, motivo) ? `Doutor(a), ${duvidas[motivo]}` : textos[acao];
      return await this.enviarUnico(medicoId, acao, chave, async () => (await this.transporte.enviarTexto({
        instanciaNome: this.config.evolutionAssistantInstanceName, contatoTelefone: destino.telefone, texto
      })).sucesso);
    } catch { this.log('COMUNICACAO_HOMOLOGACAO_FALHOU'); return 'erro'; }
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
