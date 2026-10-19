import { expect, it } from 'vitest';
import type pg from 'pg';
import { readFileSync } from 'node:fs';
import { auditarComprovante, decidirPedidoComprovante } from '../src/atendimento/comprovante.js';
import { PostgresEmissaoComprovante } from '../src/io/postgres/postgres-emissao-comprovante.js';

const pepper = 'pepper-ficticio';
const consulta = { fonte: 'agenda-falsa', idExterno: 'c1', dataHora: '2026-10-18', valorConsultaCentavos: 20000 };
const paciente = { nome: 'Ana Ficticia', cpf: '52998224725' };
const estado = { medicoId: 'm', paciente, ultimaConsulta: { valorConsultaCentavos: 20000 }, consulta };
const lido = { tipo: 'extraido' as const, campos: { valorCentavos: 20000, dataPagamento: '2026-10-19', nomePagador: 'Ana Ficticia', nomeFavorecido: 'Medica Ficticia', confianca: { valorCentavos: 1, dataPagamento: 1, nomePagador: 1, nomeFavorecido: 1 } } };

// Modelo restrito de transações e unicidades da nova reserva. Integrações externas inexistentes.
function bancoReservas() {
  const reservas: any[] = [], solicitacoes: any[] = [], auditorias: any[] = [], comandos: string[] = [];
  let fila = Promise.resolve();
  let ambiente = 'homologacao';
  const pool = { async connect() {
    const anterior = fila; let soltar!: () => void; fila = new Promise<void>(r => { soltar = r; }); await anterior;
    let snapshot: any;
    return { release: soltar, async query(texto: string, p: any[] = []) {
      const sql = texto.replace(/\s+/g, ' ').trim().toLowerCase(); comandos.push(sql);
      if (sql === 'begin') { snapshot = structuredClone([reservas, solicitacoes]); return { rows: [] }; }
      if (sql === 'rollback') { reservas.splice(0, reservas.length, ...snapshot[0]); solicitacoes.splice(0, solicitacoes.length, ...snapshot[1]); return { rows: [] }; }
      if (sql === 'commit' || sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.includes('from public.noto_auditoria_comprovantes')) return { rows: auditorias.filter(a => a.medico_id === p[0] && a.lido.campos.comprovanteHash === p[1] && a.estado.consultaChave === p[2] && a.decisao.tipo === 'pedido_nota_pronto') };
      if (sql.includes('from pacientes p')) return { rows: p[1] === 'p' ? [paciente] : [] };
      if (sql.includes('from public.noto_emissoes_comprovantes')) return { rows: reservas.filter(r => r.medico_id === p[0] && (r.comprovante_chave === p[1] || r.consulta_chave === p[2])) };
      if (sql.startsWith('select ambiente')) return { rows: [{ ambiente }] };
      if (sql.includes('from medicos m')) return { rows: [{ medico_id: 'm', nome_completo: 'Medica Ficticia', confirmado_pelo_medico: true, ctrib_nac: '040101', cnbs: '123', crm: '123' }] };
      if (sql.startsWith('insert into public.noto_emissoes_comprovantes')) {
        const [medico_id, consulta_chave, comprovante_chave, auditoria_comprovante_id, estado, erro_codigo] = p;
        if (reservas.some(r => r.medico_id === medico_id && (r.consulta_chave === consulta_chave || r.comprovante_chave === comprovante_chave))) throw Error('UNIQUE');
        const r = { id: `r${reservas.length}`, medico_id, consulta_chave, comprovante_chave, auditoria_comprovante_id, estado, erro_codigo }; reservas.push(r); return { rows: [r] };
      }
      if (sql.startsWith('insert into solicitacoes_nota')) { const s = { id: `s${solicitacoes.length}`, paciente_id: p[2], valor: p[3], descricao: p[4] }; solicitacoes.push(s); return { rows: [s] }; }
      if (sql.startsWith('update solicitacoes_nota s set servico_fiscal_id')) return { rows: [] };
      if (sql.startsWith('update public.noto_emissoes_comprovantes set solicitacao_id')) { reservas.find(r => r.id === p[0]).solicitacao_id = p[1]; return { rows: [] }; }
      throw Error(`SQL não modelado: ${sql}`);
    } };
  } } as unknown as pg.Pool;
  function entrada(leitura = lido, c = consulta) {
    const decisao = decidirPedidoComprovante(leitura, { ...estado, consulta: c }, []);
    auditorias.push({ id: `a${auditorias.length}`, medico_id: 'm', ...auditarComprovante(pepper, { ...estado, consulta: c }, leitura, decisao) });
    return { medicoId: 'm', pacienteId: 'p', lido: leitura, decisao, consulta: c };
  }
  return { pool, reservas, solicitacoes, comandos, entrada, setAmbiente: (v: string) => { ambiente = v; } };
}
it.each([false, true])('reprocessamento e corrida com comprovante diferente=%s criam no máximo uma nota por consulta', async diferente => {
  const b = bancoReservas(), repo = new PostgresEmissaoComprovante(b.pool, 'chave-falsa', pepper);
  const primeiro = b.entrada(), segundo = b.entrada(diferente ? { ...lido, campos: { ...lido.campos, dataPagamento: '2026-10-20' } } : lido);
  const resultados = await Promise.all([repo.enfileirar(primeiro), repo.enfileirar(segundo)]);
  expect(resultados.filter(r => r.tipo === 'enfileirada')).toHaveLength(1);
  expect(await repo.enfileirar(primeiro)).toEqual({ tipo: 'nenhuma' });
  expect(b.solicitacoes).toHaveLength(1); expect(b.reservas).toHaveLength(1);
  expect(b.solicitacoes[0].descricao).toContain('18/10/2026');
  expect(b.reservas[0].consulta_chave).toMatch(/^[a-f0-9]{64}$/);
  expect(b.reservas[0].comprovante_chave).toMatch(/^[a-f0-9]{64}$/);
  for (const pii of ['Ana Ficticia', '52998224725', 'c1', 'agenda-falsa']) expect(JSON.stringify(b.reservas)).not.toContain(pii);
  expect(b.comandos.some(c => c.includes('pg_advisory_xact_lock'))).toBe(true);
  expect(b.comandos.some(c => c.includes('noto_consultas_sincronizadas'))).toBe(false);
});
it('mesmo comprovante não enfileira outra consulta e erro nunca se reemite sozinho', async () => {
  const b = bancoReservas(), repo = new PostgresEmissaoComprovante(b.pool, 'chave-falsa', pepper);
  const primeira = b.entrada(); await repo.enfileirar(primeira);
  expect(await repo.enfileirar(b.entrada(lido, { ...consulta, idExterno: 'c2' }))).toEqual({ tipo: 'nenhuma' });
  b.reservas[0].estado = 'erro';
  expect(await repo.enfileirar(primeira)).toEqual({ tipo: 'perguntar_medico', motivo: 'EMISSAO_COMPROVANTE_BLOQUEADA' });
  expect(b.solicitacoes).toHaveLength(1);
});
it('recusa troca de paciente ou de valor após auditoria', async () => {
  const b = bancoReservas(), repo = new PostgresEmissaoComprovante(b.pool, 'chave-falsa', pepper);
  const entrada = b.entrada();
  expect((await repo.enfileirar({ ...entrada, pacienteId: 'outro' })).tipo).toBe('perguntar_medico');
  expect((await repo.enfileirar({ ...entrada, consulta: { ...consulta, valorConsultaCentavos: 30000 } })).tipo).toBe('perguntar_medico');
  expect(b.solicitacoes).toEqual([]);
});
it('nova migração preserva histórico e exige HMAC antes de remover vínculo de consulta', () => {
  const sql = readFileSync('scripts/migrations/20261020-emissao-comprovante-sem-consulta.sql', 'utf8');
  expect(sql).toContain('add column if not exists consulta_chave');
  expect(sql).toContain('drop column if exists consulta_id_externo');
  expect(sql).toContain('drop column if exists fonte');
  expect(sql).toContain('consulta_chave set not null');
  expect(sql).toContain('(medico_id, consulta_chave)');
  expect(sql).toContain("'^[a-f0-9]{64}$'");
  expect(sql).toContain('raise exception');
});

