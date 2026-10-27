import { decidirConversa, type ModeloAssistente } from './conversa.js';
import type { PostgresAssistente, TipoTrabalho } from './postgres-assistente.js';
import { diagnosticarFalhaAssistente, type DiagnosticoAssistente, type EtapaAssistente } from './diagnostico.js';

export interface DependenciasWorkerAssistente {
  repositorio: Pick<PostgresAssistente, 'reservar' | 'contexto' | 'concluirConversa' | 'medicosPermitidos' |
    'concluirPreparacao' | 'destinoPermitido' | 'confirmarEnvio' | 'falhar' | 'registrarDiagnosticoEnvio'>;
  modelo: ModeloAssistente;
  consultarPreparacao: (medicoId: string) => Promise<unknown>;
  enviar: (telefone: string, texto: string) => Promise<{ sucesso: boolean; mensagemId?: string }>;
  registrarFalha: (trabalhoId: string, tipo: TipoTrabalho, diagnostico: DiagnosticoAssistente) => void;
}

export async function executarPassoAssistente(tipo: TipoTrabalho, deps: DependenciasWorkerAssistente): Promise<boolean> {
  const trabalho = await deps.repositorio.reservar(tipo);
  if (!trabalho) return false;
  let etapa: EtapaAssistente = 'carregar_contexto';
  try {
    if (tipo === 'conversa') {
      const contexto = await deps.repositorio.contexto(trabalho);
      etapa = 'decidir_conversa';
      const decisao = await decidirConversa(contexto, deps.modelo);
      etapa = 'salvar_conversa';
      await deps.repositorio.concluirConversa(trabalho, decisao, contexto.medicos.map(m => m.id));
      return true;
    }
    if (tipo === 'preparacao') {
      etapa = 'verificar_permissoes';
      const medicos = await deps.repositorio.medicosPermitidos(trabalho);
      if (!trabalho.medico_id || !medicos.some(m => m.id === trabalho.medico_id)) throw Error('MEDICO_NAO_PERMITIDO');
      etapa = 'consultar_preparacao';
      const resultado = await deps.consultarPreparacao(trabalho.medico_id);
      // Uma revogação durante a consulta impede publicar seu resultado.
      etapa = 'revalidar_permissoes';
      const atuais = await deps.repositorio.medicosPermitidos(trabalho);
      if (!atuais.some(m => m.id === trabalho.medico_id)) throw Error('MEDICO_NAO_PERMITIDO');
      etapa = 'salvar_preparacao';
      await deps.repositorio.concluirPreparacao(trabalho, resultado);
      return true;
    }
    etapa = 'verificar_destino';
    if (!await deps.repositorio.destinoPermitido(trabalho)) throw Error('DESTINO_NAO_PERMITIDO');
    etapa = 'enviar_mensagem';
    const envio = await deps.enviar(trabalho.conteudo.telefone, trabalho.conteudo.texto!);
    if (!envio.sucesso || !envio.mensagemId) throw Error('ENVIO_NAO_CONFIRMADO');
    etapa = 'confirmar_envio';
    await deps.repositorio.confirmarEnvio(trabalho, envio.mensagemId);
    return true;
  } catch (erro) {
    const diagnostico = diagnosticarFalhaAssistente(erro, etapa);
    deps.registrarFalha(trabalho.id, tipo, diagnostico);
    // Envio já foi marcado incerto antes do efeito externo. Nunca repetir às cegas.
    try {
      if (tipo === 'envio') await deps.repositorio.registrarDiagnosticoEnvio(trabalho, diagnostico);
      else await deps.repositorio.falhar(trabalho, diagnostico);
    } catch (erroRegistro) {
      deps.registrarFalha(trabalho.id, tipo, diagnosticarFalhaAssistente(erroRegistro, 'registrar_falha'));
    }
    return true;
  }
}
