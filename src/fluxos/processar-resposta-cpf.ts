// Captura e conferência do CPF respondido pelo paciente, e retomada da emissão.
// Regras duras:
// - Pendência real e consumo atômico vivem em candidatos_emissao (status), nunca no ledger de envios.
// - O CPF respondido é CANDIDATO: só vira cadastro após SIM do médico à conferência vinculada
//   (mensagem_id da pergunta), e só preenche campo vazio. Conferência não autoriza nota nem entrega.
// - Retomada re-extrai o comprovante pelo mensagem_id guardado; mídia morta = para sem emitir.
// - decidirPedidoComprovante(processados=[]) só pula o "já visto"; as travas de emissão ficam
//   por conta de enfileirar (revalidação + unique medico+consulta_chave + emissões).
import type pg from 'pg';
import { validarCpf } from '../paciente/validar-cpf.js';
import { auditarComprovante, decidirPedidoComprovante, chaveComprovante, type ExtratorComprovante, type ResultadoExtracaoComprovante,
  type DecisaoPedidoComprovante, type EstadoPedidoComprovante } from '../atendimento/comprovante.js';
import type { DadosMensagemEvolution } from '../whatsapp/payload-webhook-schema.js';
import type { FonteAgenda } from '../agenda/fonte-agenda.js';
import { consultarEstadoAgenda } from './processar-comprovante.js';

const PADRAO_CPF = /\d{3}\.?\d{3}\.?\d{3}-?\d{2}/g;

export interface ComunicacaoCpf {
  conversa(entrada: { medicoId: string; chave: string; fala: string[]; aoEnviar?: (mensagemId: string) => Promise<void> }): Promise<unknown>;
  medico(entrada: { medicoId: string; acao: any; chave: string; motivo?: string }): Promise<unknown>;
}

export interface RetomadaDeps {
  pool: pg.Pool;
  encryptionKey: string;
  pepper: string;
  extratorPara: (instancia: string) => ExtratorComprovante;
  fonteAgenda?: FonteAgenda;
  consultaJaFaturada?: (fonte: string, idExterno: string) => Promise<boolean>;
  lerEstado: (medicoId: string, pacienteId: string) => Promise<EstadoPedidoComprovante>;
  enfileirar: (entrada: any) => Promise<{ tipo: string; motivo?: string; solicitacaoId?: string }>;
  aposEnfileirar: (medicoId: string, resultado: { tipo: string; motivo?: string; solicitacaoId?: string | null }) => Promise<void>;
  comunicacao: ComunicacaoCpf;
  log?: (nivel: 'info' | 'erro', mensagem: string) => void;
}

function cpfsValidos(texto: string): string[] {
  const achados = new Set<string>();
  for (const m of texto.matchAll(PADRAO_CPF)) {
    const d = m[0].replace(/\D/g, '');
    if (validarCpf(d)) achados.add(d);
  }
  return [...achados];
}

/** Registra a pendência na hora da pergunta ao paciente. Serializado por médico+paciente;
 * mesma chave de comprovante já pendente não duplica. */
export async function registrarPerguntaCpf(
  pool: pg.Pool,
  entrada: { medicoId: string; pacienteId: string; comprovanteHash: string; comprovanteMensagemId: string; valorCentavos: number | null | undefined; dataPagamento: string | null | undefined }
): Promise<{ id: string; criado: boolean }> {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`cpf:${entrada.medicoId}:${entrada.pacienteId}`]);
    const existente = (await client.query(
      `select id from candidatos_emissao where medico_id=$1 and paciente_id=$2 and status='aguardando_cpf'
       and dados_brutos->>'comprovanteHash'=$3 limit 1`,
      [entrada.medicoId, entrada.pacienteId, entrada.comprovanteHash])).rows[0];
    if (existente) { await client.query('commit'); return { id: existente.id, criado: false }; }
    const conversa = (await client.query(
      'select id from whatsapp_conversas where medico_id=$1 and paciente_id=$2 order by criado_em desc limit 1',
      [entrada.medicoId, entrada.pacienteId])).rows[0];
    const novo = (await client.query(
      `insert into candidatos_emissao (medico_id, paciente_id, conversa_id, dados_brutos, status)
       values ($1,$2,$3,$4::jsonb,'aguardando_cpf') returning id`,
      [entrada.medicoId, entrada.pacienteId, conversa?.id ?? null, JSON.stringify({
        comprovanteHash: entrada.comprovanteHash, comprovanteMensagemId: entrada.comprovanteMensagemId,
        valorCentavos: entrada.valorCentavos ?? null, dataPagamento: entrada.dataPagamento ?? null })])).rows[0];
    await client.query('commit');
    return { id: novo.id, criado: true };
  } catch (e) { await client.query('rollback').catch(() => {}); throw e; }
  finally { client.release(); }
}

