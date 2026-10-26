import { readFileSync } from 'node:fs';

/** Fake limitado às tabelas/queries deste adaptador; query desconhecida falha. */
export class BancoHistoricoFalso {
  historicos = new Map<string, Record<string, any>>();
  tentativas = new Map<string, Record<string, any>>();
  comprovantes: Array<Record<string, any>> = [];
  reservas = new Map<string, Record<string, any>>();
  envios = new Map<string, Record<string, any>>();
  falhar: RegExp | null = null;
  consultas: string[] = [];
  private fila = Promise.resolve();
  async connect() {
    const anterior = this.fila; let liberar!: () => void;
    this.fila = new Promise<void>(resolve => { liberar = resolve; }); await anterior;
    let snapshot: any;
    return { release: liberar, query: async (texto: string, params: any[] = []): Promise<{ rows: any[] }> => {
      const sql = texto.replace(/\s+/g, ' ').trim().toLowerCase(); this.consultas.push(sql);
      if (/\bpublic\.auditoria\b/.test(sql)) throw new Error('AUDITORIA_GENERICA_PROIBIDA');
      if (this.falhar?.test(sql)) throw new Error('BANCO_FALSO_FALHOU_DADO_PRIVADO');
      const [medico, modo] = params; const chave = JSON.stringify([medico, modo]);
      if (sql === 'begin') { snapshot = structuredClone([this.historicos, this.tentativas, this.comprovantes, this.reservas, this.envios]); return { rows: [] }; }
      if (sql === 'rollback') { [this.historicos, this.tentativas, this.comprovantes, this.reservas, this.envios] = snapshot; return { rows: [] }; }
      if (sql === 'commit' || sql.includes('pg_advisory_xact_lock')) return { rows: [] };
      if (sql.startsWith('insert into public.noto_historico_comunicacao_medico')) {
        if (!this.historicos.has(chave)) this.historicos.set(chave, { medico_id: medico, modo, boas_vindas_em: null,
          pergunta_nota_em: null, pergunta_nota_repeticoes: 0, resposta_nota: null, resposta_recebida_em: null,
          pergunta_agenda_em: '2026-01-01T00:00:00.000Z', pergunta_agenda_repeticoes: 0, problema_fiscal_em: null, problema_fiscal_repeticoes: 0,
          agendas_nao_atendidas: [], consultas_listadas: false, aguardando_comprovante: false });
        return { rows: [] };
      }
      if (sql.startsWith('select * from public.noto_historico_comunicacao_medico')) return { rows: structuredClone([this.historicos.get(chave)]) };
      if (sql.startsWith('update public.noto_historico_comunicacao_medico')) {
        Object.assign(this.historicos.get(chave)!, JSON.parse(params[2])); return { rows: [] };
      }
      if (sql.startsWith('select * from public.noto_comunicacao_tentativas')) return { rows: structuredClone([...this.tentativas.values()].filter(t => t.medico_id === medico && t.modo === modo)) };
      if (sql.startsWith('insert into public.noto_comunicacao_tentativas')) {
        const t = JSON.parse(params[2]);
        const schema = readFileSync('scripts/migrations/20261018-historico-comunicacao-medico.sql', 'utf8');
        if (t.acao !== null && !schema.includes("'" + t.acao + "'")) throw new Error('ACAO_FORA_DO_SQL');
        if ((t.acao === 'reperguntar') !== (t.pergunta !== null) || (t.acao === 'agenda_nao_atendida') !== (t.agenda !== null)) throw new Error('CHECK_SQL');
        const acao = t.acao === 'reperguntar' ? t.acao + ':' + t.pergunta : t.acao === 'agenda_nao_atendida' ? t.acao + ':' + t.agenda.trim().toLowerCase() : t.acao;
        if (acao && acao !== 'nenhuma' && [...this.tentativas.values()].some(a => a.medico_id === medico && a.modo === modo && a.chave_acao === acao && a.chave_processamento !== t.chave_processamento)) throw new Error('UNIQUE_ACAO_SQL');
        this.tentativas.set(JSON.stringify([medico, modo, t.chave_processamento]), { ...t, medico_id: medico, modo, chave_acao: acao }); return { rows: [] };
      }
      if (sql.startsWith('select lido, estado, decisao from public.noto_auditoria_comprovantes')) return { rows: structuredClone(this.comprovantes.filter(c => c.medico_id === medico).map(c => ({ lido: c.lido, estado: c.estado, decisao: c.decisao }))) };
      if (sql.startsWith('insert into public.noto_auditoria_comprovantes')) {
        const lido = params[1] === null ? null : JSON.parse(params[1]); const decisao = JSON.parse(params[3]);
        this.comprovantes.push({ medico_id: medico, lido, estado: JSON.parse(params[2]), decisao,
          motivo: decisao.motivo, confianca: lido?.campos?.confianca ?? null }); return { rows: [] };
      }
      if (sql.startsWith('select chave_processamento from public.noto_comunicacao_reservas')) return { rows: structuredClone(this.reservas.has(chave) ? [this.reservas.get(chave)] : []) };
      if (sql.startsWith('insert into public.noto_comunicacao_reservas')) {
        this.reservas.set(chave, { medico_id: medico, modo, chave_processamento: params[2] }); return { rows: [] };
      }
      if (sql.startsWith('select chave_processamento, tipo, baloes_enviados from public.noto_comunicacao_envios')) return { rows: structuredClone([...this.envios.values()].filter(e => e.medico_id === medico && e.modo === modo)) };
      if (sql.startsWith('insert into public.noto_comunicacao_envios')) {
        for (const envio of JSON.parse(params[1])) {
          const chaveEnvio = JSON.stringify([medico, 'real', envio.chave_processamento]);
          if (!this.tentativas.has(chaveEnvio)) throw new Error('FK_ENVIO_TENTATIVA');
          if ([...this.envios.values()].some(e => e.medico_id === medico && e.tipo === envio.tipo && e.chave_processamento !== envio.chave_processamento)) throw new Error('UNIQUE_ENVIO_TIPO');
          this.envios.set(chaveEnvio, { ...envio, medico_id: medico, modo: 'real' });
        }
        return { rows: [] };
      }
      throw new Error('QUERY_NAO_SUPORTADA_NO_FAKE: ' + sql);
    } };
  }
}
