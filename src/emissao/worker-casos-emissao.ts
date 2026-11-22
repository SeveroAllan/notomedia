/**
 * Worker leve dedicado aos casos de emissão originados pela conversa/comprovante
 * no WhatsApp (`noto_casos_emissao` com `estado = 'enfileirada'`).
 * Reutiliza `PostgresEmissorDpsService`, extrai e entrega o PDF da DANFSE
 * corretamente, retenta falhas transitórias da SEFIN e traduz rejeições para
 * linguagem humana de secretária especialista.
 */

import type pg from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';
import type { EmissorDpsService } from '../worker/emissor-dps-service.js';
import { sanitizarErroFiscal } from '../observabilidade/erros.js';
import { reenfileirarCasosErroSefinSeOnline } from './retomar-casos-sefin-online.js';
import {
  ehFalhaTransitoriaSefin,
  ehIndisponibilidadeGlobalSefin,
  explicarErroEmissaoHumano
} from './regras/classificar-falha-emissao.js';

export { ehFalhaTransitoriaSefin, explicarErroEmissaoHumano };

const PREFIXO_DATA_URI_PDF = 'data:application/pdf;base64,';
const MAX_TENTATIVAS_TRANSIENTES = 3;
const BACKOFF_SEGUNDOS = [30, 120, 300] as const;

export interface WorkerCasosEmissaoDeps {
  pool: pg.Pool;
  emissorDps: EmissorDpsService;
  storage?: SupabaseClient;
  aoAutorizarNota: (entrada: {
    solicitacaoId: string;
    notaFiscalId: string | null;
    numeroNota: number;
    pdfBase64: string | null;
    contingenciaHomologacao?: boolean;
  }) => Promise<boolean>;
  aoFalharEmissao?: (entrada: {
    contaId: string;
    casoId: string;
    pacienteNome: string | null;
    codigoErro?: string;
    erroSanitizado: string;
    mensagemHumana: string;
  }) => Promise<void>;
  intervaloMs?: number;
  permitirProducao?: boolean;
}

/** Extrai o PDF em base64 (suportando tanto data URI quanto caminho no Storage) e persiste no bucket. */
export async function resolverEPersistirPdfDanfse(entrada: {
  pdfRetornado?: string | null;
  storage?: SupabaseClient;
  caminhoDestino: string;
}): Promise<{ pdfBase64: string | null; pdfStoragePath: string | null }> {
  const bruto = entrada.pdfRetornado?.trim();
  if (!bruto) return { pdfBase64: null, pdfStoragePath: null };

  if (bruto.startsWith(PREFIXO_DATA_URI_PDF)) {
    const pdfBase64 = bruto.slice(PREFIXO_DATA_URI_PDF.length).trim();
    if (!pdfBase64) return { pdfBase64: null, pdfStoragePath: null };
    let pathFinal: string | null = entrada.caminhoDestino;
    if (entrada.storage) {
      const buf = Buffer.from(pdfBase64, 'base64');
      const up = await entrada.storage.storage
        .from('notas')
        .upload(entrada.caminhoDestino, buf, { contentType: 'application/pdf', upsert: true })
        .catch(() => ({ error: { message: 'STORAGE_FALHOU' } }));
      if (up?.error) pathFinal = null;
    }
    return { pdfBase64, pdfStoragePath: pathFinal };
  }

  if (entrada.storage) {
    const dl = await entrada.storage.storage.from('notas').download(bruto).catch(() => null);
    if (dl?.data) {
      const ab = await dl.data.arrayBuffer();
      return { pdfBase64: Buffer.from(ab).toString('base64'), pdfStoragePath: bruto };
    }
  }
  return { pdfBase64: null, pdfStoragePath: bruto };
}