/** Texto do paciente na conversa vinculada: captura o CPF candidato e abre conferência ao médico. */
export async function processarRespostaCpfPaciente(
  deps: Pick<RetomadaDeps, 'pool' | 'encryptionKey' | 'comunicacao'>,
  contexto: { medicoId: string; pacienteId: string; texto: string }
): Promise<'ignorada' | 'ambigua' | 'consumida' | 'replay'> {
  const pendentes = (await deps.pool.query(
    `select id, dados_brutos from candidatos_emissao where medico_id=$1 and paciente_id=$2 and status='aguardando_cpf' order by criado_em`,
    [contexto.medicoId, contexto.pacienteId])).rows;
  if (pendentes.length === 0) return 'ignorada';
  const cpfs = cpfsValidos(contexto.texto);
  if (cpfs.length === 0) return 'ignorada';
  if (pendentes.length > 1) {
    await deps.comunicacao.conversa({ medicoId: contexto.medicoId, chave: `cpf_ambiguo:${contexto.pacienteId}`,
      fala: ['Doutor(a), o paciente enviou um CPF, mas há mais de um comprovante aguardando CPF. Me diga a qual consulta ele se refere, por favor.'] }).catch(() => {});
    return 'ambigua';
  }
  const pendente = pendentes[0];
  // Consumo atômico: só uma resposta/corrida vence; replay cai fora.
  const consumido = (await deps.pool.query(
    `update candidatos_emissao set status='cpf_recebido', respondido_em=now(), atualizado_em=now(),
       dados_brutos = dados_brutos || jsonb_build_object('cpfEnc', encode(pgp_sym_encrypt($2,$3),'base64'))
     where id=$1 and status='aguardando_cpf' returning id, dados_brutos`,
    [pendente.id, cpfs[0], deps.encryptionKey])).rows[0];
  if (!consumido) return 'replay';
  await deps.pool.query('update whatsapp_conversas set aguardando_cpf_desde=null where medico_id=$1 and paciente_id=$2',
    [contexto.medicoId, contexto.pacienteId]).catch(() => {});
  const nome = (await deps.pool.query('select nome from pacientes where id=$1 and medico_id=$2', [contexto.pacienteId, contexto.medicoId])).rows[0]?.nome ?? 'paciente';
  const d = cpfs[0];
  const mascara = `***.***.${d.slice(6, 9)}-${d.slice(9)}`;
  const dados = consumido.dados_brutos as { dataPagamento?: string | null; valorCentavos?: number | null };
  const contextoComprovante = [dados.dataPagamento ? `pagamento de ${dados.dataPagamento}` : null,
    typeof dados.valorCentavos === 'number' ? `R$ ${(dados.valorCentavos / 100).toFixed(2).replace('.', ',')}` : null].filter(Boolean).join(', ');
  // Conferência SÓ de identidade/cadastro, vinculada à mensagem (mensagem_id via aoEnviar).
  await deps.comunicacao.conversa({ medicoId: contexto.medicoId, chave: `confirma_cpf:${pendente.id}`,
    fala: [`Doutor(a), ${nome} respondeu o CPF ${mascara}${contextoComprovante ? ` (${contextoComprovante})` : ''}. Confirma que é o CPF dele(a), para eu cadastrar? Responda SIM ou NÃO nesta mensagem.`],
    aoEnviar: async mensagemId => { await deps.pool.query('update candidatos_emissao set mensagem_id=$2 where id=$1', [pendente.id, mensagemId]).catch(() => {}); }
  }).catch(() => {});
  return 'consumida';
}

