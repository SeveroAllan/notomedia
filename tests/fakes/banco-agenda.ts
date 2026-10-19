/** Fronteira falsa restrita ao upsert e à leitura do ciclo, sem executar SQL. */
export class BancoAgendaFalso {
  consultas = new Map<string, Record<string, any>>();
  pacientes = new Map<string, { nome: string; cpf: string }>();
  chamadas: Array<{ sql: string; parametros: any[] }> = [];
  async query(texto: string, parametros: any[]) {
    const sql = texto.replace(/\s+/g, ' ').trim().toLowerCase(); this.chamadas.push({ sql, parametros: structuredClone(parametros) });
    if (sql.startsWith('insert into public.noto_consultas_sincronizadas')) {
      const [medico, fonte, json] = parametros; const lote = JSON.parse(json);
      const chaves = lote.map((c: any) => JSON.stringify([medico, fonte, c.id_externo]));
      if (new Set(chaves).size !== chaves.length) throw new Error('LOTE_COM_CHAVE_REPETIDA');
      for (const consulta of lote) this.consultas.set(JSON.stringify([medico, fonte, consulta.id_externo]), { medico_id: medico, fonte, ...consulta });
      return { rows: [] };
    }
    if (sql.includes('from pacientes p')) {
      if (sql.includes('noto_consultas_sincronizadas')) throw new Error('LEITURA_PERSISTIDA_PROIBIDA');
      const [medico, paciente] = parametros;
      const cadastro = this.pacientes.get(JSON.stringify([medico, paciente]));
      return { rows: cadastro ? [{ ...cadastro }] : [] };
    }
    throw new Error('QUERY_FORA_DO_CONTRATO_AGENDA');
  }
}
