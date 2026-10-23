import pg from 'pg';
import { PostgresMemoriaConversaMedico } from './src/onboarding/memoria-conversa.js';
import { ConversadorMedico, validarAcaoConversa } from './src/onboarding/conversador-medico.js';
import { ferramentasLiberadas } from './src/onboarding/ferramentas-conversa.js';
import { completarOpenAi } from './src/io/nvidia/chat-client.js';

const ALICE = 'd90d2703-1e85-4bbc-ba9b-81cea3ed6b33';
const CONVERSA = '3a0a4161635d6527afb02205601211b509d857b63e8f8961e8cf2d86daff634f';
const env = (k: string) => process.env[k] ?? '';
const pool = new pg.Pool({ connectionString: env('DATABASE_URL'), ssl: { rejectUnauthorized: false } });
const memoria = new PostgresMemoriaConversaMedico(pool);

// mensagens reais até cada turno (noto + medico, sanitizadas como o histórico guarda)
// mesma consulta do histórico de produção (memoria.ler), com corte por id para congelar o passado
const historicoAte = async (idMax: number) => (await pool.query(
  "select texto from conversa_mensagens where medico_id=$1 and id<=$2 and (conversa=$3 or papel='noto' and (mensagem_id='noto:boas_vindas:unica' or mensagem_id like 'noto:agenda:%')) and mensagem_id not like 'contexto:%' order by id desc limit 30",
  [ALICE, idMax, CONVERSA])).rows.reverse().map(r => r.texto);
const ate = historicoAte;
const falsaSemMarca = (t: string) => t !== 'O link seguro já foi solicitado nesta conversa; aguardo a conexão. Isso não confirma envio.';

const completarSpy: typeof completarOpenAi = async (...a) => {
  try { const r = await completarOpenAi(...a); console.log('RAW_IA', JSON.stringify(r.slice(0, 400))); return r; }
  catch (e) { console.log('RAW_IA_ERRO', e instanceof Error ? e.message.slice(0, 200) : String(e)); throw e; }
};
const conversador = new ConversadorMedico(env('OPENAI_API_KEY'), env('OPENAI_TEXTO_MODEL') || 'gpt-4o-mini', completarSpy);

const fatosBase: any = {
  ambiente: 'homologacao', agenda: { nome: null, conectada: false },
  link: { ativo: false, enviados: 3, agenda: 'amplimed', usado: true, expirado: false, minutosDesdeEnvio: 0 },
  periodo: { desde: '2026-10-05', origem: 'contexto_salvo' },
  semAgendaDigital: false, lote: null, ultimoLote: { comErro: 3, emitidas: 0 },
  avisarHomologacao: false, propostaPendente: null, listaRecente: false, tarefaEmCurso: false, homologacaoInformada: false,
};

// TURNO A: "Feito" 18:40:04 (login ainda processando; permissões pendentes)
const fatosFeito = { ...fatosBase, permissoes: { emitirAutonomo: null, entregarPaciente: null, pendentes: true } };
const permitidasFeito = ferramentasLiberadas(fatosFeito as any, { lote: true });
console.log('== TURNO FEITO == permitidas', JSON.stringify(permitidasFeito));
for (let rep = 1; rep <= 2; rep++) {
  const d = await conversador.responder({ texto: 'Feito', mensagens: (await ate(508)).filter(falsaSemMarca), resumo: null, fatos: fatosFeito as any, agora: new Date('2026-10-23T18:40:04Z'), acoesPermitidas: permitidasFeito });
  const motivo = validarAcaoConversa(d, fatosFeito as any, permitidasFeito, 'Feito', new Date('2026-10-23T18:40:04Z'));
  console.log(`FEITO REP${rep}`, JSON.stringify({ fala: d.fala, acao: d.acao, parametros: d.parametros }), 'motivo=' + motivo);
}

// TURNO B: conclusão do link 18:40:27+ (permissão já salva; agenda.conectada conforme hipótese)
for (const conectado of [false, true]) {
  const fatosConc: any = { ...fatosBase,
    agenda: { nome: conectado ? 'amplimed' : null, conectada: conectado },
    permissoes: { emitirAutonomo: 'sempre_perguntar', entregarPaciente: null, pendentes: false },
    eventoAgenda: { agenda: 'amplimed', conectado, ...(conectado ? {} : { falhaAcesso: true }) },
    avisarHomologacao: conectado,
  };
  const permitidas = ferramentasLiberadas(fatosConc, { lote: true });
  console.log(`== TURNO CONCLUSAO conectado=${conectado} == permitidas`, JSON.stringify(permitidas));
  for (let rep = 1; rep <= 2; rep++) {
    const entrada = { texto: '', mensagens: (await ate(514)).filter(falsaSemMarca), resumo: null, fatos: fatosConc, agora: new Date('2026-10-23T18:40:34Z'), acoesPermitidas: permitidas };
    let d = await conversador.responder(entrada);
    let motivo = validarAcaoConversa(d, fatosConc as any, permitidas, '', entrada.agora);
    let falaFinal = d.fala;
    if (motivo === 'CONCLUSAO_SEM_ACAO') {
      const d2 = await conversador.responder({ ...entrada, acoesPermitidas: [], correcao: { motivo: 'o turno de conclusão só anuncia o resultado: conectado → avise que conectou e proponha o próximo passo; falha → explique o impedimento real e ofereça novo link; acao null', faltou: [] } });
      motivo = validarAcaoConversa(d2, fatosConc as any, permitidas, '', entrada.agora);
      falaFinal = d2.fala;
    }
    console.log(`CONC${conectado} REP${rep}`, JSON.stringify({ fala: falaFinal, motivoFinal: motivo }));
  }
}
await pool.end();