/** Resposta do médico à conferência (vinculada por chavePergunta == mensagem_id). SIM genérico não confirma nada. */
export async function processarRespostaMedicoCpf(
  deps: RetomadaDeps,
  contexto: { medicoId: string; chavePergunta?: string; texto: string }
): Promise<'ignorada' | 'consumida'> {
  if (!contexto.chavePergunta) return 'ignorada';
  const row = (await deps.pool.query(
    `select id, status, paciente_id, conversa_id, dados_brutos from candidatos_emissao
     where medico_id=$1 and mensagem_id=$2 and status in ('cpf_recebido','confirmado') order by criado_em desc limit 1`,
    [contexto.medicoId, contexto.chavePergunta])).rows[0];
  if (!row) return 'ignorada';
  const texto = contexto.texto.trim().toLowerCase();
  const sim = /^(sim|s|isso|confirmo|confirmado|correto|pode|ok|exato)\b/.test(texto);
  const nao = /^(não|nao|n|errado|negativo|incorreto)\b/.test(texto);
  if (!sim && !nao) return 'ignorada';
  if (nao) {
    const r = await deps.pool.query(
      `update candidatos_emissao set status='recusado', atualizado_em=now() where id=$1 and status='cpf_recebido'`, [row.id]);
    if (r.rowCount === 0) return 'consumida'; // corrida: outro caminho já tratou
    await deps.comunicacao.conversa({ medicoId: contexto.medicoId, chave: `cpf_recusado:${row.id}`,
      fala: ['Entendido, descartei esse CPF e não cadastrei nada. Se quiser, me oriente por aqui sobre o CPF correto.'] }).catch(() => {});
    return 'consumida';
  }
  // SIM: transição atômica; se já 'confirmado' (crash depois da transição), a retomada é idempotente e continua.
  await deps.pool.query(`update candidatos_emissao set status='confirmado', atualizado_em=now() where id=$1 and status='cpf_recebido'`, [row.id]);
  await dirigirRetomada(deps, row.id);
  return 'consumida';
}

