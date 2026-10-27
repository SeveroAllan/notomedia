import { decidirConversa, type ModeloAssistente } from './conversa.js';
import type { PostgresAssistente, TipoTrabalho } from './postgres-assistente.js';

export interface DependenciasWorkerAssistente {
  repositorio: Pick<PostgresAssistente, 'reservar' | 'contexto' | 'concluirConversa' | 'medicosPermitidos' |
    'concluirPreparacao' | 'destinoPermitido' | 'confirmarEnvio' | 'falhar'>;
  modelo: ModeloAssistente;
  consultarPreparacao: (medicoId: string) => Promise<unknown>;
  enviar: (telefone: string, texto: string) => Promise<{ sucesso: boolean; mensagemId?: string }>;
  registrarFalha: (trabalhoId: string, tipo: TipoTrabalho) => void;
}

export async function executarPassoAssistente(tipo: TipoTrabalho, deps: DependenciasWorkerAssistente): Promise<boolean> {
  const trabalho = await deps.repositorio.reservar(tipo);
  if (!trabalho) return false;
  try {
    if (tipo === 'conversa') {
      const contexto = await deps.repositorio.contexto(trabalho);
      const decisao = await decidirConversa(contexto, deps.modelo);
      await deps.repositorio.concluirConversa(trabalho, decisao, contexto.medicos.map(m => m.id));
      return true;
    }
    if (tipo === 'preparacao') {
      const medicos = await deps.repositorio.medicosPermitidos(trabalho);
      if (!trabalho.medico_id || !medicos.some(m => m.id === trabalho.medico_id)) throw Error('MEDICO_NAO_PERMITIDO');
      const resultado = await deps.consultarPreparacao(trabalho.medico_id);
      // Uma revogação durante a consulta impede publicar seu resultado.
      const atuais = await deps.repositorio.medicosPermitidos(trabalho);
      if (!atuais.some(m => m.id === trabalho.medico_id)) throw Error('MEDICO_NAO_PERMITIDO');
      await deps.repositorio.concluirPreparacao(trabalho, resultado);
      return true;
    }
    if (!await deps.repositorio.destinoPermitido(trabalho)) throw Error('DESTINO_NAO_PERMITIDO');
    const envio = await deps.enviar(trabalho.conteudo.telefone, trabalho.conteudo.texto!);
    if (!envio.sucesso || !envio.mensagemId) throw Error('ENVIO_NAO_CONFIRMADO');
    await deps.repositorio.confirmarEnvio(trabalho, envio.mensagemId);
    return true;
  } catch {
    deps.registrarFalha(trabalho.id, tipo);
    // Envio já foi marcado incerto antes do efeito externo. Nunca repetir às cegas.
    if (tipo !== 'envio') await deps.repositorio.falhar(trabalho);
    return true;
  }
}