export async function processarProximoCasoEmissaoWhatsapp(deps: WorkerCasosEmissaoDeps): Promise<boolean> {
  const { rows } = await deps.pool.query(
    `with proximo as (
       select c.id as caso_id, sn.id as solicitacao_id
       from public.noto_casos_emissao c
       join public.solicitacoes_nota sn on sn.id = c.solicitacao_id
       where c.estado = 'enfileirada'
         and sn.fila = 'pronta'
         and sn.status = 'pronta'
         and (sn.proxima_tentativa_em is null or sn.proxima_tentativa_em <= now())
         and (sn.bloqueada_em is null or sn.bloqueada_em < now() - interval '5 minutes')
       order by c.atualizado_em asc
       limit 1
       for update of sn skip locked
     )
     update public.solicitacoes_nota sn
     set bloqueada_por_worker = 'worker-casos-wpp', bloqueada_em = now()
     from proximo
     where sn.id = proximo.solicitacao_id
     returning proximo.caso_id, sn.id, sn.medico_id, sn.paciente_id, sn.xdesc_serv,
               sn.valor_servico_centavos, sn.ctrib_nac, sn.cnbs, sn.cclass_trib, sn.cind_op, sn.tentativas`
  );
  const item = rows[0];
  if (!item) return false;

  const casoRes = await deps.pool.query(
    'select conta_id, paciente_nome, ambiente from public.noto_casos_emissao where id = $1 limit 1',
    [item.caso_id]
  );
  const casoInfo = casoRes.rows[0];
  if (!casoInfo) return false;

  if (casoInfo.ambiente === 'producao' && !deps.permitirProducao) {
    await marcarErroCaso(deps.pool, item.caso_id, item.id, 'PRODUCAO_NAO_LIBERADA');
    return true;
  }

  const solicitacaoInput = {
    id: String(item.id),
    medicoId: String(item.medico_id),
    pacienteId: String(item.paciente_id),
    xdescServ: String(item.xdesc_serv),
    valorServicoCentavos: Number(item.valor_servico_centavos),
    ctribNac: String(item.ctrib_nac),
    cnbs: item.cnbs ?? null,
    cclassTrib: item.cclass_trib ?? null,
    cindOp: item.cind_op ?? null
  };

  let emissao = await deps.emissorDps.emitir(solicitacaoInput);

  // Autocorreção determinística quando o emissor suporta ajuste conservador da rejeição.
  if (!emissao.sucesso && deps.emissorDps.corrigirRejeicao && emissao.xmlDpsOriginal && !ehFalhaTransitoriaSefin(emissao)) {
    const corrigida = await deps.emissorDps.corrigirRejeicao(solicitacaoInput, emissao).catch(() => null);
    if (corrigida?.sucesso) emissao = corrigida;
  }

  if (!emissao.sucesso) {
    const tentativasAtuais = Number(item.tentativas ?? 0);
    if (ehFalhaTransitoriaSefin(emissao) && tentativasAtuais < MAX_TENTATIVAS_TRANSIENTES) {
      const esperaSeg = BACKOFF_SEGUNDOS[Math.min(tentativasAtuais, BACKOFF_SEGUNDOS.length - 1)] ?? 120;
      await agendarRetentativaSolicitacao(deps.pool, String(item.id), tentativasAtuais + 1, esperaSeg);
      return true;
    }

    const erroLimpo = sanitizarErroFiscal(emissao.erro, [casoInfo.paciente_nome]).slice(0, 180);
    await marcarErroCaso(deps.pool, item.caso_id, item.id, erroLimpo);
    if (ehIndisponibilidadeGlobalSefin(emissao.codigoErroSefin)) {
      await marcarLoteErroSefinConta(deps.pool, String(casoInfo.conta_id), String(casoInfo.ambiente), erroLimpo);
    }
    await deps.aoFalharEmissao?.({
      contaId: String(casoInfo.conta_id),
      casoId: String(item.caso_id),
      pacienteNome: casoInfo.paciente_nome ?? null,
      codigoErro: emissao.codigoErroSefin,
      erroSanitizado: erroLimpo,
      mensagemHumana: explicarErroEmissaoHumano({
        codigoErro: emissao.codigoErroSefin,
        erroSanitizado: erroLimpo,
        pacienteNome: casoInfo.paciente_nome ?? null
      })
    }).catch(() => undefined);
    return true;
  }

  const caminhoPdfPadrao = `notas/${item.medico_id}/${emissao.competencia}/${emissao.chaveAcesso}.pdf`;
  const { pdfBase64, pdfStoragePath } = await resolverEPersistirPdfDanfse({
    pdfRetornado: emissao.pdfStoragePath,
    storage: deps.storage,
    caminhoDestino: caminhoPdfPadrao
  });

  const competenciaDate = /^\d{4}-\d{2}$/.test(emissao.competencia)
    ? `${emissao.competencia}-01`
    : emissao.competencia;

  const notaRes = await deps.pool.query(
    `insert into public.notas_fiscais (
       medico_id, solicitacao_id, chave_acesso, ndps, serie, competencia,
       data_emissao, status, valor_servicos_centavos, xml_storage_path, pdf_storage_path, resposta_sefin_raw
     ) values ($1, $2, $3, $4, $5, $6, $7, 'autorizada', $8, $9, $10, $11)
     returning id`,
    [
      item.medico_id, item.id, emissao.chaveAcesso, emissao.ndps, emissao.serie,
      competenciaDate, emissao.dataEmissao, emissao.valorServicosCentavos,
      emissao.xmlStoragePath, pdfStoragePath,
      emissao.respostaSefinRaw ? JSON.stringify(emissao.respostaSefinRaw) : null
    ]
  );
  await deps.pool.query(
    `update public.solicitacoes_nota
     set status = 'emitida', fila = null, bloqueada_por_worker = null, bloqueada_em = null
     where id = $1`,
    [item.id]
  );
  await deps.pool.query(
    `update public.medico_perfil_fiscal
     set proximo_numero_dps = greatest(coalesce(proximo_numero_dps, 1), $2 + 1), atualizado_em = now()
     where medico_id = $1`,
    [item.medico_id, emissao.ndps]
  );

  await deps.aoAutorizarNota({
    solicitacaoId: String(item.id),
    notaFiscalId: notaRes.rows[0]?.id ? String(notaRes.rows[0].id) : null,
    numeroNota: emissao.ndps,
    pdfBase64,
    ...(emissao.contingenciaHomologacao ? { contingenciaHomologacao: true } : {})
  });
  return true;
}

