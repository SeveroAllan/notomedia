// Pós-enfileiramento compartilhado entre o fluxo direto do comprovante e a retomada após
// conferência de CPF. Re-drive (crash entre etapas) não pode duplicar notificação nem
// reabrir/corromper gates: pergunta já enviada não é reenviada nem regravada, e solicitação
// já liberada por preferência não volta a perguntar.
export interface AposEnfileirarDeps {
  permissoes?: {
    permite(medicoId: string, permissao: string): Promise<boolean>;
    ler(medicoId: string, permissao: string): Promise<unknown>;
    linkJaCriado(medicoId: string, permissao: string): Promise<boolean>;
    criarLink(medicoId: string, permissao: string): Promise<unknown>;
  };
  emissao: {
    liberarPorPreferencia(medicoId: string, solicitacaoId: string, agora: Date): Promise<boolean>;
    buscarConfirmacoes(medicoId: string): Promise<Array<{ id: string; confirmacao: any }>>;
    registrarPergunta(medicoId: string, solicitacaoId: string, resultado: string, chaveMensagem: string | undefined, agora: Date): Promise<unknown>;
  } | null;
  comunicacao: {
    conversa(entrada: { medicoId: string; chave: string; fala: string[] }): Promise<unknown>;
    confirmarEmissao(entrada: { medicoId: string; solicitacaoId: string; paciente: string; dataEnvioPagamento: string; dataConsulta: string }):
      Promise<{ resultado: string; chaveMensagem?: string }>;
  };
  log?: (mensagem: string) => void;
}

export async function aposEnfileirarComprovante(deps: AposEnfileirarDeps, medicoId: string, solicitacaoId: string | null | undefined): Promise<void> {
  if (!deps.emissao || !solicitacaoId) return;
  const log = deps.log ?? (() => {});
  // Permissão emitir_autonomo='autonomo' gravada: libera sem pergunta, com auditoria.
  const autonomo = deps.permissoes ? await deps.permissoes.permite(medicoId, 'emitir_autonomo').catch(() => false) : false;
  if (autonomo && await deps.emissao.liberarPorPreferencia(medicoId, solicitacaoId, new Date())) {
    await deps.comunicacao.conversa({ medicoId, chave: `emissao_autonoma:${solicitacaoId}`,
      fala: ['Comprovante conferido com a sua agenda. Estou emitindo a nota agora, como você preferiu, e te aviso quando terminar.'] });
    return;
  }
  const pendentes = await deps.emissao.buscarConfirmacoes(medicoId);
  const c = pendentes.find(p => p.id === solicitacaoId)?.confirmacao;
  if (autonomo && !pendentes.some(p => p.id === solicitacaoId)) {
    // Re-drive: liberarPorPreferencia falhou porque a solicitação JÁ está liberada.
    // Não reabrir pergunta nem tocar na auditoria.
    return;
  }
  if (c?.dataEnvioPagamento && c?.dataConsulta && c?.paciente && c?.envio !== 'enviado') {
    // envio==='enviado' = pergunta já registrada: re-drive não reenvia nem regrava
    // (registrarPergunta sobrescreveria envio/perguntaChave com 'repetido').
    const envio = await deps.comunicacao.confirmarEmissao({ medicoId, solicitacaoId,
      paciente: c.paciente, dataEnvioPagamento: c.dataEnvioPagamento, dataConsulta: c.dataConsulta });
    if (envio.resultado !== 'repetido') await deps.emissao.registrarPergunta(medicoId, solicitacaoId, envio.resultado, envio.chaveMensagem, new Date());
  }
  // Sem escolha e sem link anterior: oferece a escolha UMA vez, junto da pergunta normal.
  if (deps.permissoes
    && !await deps.permissoes.ler(medicoId, 'emitir_autonomo').catch(() => ({ valor: 'erro' }) as any)
    && !await deps.permissoes.linkJaCriado(medicoId, 'emitir_autonomo').catch(() => true)) {
    const link = await deps.permissoes.criarLink(medicoId, 'emitir_autonomo').catch(() => null);
    if (link && typeof link === 'object' && 'url' in link) await deps.comunicacao.conversa({ medicoId, chave: 'link_permissoes:emitir_autonomo:primeiro',
      fala: ['Nas próximas, posso emitir sozinho quando o comprovante bater com a agenda, sem perguntar a cada nota. Se quiser, escolha aqui:', (link as { url: string }).url] });
  }
  log('Solicitação de comprovante aguardando confirmação do médico.');
}
