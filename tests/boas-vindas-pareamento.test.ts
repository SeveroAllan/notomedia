import { describe, expect, it, vi } from 'vitest';
import type pg from 'pg';
import { enviarBoasVindasAposPareamento, mensagemBoasVindasPareamento } from '../src/agente/boas-vindas-pareamento.js';

const instancia = 'medico_aaaaaaaaaaaa';
const numero = '5511999990000';

function repositorio(opcoes: {
  conectado?: boolean;
  identificacao?: Array<{ conta_id?: string; nome?: string | null; telefone?: string | null }>;
  contaId?: string;
} = {}) {
  let conectado = opcoes.conectado ?? false;
  const registros = new Map<string, 'reservada' | 'enviada' | 'incerta'>();
  const consultas: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    consultas.push({ sql, params });
    if (/^select w.conta_id, u.nome, u.telefone/.test(sql)) {
      return { rows: conectado ? (opcoes.identificacao ?? [{
        conta_id: opcoes.contaId ?? 'conta-1', telefone: numero, nome: 'Clara Sobrenome'
      }]) : [], rowCount: conectado ? 1 : 0 };
    }
    if (/^insert into noto_boas_vindas_pareamento/.test(sql)) {
      if (!conectado) return { rows: [], rowCount: 0 };
      const conta = String(params[1]);
      if (registros.has(conta)) return { rows: [], rowCount: 0 };
      registros.set(conta, 'reservada');
      return { rows: [{ conta_id: conta }], rowCount: 1 };
    }
    if (/^update noto_boas_vindas_pareamento/.test(sql)) {
      const conta = String(params[0]);
      if (registros.get(conta) === 'reservada') registros.set(conta, String(params[1]) as 'enviada' | 'incerta');
      return { rows: [], rowCount: 1 };
    }
    throw new Error('SQL_NAO_PERMITIDO');
  });
  return { pool: { query } as unknown as pg.Pool, registros, consultas,
    setConectado: (valor: boolean) => { conectado = valor; } };
}

function deps(r: ReturnType<typeof repositorio>, enviar: (telefone: string, texto: string) => Promise<boolean>) {
  return { pool: r.pool, ativo: true, nomeInstancia: instancia, allowlist: [numero], enviar };
}

describe('boas-vindas so apos pareamento real e uma unica tentativa por conta', () => {
  it('nao envia antes de OPEN, mesmo quando chamado por evento duplicado', async () => {
    const r = repositorio();
    const enviar = vi.fn().mockResolvedValue(true);
    await Promise.all([enviarBoasVindasAposPareamento(deps(r, enviar)),
      enviarBoasVindasAposPareamento(deps(r, enviar))]);
    expect(enviar).not.toHaveBeenCalled();
    expect(r.registros.size).toBe(0);
  });

  it('reserva antes do envio, deduplica eventos simultaneos, polls, reconexao e reinicio', async () => {
    const r = repositorio({ conectado: true });
    const enviar = vi.fn(async () => true);
    const op = deps(r, enviar);
    const resultados = await Promise.all(Array.from({ length: 20 }, () => enviarBoasVindasAposPareamento(op)));
    expect(resultados.filter(Boolean)).toHaveLength(1);
    expect(enviar).toHaveBeenCalledExactlyOnceWith(numero, expect.stringContaining('Olá, Clara!'));
    expect(r.registros.get('conta-1')).toBe('enviada');
    r.setConectado(false);
    r.setConectado(true);
    expect(await enviarBoasVindasAposPareamento(op)).toBe(false);
    expect(enviar).toHaveBeenCalledTimes(1);
    // A nova instancia do mesmo titular nao reinicia a saudacao.
    expect(await enviarBoasVindasAposPareamento({ ...op, nomeInstancia: 'medico_outra' })).toBe(false);
    expect(enviar).toHaveBeenCalledTimes(1);
    const sql = r.consultas.map(x => x.sql.toLowerCase()).join(' ');
    expect(sql).toContain('on conflict (conta_id) do nothing');
    expect(sql).not.toMatch(/insert into (notas_fiscais|solicitacoes_nota)/);
    expect(sql).not.toContain('confirmado_pelo_medico = true');
  });

  it('resultado incerto nao gera nova tentativa nem duplica envio', async () => {
    const r = repositorio({ conectado: true });
    const enviar = vi.fn(async () => { throw new Error('FALHA_TRANSITORIA'); });
    const op = deps(r, enviar);
    expect(await enviarBoasVindasAposPareamento(op)).toBe(false);
    expect(r.registros.get('conta-1')).toBe('incerta');
    expect(await enviarBoasVindasAposPareamento(op)).toBe(false);
    expect(enviar).toHaveBeenCalledOnce();
  });

  it('bloqueia destinatario fora da allowlist, conta ambigua e numero desconhecido', async () => {
    const enviar = vi.fn().mockResolvedValue(true);
    const casos = [
      [{ conta_id: 'conta-1', nome: 'Clara', telefone: '5521999990000' }],
      [{ conta_id: 'conta-1', nome: 'Clara', telefone: null }],
      [{ conta_id: 'conta-1', nome: 'Clara', telefone: numero },
        { conta_id: 'conta-2', nome: 'Outra', telefone: numero }],
      []
    ];
    for (const identificacao of casos) {
      const r = repositorio({ conectado: true, identificacao });
      expect(await enviarBoasVindasAposPareamento(deps(r, enviar))).toBe(false);
      expect(r.registros.size).toBe(0);
    }
    const r = repositorio({ conectado: true });
    for (const allowlist of [[], [numero, '5521999990000'], ['5521999990000']]) {
      expect(await enviarBoasVindasAposPareamento({ ...deps(r, enviar), allowlist })).toBe(false);
    }
    expect(enviar).not.toHaveBeenCalled();
  });

  it('sem flags ativas, nao consulta banco nem envia; sem nome verificado, nao inventa saudacao', async () => {
    const r = repositorio({ conectado: true, identificacao: [{
      conta_id: 'conta-1', nome: 'Médico 0000', telefone: numero
    }] });
    const enviar = vi.fn().mockResolvedValue(true);
    expect(await enviarBoasVindasAposPareamento({ ...deps(r, enviar), ativo: false })).toBe(false);
    expect(r.consultas).toHaveLength(0);
    expect(await enviarBoasVindasAposPareamento(deps(r, enviar))).toBe(true);
    expect(enviar.mock.calls[0]?.[1]).toContain('Olá! Sou o Noto.');
    expect(enviar.mock.calls[0]?.[1]).not.toMatch(/Médico 0000|nome do médico|última nota/i);
  });

  it('mensagem nao presume emissao, agenda nem ultima nota e respeita baloes curtos', () => {
    const mensagem = mensagemBoasVindasPareamento(null);
    expect(mensagem).not.toContain('Desde quando você não emite notas?');
    expect(mensagem.split('?').length - 1).toBe(1);
    expect(mensagem).toContain('Qual agenda você usa');
    expect(mensagem).toContain('emissão ainda depende');
    expect(mensagem).not.toMatch(/emiti sua nota|nota foi emitida|sua agenda (está|já está) conectada|última nota/i);
    for (const linha of mensagem.split('\n')) expect(linha.trim().split(/\s+/).length).toBeLessThanOrEqual(15);
  });
});