export function iniciarWorkerCasosEmissao(deps: WorkerCasosEmissaoDeps) {
  let ativo = true;
  let processando = false;
  const intervalo = deps.intervaloMs ?? 2500;
  const drenarFila = async () => {
    if (!ativo || processando) return;
    processando = true;
    try {
      let processou = true;
      let lotes = 0;
      while (ativo && processou && lotes < 10) {
        processou = await processarProximoCasoEmissaoWhatsapp(deps);
        lotes++;
      }
    } catch (err: any) {
      console.warn('[WorkerCasosEmissao] Falha no ciclo:', err?.message || err);
    } finally {
      processando = false;
    }
  };
  const timer = setInterval(() => {
    void drenarFila();
  }, intervalo);
  timer.unref();
  const timerRecuperacao = setInterval(() => {
    if (!ativo) return;
    void reenfileirarCasosErroSefinSeOnline(deps.pool)
      .then(qtd => { if (qtd > 0) void drenarFila(); })
      .catch(() => undefined);
  }, 180_000);
  timerRecuperacao.unref();
  return {
    parar() {
      ativo = false;
      clearInterval(timer);
      clearInterval(timerRecuperacao);
    }
  };
}

async function agendarRetentativaSolicitacao(
  pool: pg.Pool,
  solicitacaoId: string,
  novasTentativas: number,
  esperaSegundos: number
): Promise<void> {
  await pool.query(
    `update public.solicitacoes_nota
     set tentativas = $2,
         proxima_tentativa_em = now() + ($3 || ' seconds')::interval,
         bloqueada_por_worker = null,
         bloqueada_em = null,
         atualizado_em = now()
     where id = $1`,
    [solicitacaoId, novasTentativas, String(esperaSegundos)]
  );
}

async function marcarErroCaso(pool: pg.Pool, casoId: string, solicitacaoId: string, motivo: string): Promise<void> {
  await pool.query(
    `update public.noto_casos_emissao set estado = 'erro', erro_motivo = $2, atualizado_em = now() where id = $1`,
    [casoId, motivo]
  );
  await pool.query(
    `update public.solicitacoes_nota set status = 'erro', fila = null, erro = $2, bloqueada_por_worker = null, bloqueada_em = null where id = $1`,
    [solicitacaoId, motivo]
  );
}

/**
 * Propaga indisponibilidade global da SEFIN para os demais itens enfileirados da mesma conta/ambiente,
 * evitando N requisições fadadas ao erro e rajadas repetidas de alerta no WhatsApp.
 */
async function marcarLoteErroSefinConta(
  pool: pg.Pool,
  contaId: string,
  ambiente: string,
  motivo: string
): Promise<void> {
  const { rows } = await pool.query(
    `update public.noto_casos_emissao
        set estado = 'erro', erro_motivo = $3, atualizado_em = now()
      where conta_id = $1 and ambiente = $2 and estado = 'enfileirada'
      returning solicitacao_id`,
    [contaId, ambiente, motivo]
  );
  const solicitacaoIds = rows.map((r: { solicitacao_id?: string | null }) => r.solicitacao_id).filter(Boolean);
  if (!solicitacaoIds.length) return;
  await pool.query(
    `update public.solicitacoes_nota
        set status = 'erro', fila = null, erro = $2, bloqueada_por_worker = null, bloqueada_em = null
      where id = any($1::uuid[])`,
    [solicitacaoIds, motivo]
  );
}
