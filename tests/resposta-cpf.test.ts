import { describe, expect, it, vi } from 'vitest';
import { registrarPerguntaCpf, processarRespostaCpfPaciente, processarRespostaMedicoCpf, type RetomadaDeps } from '../src/fluxos/processar-resposta-cpf.js';
import { chaveComprovante } from '../src/atendimento/comprovante.js';

// Banco em memória que emula a semântica relevante do Postgres: consumo atômico por
// update...where status=... returning, trava consultiva por transação e pgp_sym_* simulado.
function bancoFalso() {
  const candidatos: any[] = [];
  const pacientes = new Map<string, any>();
  const conversas: any[] = [];
  const instancias = new Map<string, string>();
  const mensagens: any[] = [];
  const emissoes: any[] = [];
  const auditorias: any[] = [];
  const cadeado = new Map<string, Promise<void>>();
  let relogio = 0;
  const trava = async (chave: string) => {
    const anterior = cadeado.get(chave);
    let liberar!: () => void;
    const atual = new Promise<void>(r => { liberar = r; });
    cadeado.set(chave, (anterior ?? Promise.resolve()).then(() => atual));
    if (anterior) await anterior;
    return liberar;
  };
  const query = async (sql: string, params: any[] = []): Promise<{ rows: any[]; rowCount: number }> => {
    const s = sql.replace(/\s+/g, ' ').trim().toLowerCase();
    if (s === 'begin' || s === 'commit' || s === 'rollback') return { rows: [], rowCount: 0 };
    if (s.includes('pg_advisory_xact_lock')) throw new Error('TRAVA_SOMENTE_EM_CLIENTE');
    if (s.startsWith('insert into candidatos_emissao')) {
      const row = { id: `cand-${candidatos.length + 1}`, medico_id: params[0], paciente_id: params[1], conversa_id: params[2],
        dados_brutos: JSON.parse(params[3]), status: 'aguardando_cpf', mensagem_id: null, solicitacao_id: null, criado_em: ++relogio };
      candidatos.push(row); return { rows: [{ id: row.id }], rowCount: 1 };
    }
    if (s.includes("dados_brutos->>'comprovantehash'"))
      return { rows: candidatos.filter(c => c.medico_id === params[0] && c.paciente_id === params[1]
        && c.status === 'aguardando_cpf' && c.dados_brutos.comprovanteHash === params[2]).map(c => ({ id: c.id })), rowCount: 0 };
    if (s.startsWith('select id, dados_brutos from candidatos_emissao'))
      return { rows: candidatos.filter(c => c.medico_id === params[0] && c.paciente_id === params[1] && c.status === 'aguardando_cpf')
        .sort((a, b) => a.criado_em - b.criado_em).map(c => ({ id: c.id, dados_brutos: c.dados_brutos })), rowCount: 0 };
    if (s.startsWith('select id, status, paciente_id, conversa_id, dados_brutos from candidatos_emissao'))
      return { rows: candidatos.filter(c => c.medico_id === params[0] && c.mensagem_id === params[1]
        && (c.status === 'cpf_recebido' || c.status === 'confirmado'))
        .sort((a, b) => b.criado_em - a.criado_em).slice(0, 1), rowCount: 0 };
    if (s.startsWith('select id, medico_id, paciente_id, conversa_id, dados_brutos, status from candidatos_emissao where id='))
      return { rows: candidatos.filter(c => c.id === params[0]).map(c => ({ ...c })), rowCount: 0 };
    if (s.includes("set status='cpf_recebido'")) {
      const row = candidatos.find(c => c.id === params[0] && c.status === 'aguardando_cpf');
      if (!row) return { rows: [], rowCount: 0 };
      row.status = 'cpf_recebido'; row.respondido_em = Date.now();
      row.dados_brutos = { ...row.dados_brutos, cpfEnc: `enc:${params[1]}` };
      return { rows: [{ id: row.id, dados_brutos: row.dados_brutos }], rowCount: 1 };
    }
    if (s.includes("set status='recusado'")) {
      const row = candidatos.find(c => c.id === params[0] && c.status === 'cpf_recebido');
      if (!row) return { rows: [], rowCount: 0 };
      row.status = 'recusado'; return { rows: [], rowCount: 1 };
    }
    if (s.includes("set status='confirmado'")) {
      const row = candidatos.find(c => c.id === params[0] && c.status === 'cpf_recebido');
      if (!row) return { rows: [], rowCount: 0 };
      row.status = 'confirmado'; return { rows: [], rowCount: 1 };
    }
    if (s.startsWith('update candidatos_emissao set mensagem_id')) {
      const row = candidatos.find(c => c.id === params[0]); if (row) row.mensagem_id = params[1];
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (s.includes('solicitacao_id=$3')) {
      const row = candidatos.find(c => c.id === params[0]);
      if (row) { row.status = params[1]; row.solicitacao_id = params[2]; }
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (s.startsWith('update candidatos_emissao set status=$2')) {
      const row = candidatos.find(c => c.id === params[0]); if (row) row.status = params[1];
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    if (s.startsWith('update whatsapp_conversas set aguardando_cpf_desde')) return { rows: [], rowCount: 0 };
    if (s.startsWith('select id from whatsapp_conversas where medico_id='))
      return { rows: conversas.filter(c => c.medico_id === params[0] && c.paciente_id === params[1]).map(c => ({ id: c.id })), rowCount: 0 };
    if (s.startsWith('select nome from pacientes'))
      return { rows: [{ nome: pacientes.get(params[0])?.nome ?? null }], rowCount: 0 };
    if (s.startsWith('update pacientes set cpf_cnpj_encriptado')) {
      const p = pacientes.get(params[0]);
      if (p && p.cpf_cnpj_encriptado == null) { p.cpf_cnpj_encriptado = `enc:${params[2]}`; return { rows: [], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    }
    if (s.includes('pgp_sym_decrypt')) return { rows: [{ cpf: String(params[0]).replace(/^enc:/, '') }], rowCount: 0 };
    if (s.startsWith('select payload_bruto from whatsapp_mensagens'))
      return { rows: mensagens.filter(m => m.conversa_id === params[0] && m.payload_bruto?.key?.id === params[1])
        .map(m => ({ payload_bruto: m.payload_bruto })), rowCount: 0 };
    if (s.includes('nome_instancia')) {
      const conv = conversas.find(c => c.id === params[0]);
      const nome = conv ? instancias.get(conv.instancia_id) : undefined;
      return { rows: nome ? [{ nome_instancia: nome }] : [], rowCount: 0 };
    }
    if (s.startsWith('insert into public.noto_auditoria_comprovantes')) {
      auditorias.push({ medico_id: params[0], lido: JSON.parse(params[1]), estado: JSON.parse(params[2]), decisao: JSON.parse(params[3]) });
      return { rows: [], rowCount: 1 };
    }
    if (s.includes('from public.noto_emissoes_comprovantes'))
      return { rows: emissoes.filter(e => e.medico_id === params[0] && e.comprovante_chave === params[1]), rowCount: 0 };
    throw new Error(`SQL_NAO_MAPEADO: ${s}`);
  };
  const pool = {
    query,
    connect: async () => {
      const liberacoes: Array<() => void> = [];
      return {
        query: async (sql: string, params: any[] = []) => {
          const s = sql.replace(/\s+/g, ' ').trim().toLowerCase();
          if (s === 'begin') return { rows: [], rowCount: 0 };
          if (s === 'commit' || s === 'rollback') { liberacoes.splice(0).forEach(l => l()); return { rows: [], rowCount: 0 }; }
          if (s.includes('pg_advisory_xact_lock')) { liberacoes.push(await trava(params![0])); return { rows: [], rowCount: 0 }; }
          return query(sql, params);
        },
        release: () => { liberacoes.splice(0).forEach(l => l()); }
      };
    }
  };
  return { pool, candidatos, pacientes, conversas, instancias, mensagens, emissoes, auditorias };
}

const CPF = '52998224725';
const lido = () => ({ tipo: 'extraido' as const, campos: { valorCentavos: 35000, dataPagamento: '2026-10-18',
  nomePagador: 'Paciente Ficticio', nomeFavorecido: 'Medica Ficticia',
  confianca: { valorCentavos: 0.9, dataPagamento: 0.9, nomePagador: 0.9, nomeFavorecido: 0.9 } } });
const mensagemComprovante = () => ({ key: { id: 'msg-comp-1', remoteJid: '5511999990000@s.whatsapp.net', remoteJidAlt: null, fromMe: false },
  message: { imageMessage: { mimetype: 'image/jpeg', url: 'https://midia.invalid/pix.jpg' } }, messageTimestamp: 1761000000 });

function comunicacaoFalsa() {
  const enviadas: any[] = [];
  return { enviadas, comunicacao: {
    conversa: vi.fn(async (entrada: any) => { enviadas.push(entrada); if (entrada.aoEnviar) await entrada.aoEnviar('msg-conf-1'); }),
    medico: vi.fn(async () => {})
  } };
}

function depsRetomada(b: ReturnType<typeof bancoFalso>, extra: Partial<RetomadaDeps> = {}) {
  const { comunicacao, enviadas } = comunicacaoFalsa();
  const enfileirar = vi.fn(async () => ({ tipo: 'enfileirada', solicitacaoId: 'sol-1' }));
  const aposEnfileirar = vi.fn(async () => {});
  const extrator = { extrair: vi.fn(async () => lido()) };
  const deps: RetomadaDeps = {
    pool: b.pool as any, encryptionKey: 'enc-ficticia', pepper: 'pepper-ficticio', comunicacao,
    extratorPara: () => extrator as any,
    lerEstado: async (medicoId: string) => ({ medicoId, paciente: { nome: 'Paciente Ficticio', cpf: CPF },
      ultimaConsulta: { valorConsultaCentavos: 35000 } } as any),
    enfileirar: enfileirar as any, aposEnfileirar, ...extra };
  return { deps, enviadas, enfileirar, aposEnfileirar, extrator };
}

async function semearPendencia(b: ReturnType<typeof bancoFalso>) {
  b.conversas.push({ id: 'conversa-1', medico_id: 'm1', paciente_id: 'p1', instancia_id: 'inst-1' });
  b.instancias.set('inst-1', 'clinica-ficticia');
  b.pacientes.set('p1', { id: 'p1', medico_id: 'm1', nome: 'Paciente Ficticio', cpf_cnpj_encriptado: null });
  b.mensagens.push({ conversa_id: 'conversa-1', payload_bruto: mensagemComprovante() });
  return registrarPerguntaCpf(b.pool as any, { medicoId: 'm1', pacienteId: 'p1',
    comprovanteHash: 'hash-1', comprovanteMensagemId: 'msg-comp-1', valorCentavos: 35000, dataPagamento: '2026-10-18' });
}

describe('registrarPerguntaCpf', () => {
  it('deduplica a mesma pendência sob criação concorrente (trava consultiva + mesma chave)', async () => {
    const b = bancoFalso();
    b.conversas.push({ id: 'conversa-1', medico_id: 'm1', paciente_id: 'p1', instancia_id: 'inst-1' });
    const entrada = { medicoId: 'm1', pacienteId: 'p1', comprovanteHash: 'hash-1',
      comprovanteMensagemId: 'msg-comp-1', valorCentavos: 35000, dataPagamento: '2026-10-18' };
    const [a, c] = await Promise.all([registrarPerguntaCpf(b.pool as any, entrada), registrarPerguntaCpf(b.pool as any, entrada)]);
    expect(b.candidatos).toHaveLength(1);
    expect([a.criado, c.criado].sort()).toEqual([false, true]);
    expect(a.id).toBe(c.id);
    const outra = await registrarPerguntaCpf(b.pool as any, { ...entrada, comprovanteHash: 'hash-2' });
    expect(outra.criado).toBe(true);
    expect(b.candidatos).toHaveLength(2);
  });
});

describe('processarRespostaCpfPaciente', () => {
  it('ignora texto sem pendência vinculada (outra conversa/contexto)', async () => {
    const b = bancoFalso();
    const { deps, enviadas } = depsRetomada(b);
    const r = await processarRespostaCpfPaciente(deps, { medicoId: 'm1', pacienteId: 'p1', texto: `meu cpf é ${CPF}` });
    expect(r).toBe('ignorada');
    expect(b.candidatos).toHaveLength(0);
    expect(enviadas).toHaveLength(0);
  });
  it('ignora CPF inválido sem tocar na pendência', async () => {
    const b = bancoFalso(); await semearPendencia(b);
    const { deps } = depsRetomada(b);
    const r = await processarRespostaCpfPaciente(deps, { medicoId: 'm1', pacienteId: 'p1', texto: 'meu cpf é 123.456.789-00' });
    expect(r).toBe('ignorada');
    expect(b.candidatos[0].status).toBe('aguardando_cpf');
  });
  it('duas pendências: resposta é ambígua, nada é consumido nem confirmado', async () => {
    const b = bancoFalso(); await semearPendencia(b);
    await registrarPerguntaCpf(b.pool as any, { medicoId: 'm1', pacienteId: 'p1', comprovanteHash: 'hash-2',
      comprovanteMensagemId: 'msg-comp-2', valorCentavos: 35000, dataPagamento: '2026-10-18' });
    const { deps, enviadas } = depsRetomada(b);
    const r = await processarRespostaCpfPaciente(deps, { medicoId: 'm1', pacienteId: 'p1', texto: `CPF ${CPF}` });
    expect(r).toBe('ambigua');
    expect(b.candidatos.every(c => c.status === 'aguardando_cpf')).toBe(true);
    expect(enviadas.some(e => e.chave === 'cpf_ambiguo:p1')).toBe(true);
  });
  it('consome uma única vez sob resposta/replay simultâneos; replay cai fora', async () => {
    const b = bancoFalso(); await semearPendencia(b);
    const { deps, enviadas } = depsRetomada(b);
    const [a, r2] = await Promise.all([
      processarRespostaCpfPaciente(deps, { medicoId: 'm1', pacienteId: 'p1', texto: `CPF ${CPF}` }),
      processarRespostaCpfPaciente(deps, { medicoId: 'm1', pacienteId: 'p1', texto: `CPF ${CPF}` })]);
    expect([a, r2].sort()).toEqual(['consumida', 'replay']);
    expect(b.candidatos[0].status).toBe('cpf_recebido');
    // replay tardio (webhook reenviado depois do consumo): ignorado
    const tardio = await processarRespostaCpfPaciente(deps, { medicoId: 'm1', pacienteId: 'p1', texto: `CPF ${CPF}` });
    expect(tardio).toBe('ignorada');
    const conferencia = enviadas.filter(e => e.chave.startsWith('confirma_cpf:'));
    expect(conferencia).toHaveLength(1);
    expect(conferencia[0].fala[0]).toContain('***.***.247-25');
    expect(conferencia[0].fala[0]).not.toContain(CPF.slice(0, 5));
    expect(b.candidatos[0].mensagem_id).toBe('msg-conf-1');
  });
});

describe('processarRespostaMedicoCpf', () => {
  async function ateConferencia() {
    const b = bancoFalso(); await semearPendencia(b);
    const tudo = depsRetomada(b);
    await processarRespostaCpfPaciente(tudo.deps, { medicoId: 'm1', pacienteId: 'p1', texto: `CPF ${CPF}` });
    return { b, ...tudo };
  }
  it('SIM sem vínculo de pergunta não confirma nada', async () => {
    const { b, deps, enfileirar } = await ateConferencia();
    const r = await processarRespostaMedicoCpf(deps, { medicoId: 'm1', texto: 'SIM' });
    expect(r).toBe('ignorada');
    expect(b.candidatos[0].status).toBe('cpf_recebido');
    const r2 = await processarRespostaMedicoCpf(deps, { medicoId: 'm1', chavePergunta: 'outra-mensagem', texto: 'SIM' });
    expect(r2).toBe('ignorada');
    expect(enfileirar).not.toHaveBeenCalled();
    expect(b.pacientes.get('p1').cpf_cnpj_encriptado).toBeNull();
  });
  it('NÃO vinculado recusa: nada é cadastrado nem retomado', async () => {
    const { b, deps, enfileirar, enviadas } = await ateConferencia();
    const r = await processarRespostaMedicoCpf(deps, { medicoId: 'm1', chavePergunta: 'msg-conf-1', texto: 'não, tá errado' });
    expect(r).toBe('consumida');
    expect(b.candidatos[0].status).toBe('recusado');
    expect(b.pacientes.get('p1').cpf_cnpj_encriptado).toBeNull();
    expect(enfileirar).not.toHaveBeenCalled();
    expect(enviadas.some(e => e.chave.startsWith('cpf_recusado:'))).toBe(true);
  });
  it('SIM vinculado: cadastra só campo vazio e retoma até o enfileiramento', async () => {
    const { b, deps, enfileirar, aposEnfileirar, extrator } = await ateConferencia();
    const r = await processarRespostaMedicoCpf(deps, { medicoId: 'm1', chavePergunta: 'msg-conf-1', texto: 'SIM' });
    expect(r).toBe('consumida');
    expect(b.pacientes.get('p1').cpf_cnpj_encriptado).toBe(`enc:${CPF}`);
    expect(extrator.extrair).toHaveBeenCalledTimes(1);
    expect(b.auditorias).toHaveLength(1);
    expect(enfileirar).toHaveBeenCalledTimes(1);
    expect(b.candidatos[0].status).toBe('retomado');
    expect(b.candidatos[0].solicitacao_id).toBe('sol-1');
    expect(aposEnfileirar).toHaveBeenCalledWith('m1', expect.objectContaining({ solicitacaoId: 'sol-1' }));
  });
  it('crash após confirmado: re-drive não duplica nem abandona (retoma da reserva existente)', async () => {
    const { b, deps, enfileirar, aposEnfileirar } = await ateConferencia();
    await processarRespostaMedicoCpf(deps, { medicoId: 'm1', chavePergunta: 'msg-conf-1', texto: 'SIM' });
    expect(b.candidatos[0].status).toBe('retomado');
    // Simula crash: status volta a 'confirmado'; reserva já existe no livro de emissões.
    b.candidatos[0].status = 'confirmado';
    b.emissoes.push({ medico_id: 'm1', comprovante_chave: chaveComprovante('pepper-ficticio', lido()), estado: 'enfileirada', solicitacao_id: 'sol-1' });
    enfileirar.mockResolvedValue({ tipo: 'nenhuma' } as any); // anti-duplicata do enfileirar real
    const r = await processarRespostaMedicoCpf(deps, { medicoId: 'm1', chavePergunta: 'msg-conf-1', texto: 'SIM' });
    expect(r).toBe('consumida');
    expect(b.candidatos[0].status).toBe('retomado');
    expect(b.candidatos[0].solicitacao_id).toBe('sol-1');
    expect(aposEnfileirar).toHaveBeenCalledTimes(2);
    expect(b.candidatos[0].status).not.toBe('condicoes_mudaram');
    // cpf já cadastrado não é sobrescrito
    expect(b.pacientes.get('p1').cpf_cnpj_encriptado).toBe(`enc:${CPF}`);
  });
  it('mídia morta: para sem emitir, com aviso e estado recuperável', async () => {
    const b = bancoFalso(); await semearPendencia(b);
    b.mensagens.length = 0; // Evolution não tem mais a mídia nem a mensagem
    const { deps, enfileirar, enviadas } = depsRetomada(b);
    await processarRespostaCpfPaciente(deps, { medicoId: 'm1', pacienteId: 'p1', texto: `CPF ${CPF}` });
    const r = await processarRespostaMedicoCpf(deps, { medicoId: 'm1', chavePergunta: 'msg-conf-1', texto: 'SIM' });
    expect(r).toBe('consumida');
    expect(b.candidatos[0].status).toBe('midia_indisponivel');
    expect(enfileirar).not.toHaveBeenCalled();
    expect(b.auditorias).toHaveLength(0);
    expect(enviadas.some(e => e.chave.startsWith('midia_indisponivel:') && e.fala[0].includes('reenviar'))).toBe(true);
  });
  it('condições mudaram (cadastro divergente): para sem emitir', async () => {
    const b = bancoFalso(); await semearPendencia(b);
    const tudo = depsRetomada(b, { lerEstado: async (medicoId: string) =>
      ({ medicoId, paciente: { nome: 'Paciente Ficticio', cpf: CPF }, ultimaConsulta: { valorConsultaCentavos: 99000 } } as any) });
    await processarRespostaCpfPaciente(tudo.deps, { medicoId: 'm1', pacienteId: 'p1', texto: `CPF ${CPF}` });
    const r = await processarRespostaMedicoCpf(tudo.deps, { medicoId: 'm1', chavePergunta: 'msg-conf-1', texto: 'SIM' });
    expect(r).toBe('consumida');
    expect(b.candidatos[0].status).toBe('condicoes_mudaram');
    expect(tudo.enfileirar).not.toHaveBeenCalled();
  });
});
