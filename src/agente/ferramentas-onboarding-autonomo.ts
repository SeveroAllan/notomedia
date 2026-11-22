/**
 * Composição das ferramentas autônomas do agente Noto no WhatsApp:
 * une os módulos especializados de links/diagnóstico de onboarding,
 * rotina/memória e emissão fiscal autônoma sem concentrar regras no mesmo arquivo.
 */

import type { tool } from '@openai/agents';
import type { CodigoFerramenta, FerramentaNoto } from './diagnostico.js';
import {
  criarFerramentasLinksOnboarding,
  type DependenciasLinksOnboarding
} from './ferramentas-links-onboarding.js';
import {
  criarFerramentasRotinaEMemoria,
  type DependenciasRotinaEMemoria
} from './ferramentas-rotina-e-memoria.js';
import {
  criarFerramentasEmissaoAutonoma,
  type DependenciasEmissaoAutonoma
} from './ferramentas-emissao-autonomo.js';

export interface DependenciasOnboardingAutonomo
  extends DependenciasLinksOnboarding,
    DependenciasRotinaEMemoria,
    DependenciasEmissaoAutonoma {}

export function criarFerramentasOnboardingAutonomo(
  deps: DependenciasOnboardingAutonomo,
  registrar: (nome: FerramentaNoto, codigo: CodigoFerramenta, inicio: number) => void,
  textoMensagemAtual?: string
): ReturnType<typeof tool>[] {
  return [
    ...criarFerramentasLinksOnboarding(deps, registrar),
    ...criarFerramentasRotinaEMemoria(deps, registrar, textoMensagemAtual),
    ...criarFerramentasEmissaoAutonoma(deps, registrar)
  ];
}