it('produção bloqueia reserva e mudar depois para homologação não libera reemissão automática', async () => {
  const b = bancoReservas(), repo = new PostgresEmissaoComprovante(b.pool, 'chave-falsa', pepper);
  const entrada = b.entrada(); b.setAmbiente('producao');
  expect(await repo.enfileirar(entrada)).toEqual({ tipo: 'perguntar_medico', motivo: 'AMBIENTE_NAO_HOMOLOGACAO' });
  expect(b.reservas[0]).toMatchObject({ estado: 'bloqueada' }); expect(b.solicitacoes).toEqual([]);
  b.setAmbiente('homologacao');
  expect(await repo.enfileirar(entrada)).toEqual({ tipo: 'perguntar_medico', motivo: 'EMISSAO_COMPROVANTE_BLOQUEADA' });
  expect(b.solicitacoes).toEqual([]);
});

it.each([false, true])('fila e worker concorrentes produzem no máximo uma nota com comprovante diferente=%s', async diferente => {
  const { processarItemFila } = await import('../src/worker/processar-item-fila.js');
  const b = bancoReservas(), repo = new PostgresEmissaoComprovante(b.pool, 'chave-falsa', pepper);
  await Promise.all([repo.enfileirar(b.entrada()), repo.enfileirar(b.entrada(diferente ? { ...lido, campos: { ...lido.campos, dataPagamento: '2026-10-20' } } : lido))]);
  expect(b.solicitacoes).toHaveLength(1);
  let notas = 0, transmissoes = 0;
  const deps = {
    emissorDps: { emitir: async () => { transmissoes++; return { sucesso: true as const, chaveAcesso: 'chave-ficticia', ndps: 1, serie: '1', competencia: '2026-10', dataEmissao: new Date('2026-10-19'), valorServicosCentavos: 20000, xmlStoragePath: 'xml', pdfStoragePath: 'pdf' }; } },
    filaRepositorio: {
      iniciarEmissaoComprovante: async () => { if (b.reservas[0].estado !== 'enfileirada') return 'ocupada' as const; b.reservas[0].estado = 'emitindo'; return 'iniciada' as const; },
      registrarSucesso: async () => { if (b.reservas[0].estado !== 'emitindo') throw Error('SEM_RESERVA'); notas++; b.reservas[0].estado = 'nota_gerada'; },
      buscarETravarProximoItem: async () => null, buscarContextoEnvio: async () => null,
      reagendarTentativa: async () => { throw Error('RETENTATIVA_PROIBIDA'); }, marcarFalhaDefinitiva: async () => {}
    },
    enviarPdfDanfse: { enviarPdf: async () => { throw Error('ENVIO_REAL_PROIBIDO'); } },
    notificadorAlertas: { notificarMedicoWhatsApp: async () => { throw Error('ENVIO_REAL_PROIBIDO'); }, notificarDesenvolvedorEmail: async () => {} }
  };
  const item = { id: b.solicitacoes[0].id, medicoId: 'm', pacienteId: 'p', emissaoComprovante: true as const, tentativas: 0, valorServicoCentavos: 20000, xdescServ: 'Consulta fictícia', ctribNac: '040101' };
  await Promise.all([processarItemFila(item, deps), processarItemFila(item, deps)]);
  await processarItemFila(item, deps); await repo.enfileirar(b.entrada());
  expect(transmissoes).toBe(1); expect(notas).toBe(1); expect(b.solicitacoes).toHaveLength(1);
});
