/**
 * Caso de uso dos blocos de memória núcleo (Letta Core Memory Blocks):
 * carrega `perfil_medico`, `estado_vivo_consultorio` (sincronizado ao vivo com
 * o banco) e `pendencias_e_combinados` para injeção no prompt, e permite ao
 * agente editar apenas os blocos sob sua responsabilidade.
 */

import {
  combinarConteudoBloco,
  type MemoriaNucleoPrompt,
  type RotuloBlocoEditavelAgente
} from './blocos-memoria-config.js';
import type { BlocosMemoriaRepositorio } from './blocos-memoria-repositorio.js';

export interface ServicoBlocosMemoria {
  carregarParaPrompt(contaId: string): Promise<MemoriaNucleoPrompt | null>;
  atualizarPeloAgente(
    contaId: string,
    entrada: {
      rotulo: RotuloBlocoEditavelAgente;
      operacao: 'substituir' | 'acrescentar';
      conteudo: string;
    }
  ): Promise<{ ok: boolean; rotulo: RotuloBlocoEditavelAgente; conteudoAtual: string }>;
}

export function criarServicoBlocosMemoria(deps: {
  repositorio: BlocosMemoriaRepositorio;
  obterEstadoVivo?: (contaId: string) => Promise<string>;
}): ServicoBlocosMemoria {
  async function carregarParaPrompt(contaId: string): Promise<MemoriaNucleoPrompt | null> {
    if (!contaId) return null;
    const [blocos, estadoVivoAtual] = await Promise.all([
      deps.repositorio.listarBlocos(contaId).catch(() => []),
      deps.obterEstadoVivo ? deps.obterEstadoVivo(contaId).catch(() => '') : Promise.resolve('')
    ]);

    const perfilMedico = blocos.find(b => b.rotulo === 'perfil_medico')?.conteudo ?? '';
    const pendencias = blocos.find(b => b.rotulo === 'pendencias_e_combinados')?.conteudo ?? '';
    const estadoVivoSalvo = blocos.find(b => b.rotulo === 'estado_vivo_consultorio')?.conteudo ?? '';
    const estadoVivo = estadoVivoAtual || estadoVivoSalvo;

    if (estadoVivoAtual && estadoVivoAtual !== estadoVivoSalvo) {
      void deps.repositorio.salvarBloco({
        contaId,
        rotulo: 'estado_vivo_consultorio',
        conteudo: estadoVivoAtual,
        atualizadoPor: 'sistema'
      }).catch(() => null);
    }

    if (!perfilMedico && !estadoVivo && !pendencias) return null;
    return {
      perfil_medico: perfilMedico,
      estado_vivo_consultorio: estadoVivo,
      pendencias_e_combinados: pendencias
    };
  }

  async function atualizarPeloAgente(
    contaId: string,
    entrada: {
      rotulo: RotuloBlocoEditavelAgente;
      operacao: 'substituir' | 'acrescentar';
      conteudo: string;
    }
  ) {
    const blocos = await deps.repositorio.listarBlocos(contaId);
    const atual = blocos.find(b => b.rotulo === entrada.rotulo)?.conteudo ?? '';
    const combinado = combinarConteudoBloco({
      atual,
      novo: entrada.conteudo,
      operacao: entrada.operacao
    });
    const salvo = await deps.repositorio.salvarBloco({
      contaId,
      rotulo: entrada.rotulo,
      conteudo: combinado,
      atualizadoPor: 'agente'
    });
    return { ok: true, rotulo: entrada.rotulo, conteudoAtual: salvo.conteudo };
  }

  return { carregarParaPrompt, atualizarPeloAgente };
}