/** Cadastro (só campo vazio) + retomada. Idempotente: pode rodar de novo após crash em qualquer etapa. */
async function dirigirRetomada(deps: RetomadaDeps, candidatoId: string): Promise<void> {
  const log = deps.log ?? (() => {});
  const row = (await deps.pool.query(
    `select id, medico_id, paciente_id, conversa_id, dados_brutos, status from candidatos_emissao where id=$1`, [candidatoId])).rows[0];
  if (!row || row.status !== 'confirmado') return;
  const dados = row.dados_brutos as { comprovanteHash: string; comprovanteMensagemId: string; cpfEnc: string };
  const cpf = (await deps.pool.query(`select pgp_sym_decrypt(decode($1,'base64'), $2) as cpf`, [dados.cpfEnc, deps.encryptionKey])).rows[0]?.cpf;
  if (!cpf || !validarCpf(cpf)) { log('erro', 'CPF_CANDIDATO_ILEGIVEL'); return; }
  // 1. Cadastro: só campo vazio, nunca sobrescreve.
  await deps.pool.query(
    'update pacientes set cpf_cnpj_encriptado = pgp_sym_encrypt($3, $2) where id=$1 and cpf_cnpj_encriptado is null',
    [row.paciente_id, deps.encryptionKey, cpf]);
  // 2. Comprovante pelo mensagem_id guardado — nunca "o mais recente".
  const mensagem = (await deps.pool.query(
    `select payload_bruto from whatsapp_mensagens where conversa_id=$1 and payload_bruto->'key'->>'id'=$2 order by criado_em desc limit 1`,
    [row.conversa_id, dados.comprovanteMensagemId])).rows[0]?.payload_bruto as DadosMensagemEvolution | undefined;
  const parar = async (status: string, aviso: string) => {
    await deps.pool.query('update candidatos_emissao set status=$2, atualizado_em=now() where id=$1', [candidatoId, status]);
    await deps.comunicacao.conversa({ medicoId: row.medico_id, chave: `${status}:${candidatoId}`, fala: [aviso] }).catch(() => {});
  };
  if (!mensagem) return parar('midia_indisponivel',
    'Doutor(a), CPF cadastrado, mas não consegui recuperar o comprovante original. Peça ao paciente para reenviar a imagem, por favor.');
  const instancia = (await deps.pool.query(
    `select wi.nome_instancia from whatsapp_conversas wc join whatsapp_instancias wi on wi.id=wc.instancia_id where wc.id=$1`,
    [row.conversa_id])).rows[0]?.nome_instancia;
  if (!instancia) return parar('midia_indisponivel',
    'Doutor(a), CPF cadastrado, mas não consegui localizar a conexão do comprovante original. Peça ao paciente para reenviar a imagem, por favor.');
  let lido: ResultadoExtracaoComprovante | null = null;
  try { lido = await deps.extratorPara(instancia).extrair(mensagem); } catch { /* indisponibilidade = para sem emitir */ }
  if (lido?.tipo !== 'extraido') return parar('midia_indisponivel',
    'Doutor(a), CPF cadastrado, mas a imagem do comprovante não está mais legível. Peça ao paciente para reenviar, por favor.');
  // 3. Re-deriva agenda e re-decide do zero (processados=[] só ignora o "já visto", não as travas).
  let estado = await deps.lerEstado(row.medico_id, row.paciente_id) as any;
  const consultado = await consultarEstadoAgenda(mensagem, estado, { fonteAgenda: deps.fonteAgenda, consultaJaFaturada: deps.consultaJaFaturada }, lido);
  estado = consultado.estado;
  const decisao: DecisaoPedidoComprovante = decidirPedidoComprovante(lido, estado, [], consultado.agenda);
  if (decisao.tipo !== 'pedido_nota_pronto') return parar('condicoes_mudaram',
    'Doutor(a), CPF cadastrado, mas as condições da nota mudaram desde o comprovante (agenda ou valores). Confira o caso por aqui.');
  // 4. Auditoria nova + enfileiramento: enfileirar revalida hash, auditoria, consulta e travas de emissão.
  const auditoria = auditarComprovante(deps.pepper, estado, lido, decisao);
  await deps.pool.query(
    'insert into public.noto_auditoria_comprovantes (medico_id, lido, estado, decisao) values ($1, $2::jsonb, $3::jsonb, $4::jsonb)',
    [row.medico_id, JSON.stringify(auditoria.lido), JSON.stringify(auditoria.estado), JSON.stringify(auditoria.decisao)]);
  const bruto = Number(mensagem.messageTimestamp);
  const instante = new Date(bruto > 1e11 ? bruto : bruto * 1000);
  let resultado = await deps.enfileirar({ medicoId: row.medico_id, pacienteId: row.paciente_id, mensagem, decisao, lido,
    consulta: estado.consulta, dataEnvioPagamento: Number.isFinite(instante.getTime()) ? instante.toISOString() : null });
  if (resultado.tipo !== 'enfileirada') {
    // Re-drive após crash: a reserva do MESMO comprovante já existe (enfileirar é anti-duplicata e
    // devolve 'nenhuma'). Retoma dessa reserva em vez de abandonar; bloqueada/erro = para de verdade.
    const chave = chaveComprovante(deps.pepper, lido);
    const existente = (await deps.pool.query(
      `select estado, solicitacao_id from public.noto_emissoes_comprovantes
       where medico_id=$1 and comprovante_chave=$2 order by criado_em desc limit 1`, [row.medico_id, chave])).rows[0];
    if (existente && !['bloqueada', 'erro'].includes(existente.estado) && existente.solicitacao_id) {
      resultado = { tipo: 'enfileirada', solicitacaoId: existente.solicitacao_id };
    } else {
      return parar('condicoes_mudaram',
        'Doutor(a), CPF cadastrado, mas a nota não passou na revalidação de segurança. Confira o caso por aqui.');
    }
  }
  await deps.pool.query('update candidatos_emissao set status=$2, solicitacao_id=$3, atualizado_em=now() where id=$1',
    [candidatoId, 'retomado', resultado.solicitacaoId ?? null]);
  await deps.aposEnfileirar(row.medico_id, resultado);
}
