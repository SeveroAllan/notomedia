/** Fake das queries de conversa; SQL desconhecido falha, como no BancoHistoricoFalso. */
export class BancoConversaFalso {
  mensagens: Array<{ id: string; medico: string; conversa: string; mensagemId: string; texto: string; papel: string }> = [];
  resumos = new Map<string, { resumo: string; ate_id: string }>();
  consultas: Array<{ sql: string; parametros: unknown[] }> = [];

  async query(texto: string, parametros: any[] = []) {
    const sql = texto.replace(/\s+/g, ' ').trim();
    this.consultas.push({ sql, parametros });
    const [medico, conversa, terceiro, quarto, papel] = parametros;
    const chave = JSON.stringify([medico, conversa]);
    const mensagens = this.mensagens.filter(m => m.medico === medico && m.conversa === conversa);
    if (sql.startsWith('insert into conversa_mensagens')) {
      if (!mensagens.some(m => m.mensagemId === terceiro)) this.mensagens.push({ id: String(this.mensagens.length + 1), medico, conversa, mensagemId: terceiro, texto: quarto, papel });
      return { rows: [] };
    }
    if (sql.startsWith('select 1 from conversa_mensagens')) return { rows: mensagens.filter(m => m.mensagemId === terceiro).map(() => ({ existe: 1 })) };
    if (sql.includes("papel='noto'")) return { rows: mensagens.filter(m => m.papel === 'noto').slice(-1).map(m => ({ texto: m.texto })) };
    if (sql.startsWith('select texto from conversa_mensagens')) return { rows: mensagens.slice(-terceiro).reverse().map(m => ({ texto: m.texto })) };
    if (sql.startsWith('select resumo, ate_id::text')) return { rows: this.resumos.has(chave) ? [this.resumos.get(chave)] : [] };
    if (sql.startsWith('select id::text, texto from')) return { rows: mensagens.slice(0, -quarto).filter(m => BigInt(m.id) > BigInt(terceiro)).map(m => ({ id: m.id, texto: m.texto })) };
    if (sql.startsWith('insert into conversa_resumos')) {
      const anterior = this.resumos.get(chave);
      if (!anterior || BigInt(anterior.ate_id) < BigInt(quarto)) this.resumos.set(chave, { resumo: terceiro, ate_id: quarto });
      return { rows: [] };
    }
    throw Error('QUERY_NAO_SUPORTADA_NO_FAKE: ' + sql);
  }
}
