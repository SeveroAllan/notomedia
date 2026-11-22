/**
 * Composição de infraestrutura da emissão conversacional/comprovantes para
 * reuso idêntico entre `dev-local-start.ts` e `server.ts`. Mantém os entrypoints
 * enxutos e garante o mesmo comportamento de contexto fiscal, agenda e mídia.
 */

import type pg from 'pg';
import { consultarPreferenciasEmissaoConta } from '../conta/preferencias-emissao-repositorio.js';
import { cofreIdDaConta } from '../cofre/identidade-conta.js';
import type { AtendimentoAgendaResumo } from '../agenda/filtrar-atendimentos-agenda.js';
import type { MensagemPacienteConsultorio } from '../whatsapp/webhook-pareamento.js';
import {
  decodificarBase64Midia,
  type PortaBaixarMidia,
  type PortaLerComprovante
} from '../midia/midia-tipos.js';
import { PostgresCasoEmissaoRepositorio, type ChaveMensagemCaso } from './caso-emissao-repositorio.js';
import { buscarDadosConhecidosPacienteConta } from './buscar-historico-paciente-conta.js';
import { enfileirarEmissaoWhatsapp } from './enfileirar-emissao-whatsapp.js';
import {
  criarOrquestradorEmissaoConta,
  type ContextoOperacionalConta,
  type DetalheAtendimentoAoVivo
} from './orquestrar-emissao-conta.js';
import {
  formatarResumoLoteWhatsApp,
  prepararEmissaoLotePeriodo,
  type ResultadoEmissaoLotePeriodo
} from './preparar-emissao-lote-periodo.js';

export interface InfraEmissaoContaDeps {
  pool: pg.Pool;
  chaveCriptografia: string;
  pepper: string;
  permitirProducao?: boolean;
  obterAtendimentosAgenda: (contaId: string, inicioIso: string, fimIso: string) => Promise<AtendimentoAgendaResumo[]>;
  obterAtendimentosDetalhados?: (contaId: string, inicioIso: string, fimIso: string) => Promise<AtendimentoAgendaResumo[]>;
  obterDetalheTribemd?: (contaId: string, atendimentoId: string) => Promise<DetalheAtendimentoAoVivo | null>;
  enviarTextoMedico: (contaId: string, telefone: string, texto: string) => Promise<boolean>;
  enviarPdfMedico?: (contaId: string, telefone: string, pdfBase64: string, nomeArquivo: string, legenda: string) => Promise<boolean>;
  enviarTextoConsultorio?: (instancia: string, telefonePaciente: string, texto: string) => Promise<boolean>;
  enviarPdfConsultorio?: (instancia: string, telefonePaciente: string, pdfBase64: string, nomeArquivo: string, legenda: string) => Promise<boolean>;
  reagirMensagemMedico?: (chave: ChaveMensagemCaso, emoji: '✅') => Promise<boolean>;
  baixarMidia?: PortaBaixarMidia['baixarBase64'];
  lerComprovante?: PortaLerComprovante['ler'];
}

