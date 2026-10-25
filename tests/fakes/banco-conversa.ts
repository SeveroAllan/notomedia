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
    const mensagens = this.mensagens.filter(m => m.medico === medico && (m.conversa === conversa || sql.includes("mensagem_id like 'noto:agenda:%'") && m.papel === 'noto' && (m.mensagemId === 'noto:boas_vindas:unica' || m.mensagemId.startsWith('noto:agenda:')))).filter(m => !sql.includes("mensagem_id not like 'contexto:%'") || !m.mensagemId.startsWith('contexto:'));
    if (sql.startsWith('with mensagens_removidas as')) {
      this.mensagens = this.mensagens.filter(m => m.medico !== medico);
      for (const chaveResumo of this.resumos.keys()) if (JSON.parse(chaveResumo)[0] === medico) this.resumos.delete(chaveResumo);
      return { rows: [] };
    }
    if (sql.startsWith('insert into conversa_mensagens')) {
      const existente = this.mensagens.find(m => m.medico === medico && m.mensagemId === terceiro);
      if (existente) {
        if (sql.includes("do update set conversa=excluded.conversa,texto=excluded.texto,papel='noto'")) {
          existente.conversa=conversa;existente.texto=quarto;existente.papel='noto';
        } else if (sql.includes('do update set texto=excluded.texto, papel=excluded.papel')) {
          existente.texto = quarto; existente.papel = papel;
        }
        return { rows: [] };
      }
      this.mensagens.push({ id: String(this.mensagens.length + 1), medico, conversa, mensagemId: terceiro, texto: quarto, papel });
      return { rows: [{ id: String(this.mensagens.length) }] };
    }
    if (sql.startsWith('select 1 from conversa_mensagens')) return { rows: this.mensagens.filter(m => m.medico === medico && m.mensagemId === terceiro).map(() => ({ existe: 1 })) };
    if (sql.includes("criada_em > now() - interval '10 minutes'")) return { rows: mensagens.filter(m => m.papel === 'noto').reverse().map(m => ({ texto: m.texto })) };
    if (sql.includes("and papel='noto'") && sql.includes("order by id desc limit")) return { rows: mensagens.filter(m => m.papel === 'noto').slice(sql.endsWith('limit 6') ? -6 : -1).reverse().map(m => ({ texto: m.texto })) };
    if(sql.includes("mensagem_id like 'contexto:entrega_nota:%'"))return {rows:this.mensagens.filter(m=>m.medico===medico&&m.conversa===conversa&&m.mensagemId.startsWith('contexto:entrega_nota:')).slice(-8).reverse().map(m=>({texto:m.texto}))};
    if(sql.includes("mensagem_id like 'contexto:entrega_nota:%'"))return {rows:this.mensagens.filter(m=>m.medico===medico&&m.conversa===conversa&&m.mensagemId.startsWith('contexto:entrega_nota:')).slice(-8).reverse().map(m=>({texto:m.texto}))};
    if(sql.includes("mensagem_id like 'contexto:selecao:%'"))return {rows:mensagens.filter(m=>m.mensagemId.startsWith('contexto:selecao:')).slice(-1).map(m=>({texto:m.texto}))};
    if(sql.includes('mensagem_id=$3 limit 1')) return {rows:mensagens.filter(m=>m.mensagemId===terceiro).slice(-1).map(m=>({texto:m.texto}))};
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