export function montarInfraEmissaoConta(deps: InfraEmissaoContaDeps) {
  const repositorio = new PostgresCasoEmissaoRepositorio(deps.pool, deps.chaveCriptografia, deps.pepper);

  const obterContextoConta = async (contaId: string): Promise<ContextoOperacionalConta> => {
    const [prefs, medRes, telRes, instRes] = await Promise.all([
      consultarPreferenciasEmissaoConta(deps.pool, contaId),
      deps.pool.query(
        `select m.id,
                coalesce(pf.ambiente, 'homologacao') as ambiente,
                coalesce(pf.confirmado_pelo_medico, false)
                  and coalesce(pf.serie_dps, '') ~ '^[0-9]{1,5}$'
                  and case when coalesce(pf.serie_dps, '') ~ '^[0-9]{1,5}$' then pf.serie_dps::int <= 49999 else false end as confirmado_fiscal,
                exists(
                  select 1 from public.medico_certificados c
                  where c.medico_id = m.id and c.status = 'ativo'
                    and (c.valido_ate is null or c.valido_ate >= current_date)
                ) as cert_valido,
                exists(
                  select 1 from public.medico_servicos_fiscais sf
                  where sf.medico_id = m.id and sf.ativo = true and sf.padrao = true
                    and sf.ctrib_nac is not null and sf.parametros_emissao is not null
                ) as servico_pronto
         from public.medicos m
         left join public.medico_perfil_fiscal pf on pf.medico_id = m.id
         where m.conta_id = $1
         order by m.criado_em asc
         limit 1`,
        [contaId]
      ),
      deps.pool.query(
        `select telefone from public.usuarios where conta_id = $1 and ativo = true order by criado_em asc limit 1`,
        [contaId]
      ),
      deps.pool.query(
        `select nome_instancia from public.whatsapp_instancias
         where conta_id = $1 and oficial = false and status = 'conectado'
         order by conectado_em desc nulls last, criado_em desc
         limit 1`,
        [contaId]
      )
    ]);

    const med = medRes.rows[0];
    const ambiente: 'homologacao' | 'producao' = med?.ambiente === 'producao' ? 'producao' : 'homologacao';
    return {
      medicoPadraoId: med?.id ? String(med.id) : null,
      telefoneMedico: telRes.rows[0]?.telefone ? String(telRes.rows[0].telefone) : null,
      instanciaConsultorio: instRes.rows[0]?.nome_instancia ? String(instRes.rows[0].nome_instancia) : null,
      preferencias: prefs,
      prontidaoFiscal: {
        certificadoValido: Boolean(med?.cert_valido),
        dadosFiscaisProntos: Boolean(med?.confirmado_fiscal && med?.servico_pronto),
        ambiente,
        producaoLiberadaNaConta: Boolean(deps.permitirProducao)
      }
    };
  };

  const orquestrador = criarOrquestradorEmissaoConta({
    repositorio,
    pepper: deps.pepper,
    obterContextoConta,
    obterAtendimentosAgenda: deps.obterAtendimentosAgenda,
    obterDetalheAtendimento: deps.obterDetalheTribemd,
    buscarPacienteConhecido: entrada => buscarDadosConhecidosPacienteConta(deps.pool, deps.chaveCriptografia, entrada),
    enfileirarEmissao: caso => enfileirarEmissaoWhatsapp(caso, {
      pool: deps.pool,
      chaveCriptografia: deps.chaveCriptografia,
      pepper: deps.pepper,
      permitirProducao: deps.permitirProducao
    }),
    enviarTextoMedico: deps.enviarTextoMedico,
    enviarPdfMedico: deps.enviarPdfMedico,
    enviarTextoConsultorio: deps.enviarTextoConsultorio,
    enviarPdfConsultorio: deps.enviarPdfConsultorio,
    reagirMensagemMedico: deps.reagirMensagemMedico
  });

  const tratarMensagemPacienteConsultorio = async (msg: MensagemPacienteConsultorio): Promise<void> => {
    const contaRes = await deps.pool.query(
      `select conta_id from public.whatsapp_instancias
       where nome_instancia = $1 and oficial = false and conta_id is not null
       limit 1`,
      [msg.instancia]
    );
    const contaId = contaRes.rows[0]?.conta_id ? String(contaRes.rows[0].conta_id) : null;
    if (!contaId) return;

    if (msg.tipoMidia === 'texto' && msg.texto.trim()) {
      await orquestrador.tratarRespostaCpfPaciente({
        contaId,
        instanciaConsultorio: msg.instancia,
        telefonePaciente: msg.telefoneRemetente,
        texto: msg.texto
      });
      return;
    }

    if ((msg.tipoMidia === 'imagem' || msg.tipoMidia === 'documento') && deps.baixarMidia && deps.lerComprovante) {
      const bruto = await deps.baixarMidia(msg.instancia, msg.mensagemId).catch(() => null);
      const dec = decodificarBase64Midia(
        bruto?.base64,
        bruto?.mimetype || msg.mimetype || (msg.tipoMidia === 'imagem' ? 'image/jpeg' : 'application/pdf')
      );
      if (!dec.ok || (dec.tipo !== 'imagem' && dec.tipo !== 'pdf')) return;
      if (msg.nomeArquivo) dec.midia.nomeArquivo = msg.nomeArquivo;

      const leitura = await deps.lerComprovante(dec.midia).catch(() => ({ ok: false as const, motivo: 'ERRO' }));
      if (!leitura.ok || !leitura.dados.ehComprovante) return;

      await orquestrador.processarComprovanteRecebido({
        contaId,
        origem: 'comprovante_paciente',
        comprovante: leitura.dados,
        mensagemId: msg.mensagemId,
        telefoneRemetente: msg.telefoneRemetente
      });
    }
  };

  const prepararEmissaoPeriodoComEspera = async (entrada: {
    contaId: string;
    telefoneMedico: string;
    dataInicio: string;
    dataFim: string;
    aprovadoAgora?: boolean;
    chaveMensagemMedico?: ChaveMensagemCaso | null;
  }): Promise<ResultadoEmissaoLotePeriodo> => {
    const leitorDetalhado = deps.obterAtendimentosDetalhados ?? deps.obterAtendimentosAgenda;
    const promessa = prepararEmissaoLotePeriodo({
      contaId: entrada.contaId,
      dataInicio: entrada.dataInicio,
      dataFim: entrada.dataFim,
      aprovadoAgora: entrada.aprovadoAgora,
      chaveMensagemMedico: entrada.chaveMensagemMedico
    }, {
      repositorio,
      obterAtendimentosDetalhados: leitorDetalhado,
      prepararIndividual: item => orquestrador.prepararEmissaoPeloMedico(item)
    });

    const limite = Symbol('timeout');
    const corrida = await Promise.race([
      promessa,
      new Promise<typeof limite>(resolve => { const t = setTimeout(() => resolve(limite), 25_000); t.unref(); })
    ]);
    if (corrida !== limite) return corrida;

    void promessa.then(async res => {
      await new Promise(r => setTimeout(r, 1500));
      const texto = formatarResumoLoteWhatsApp(res);
      await deps.enviarTextoMedico(entrada.contaId, entrada.telefoneMedico, texto);
      if (res.ok && entrada.chaveMensagemMedico && deps.reagirMensagemMedico) {
        await deps.reagirMensagemMedico(entrada.chaveMensagemMedico, '✅').catch(() => false);
      }
    }).catch(() => undefined);

    return {
      ok: true,
      emAndamento: true,
      periodo: { inicio: entrada.dataInicio, fim: entrada.dataFim },
      aviso: 'A leitura detalhada da agenda ainda está em andamento em segundo plano. NÃO diga que não encontrou consultas nem que deu erro — apenas avise em uma frase curta que está puxando os atendimentos e envia o resultado assim que terminar.'
    };
  };

  return {
    repositorio,
    orquestrador,
    obterContextoConta,
    tratarMensagemPacienteConsultorio,
    prepararEmissaoPeriodoComEspera,
    cofreIdDaConta
  };
}
